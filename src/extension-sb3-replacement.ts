// SPDX-License-Identifier: MPL-2.0

import {createHash} from 'node:crypto';
import {lstat, readFile, realpath} from 'node:fs/promises';
import path from 'node:path';

import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';
import {lt, valid} from 'semver';

import {validateArchiveEntryName} from './archive';
import {assert} from './assert';
import {writeSb3Archive} from './build';
import type {WriteSb3ArchiveOptions, WriteSb3ArchiveResult} from './build';
import {extensionHeaderId} from './extension-dependencies';
import type {FetchImplementation} from './extension-sync';
import {decodeExtensionDataUrl} from './import';
import {fixedZipTimestamp} from './source';
import type {UnknownRecord} from './types';

export const defaultKamishibaiManifestUrl =
  'https://kubohiroya.github.io/turbowarp-kamishibai-samples/stories/tutorial/public-surfaces.json';

export const kamishibaiReplacementIds: readonly string[] = Object.freeze([
  'kubohiroyakamishibai4',
  'kubohiroyakamishibaiauthoring4',
]);

const archiveSizeLimit = 64 * 1024 * 1024;
const expandedSizeLimit = 256 * 1024 * 1024;

export interface ReplaceSb3ExtensionsOptions {
  confirmReplace?: WriteSb3ArchiveOptions['confirmReplace'];
  fetch?: FetchImplementation;
  fromPath?: string;
  inputPath: string;
  outputPath: string;
  yes?: boolean;
}

export interface ReplaceSb3ExtensionsResult extends WriteSb3ArchiveResult {
  extensionIds: string[];
  donor: {source: string; sha256: string; version: string | null};
}

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

async function readArchive(filePath: string): Promise<Buffer> {
  assert(path.extname(filePath).toLowerCase() === '.sb3', `Expected an .sb3 file: ${filePath}`);
  const stats = await lstat(filePath);
  assert(stats.isFile() && !stats.isSymbolicLink(), `Expected a regular SB3 file: ${filePath}`);
  assert(stats.size <= archiveSizeLimit, `SB3 exceeds the 64 MiB limit: ${filePath}`);
  return readFile(filePath);
}

function parseArchive(contents: Uint8Array) {
  const names = new Set<string>();
  let expandedSize = 0;
  const entries = unzipSync(contents, {
    filter: (entry) => {
      validateArchiveEntryName(entry.name);
      assert(!names.has(entry.name), `Duplicate SB3 archive entry: ${entry.name}`);
      assert(!/^(?:0|[1-9][0-9]*)$/u.test(entry.name), 'Integer ZIP entry names are unsupported.');
      names.add(entry.name);
      expandedSize += entry.originalSize;
      assert(
        names.size <= 4096 && expandedSize <= expandedSizeLimit,
        'SB3 expansion limit exceeded.',
      );
      return true;
    },
  });
  assert(Object.hasOwn(entries, 'project.json'), 'SB3 archive does not contain project.json.');
  const project: unknown = JSON.parse(strFromU8(entries['project.json']));
  assert(
    isObject(project) && isObject(project.extensionURLs),
    'SB3 requires an extensionURLs object.',
  );
  return {entries, project, urls: project.extensionURLs};
}

function embeddedSource(urls: UnknownRecord, id: string): Buffer {
  const dataUrl = urls[id];
  assert(
    typeof dataUrl === 'string' && dataUrl.startsWith('data:'),
    `Missing embedded extension: ${id}`,
  );
  const decoded = decodeExtensionDataUrl(dataUrl);
  assert(
    decoded.mediaType === 'text/javascript' || decoded.mediaType === 'application/javascript',
    `Embedded extension must contain JavaScript: ${id}`,
  );
  const source = Buffer.from(decoded.source);
  // Generated Block Script declares its ID in a literal getInfo() result, without a header.
  const literalId = source
    .toString('utf8')
    .match(/getInfo\s*\(\)\s*\{\s*return\s*\{\s*"id"\s*:\s*"([a-z0-9]+)"/u)?.[1];
  const actualId = extensionHeaderId(source) ?? literalId;
  assert(
    actualId === id,
    `Embedded extension ID mismatch: expected ${id}, got ${actualId ?? '(missing)'}.`,
  );
  return source;
}

function runtimeVersion(source: Buffer): string | null {
  const value = source
    .toString('utf8')
    .match(/^\/\/ Version: (.+)\r?$/mu)?.[1]
    ?.trim();
  return value && valid(value) ? value : null;
}

async function download(
  url: string,
  limit: number,
  fetchImplementation: FetchImplementation,
): Promise<Buffer> {
  const response = await fetchImplementation(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    cache: 'no-store',
  });
  assert(response.ok, `Download failed (${response.status}): ${url}`);
  assert(response.body, `Empty download: ${url}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      assert(size <= limit, `Download exceeds the size limit: ${url}`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function publishedDonor(fetchImplementation: FetchImplementation) {
  const manifest: unknown = JSON.parse(
    (await download(defaultKamishibaiManifestUrl, 1024 * 1024, fetchImplementation)).toString(
      'utf8',
    ),
  );
  assert(isObject(manifest), 'Invalid Kamishibai public surfaces manifest.');
  assert(
    manifest.formatVersion === 1 && manifest.status === 'published' && manifest.published === true,
    'Kamishibai donor must be a published format 1 release.',
  );
  assert(
    typeof manifest.version === 'string' && valid(manifest.version),
    'Invalid published version.',
  );
  assert(
    isObject(manifest.runtime) && manifest.runtime.version === manifest.version,
    'Published runtime version mismatch.',
  );
  assert(
    isObject(manifest.surfaces) && typeof manifest.surfaces.sb3BlocksUrl === 'string',
    'Missing published block SB3 URL.',
  );
  assert(
    isObject(manifest.artifacts) && isObject(manifest.artifacts.sb3Blocks),
    'Missing block SB3 artifact.',
  );
  const artifact = manifest.artifacts.sb3Blocks;
  assert(
    typeof artifact.size === 'number' &&
      Number.isSafeInteger(artifact.size) &&
      artifact.size > 0 &&
      artifact.size <= archiveSizeLimit,
    'Invalid block SB3 size.',
  );
  assert(
    typeof artifact.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(artifact.sha256),
    'Invalid block SB3 SHA-256.',
  );
  const url = new URL(manifest.surfaces.sb3BlocksUrl);
  const manifestUrl = new URL(defaultKamishibaiManifestUrl);
  assert(
    url.origin === manifestUrl.origin &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith('/turbowarp-kamishibai-samples/'),
    'Block SB3 URL must remain on the official samples site.',
  );
  const archive = await download(url.href, archiveSizeLimit, fetchImplementation);
  assert(archive.byteLength === artifact.size, 'Downloaded block SB3 size mismatch.');
  assert(sha256(archive) === artifact.sha256, 'Downloaded block SB3 SHA-256 mismatch.');
  return {archive, source: url.href, version: manifest.version};
}

async function assertDistinctOutput(outputPath: string, protectedPaths: string[]): Promise<void> {
  for (const protectedPath of protectedPaths) {
    assert(
      path.resolve(outputPath) !== path.resolve(protectedPath),
      'Output must differ from input and donor SB3 paths.',
    );
    try {
      assert(
        (await realpath(outputPath)) !== (await realpath(protectedPath)),
        'Output must differ from input and donor SB3 paths.',
      );
    } catch (error) {
      if (!isObject(error) || error.code !== 'ENOENT') throw error;
    }
  }
}

/** Replaces the Kamishibai runtime bundle and Block Script without executing donor code. */
export async function replaceSb3Extensions({
  confirmReplace,
  fetch: fetchImplementation = globalThis.fetch,
  fromPath,
  inputPath,
  outputPath,
  yes = false,
}: ReplaceSb3ExtensionsOptions): Promise<ReplaceSb3ExtensionsResult> {
  const protectedPaths = fromPath ? [inputPath, fromPath] : [inputPath];
  await assertDistinctOutput(outputPath, protectedPaths);
  const input = parseArchive(await readArchive(inputPath));
  const extensionIds = kamishibaiReplacementIds.filter((id) => Object.hasOwn(input.urls, id));
  assert(extensionIds.length > 0, 'Input contains no supported Kamishibai embedded extensions.');
  const inputSources = new Map(extensionIds.map((id) => [id, embeddedSource(input.urls, id)]));
  const donor = fromPath
    ? {archive: await readArchive(fromPath), source: path.resolve(fromPath), version: null}
    : await publishedDonor(fetchImplementation);
  const replacement = parseArchive(donor.archive);
  for (const id of extensionIds) embeddedSource(replacement.urls, id);
  const runtimeId = kamishibaiReplacementIds[0];
  const donorRuntime = Object.hasOwn(replacement.urls, runtimeId)
    ? embeddedSource(replacement.urls, runtimeId)
    : null;
  const donorVersion = donor.version ?? (donorRuntime ? runtimeVersion(donorRuntime) : null);
  if (!fromPath && donorVersion) {
    const inputRuntime = inputSources.get(runtimeId);
    const inputVersion = inputRuntime ? runtimeVersion(inputRuntime) : null;
    assert(
      !inputVersion || !lt(donorVersion, inputVersion),
      `Published donor ${donorVersion} is older than input ${inputVersion}. Wait for publication or select an intentional donor with --from.`,
    );
    const declaredVersion = donorRuntime ? runtimeVersion(donorRuntime) : null;
    assert(
      !declaredVersion || declaredVersion === donorVersion,
      'Donor runtime header does not match the published version.',
    );
  }
  for (const id of extensionIds) input.urls[id] = replacement.urls[id];
  input.entries['project.json'] = strToU8(`${JSON.stringify(input.project)}\n`);
  const archive = zipSync(input.entries, {level: 6, mtime: fixedZipTimestamp});
  await assertDistinctOutput(outputPath, protectedPaths);
  const written = await writeSb3Archive({archive, confirmReplace, outputPath, yes});
  return {
    ...written,
    extensionIds,
    donor: {source: donor.source, sha256: sha256(donor.archive), version: donorVersion},
  };
}
