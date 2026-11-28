// SPDX-License-Identifier: MPL-2.0

/**
 * Reads what an SB3 itself says about the extensions it carries: the pinned SHA-256, which of the
 * four forms the author kept each extension in, how many bytes the archive holds for it, and the
 * project URI that names the work.
 *
 * Nothing here looks at a browser's stored state. An extension cache lives in IndexedDB, which
 * belongs to an origin *and* to a browser profile, so a command line cannot reach the cache the
 * person running it actually has. This side produces the list to compare against; the screen in
 * the browser owns the listing and the deleting.
 *
 * Nothing here is fetched either. A project URI says nothing until its author publishes there, and
 * a work saved but never published looks exactly like a published work whose address rotted. So no
 * URL in an SB3 is contacted, and no absence is ever concluded from a response.
 *
 * The pure parser in `project-extension-manifest` mirrors the Loader's read contract. The Loader owns
 * them, but it is a browser runtime this command never needs, and taking a dependency on it would
 * add nothing an inventory uses: no bytes are resolved, no dependency graph is ordered, nothing is
 * executed. What is reproduced here is only what the report prints — the four source names, the
 * digest form, the embedded path rule, the HTTPS address rule, and the refusal of the retired
 * spellings. A change to any of those on the loader's side is a change to make here too.
 */

import {createHash} from 'node:crypto';
import {lstat, readFile} from 'node:fs/promises';
import path from 'node:path';

import {strFromU8, unzipSync} from 'fflate';

import {validateArchiveEntryName} from './archive';
import {assert} from './assert';
import {decodeExtensionDataUrl} from './import';
import type {UnknownRecord} from './types';

export {
  projectManifestKey,
  extensionSourceTypes,
  readProjectManifest,
} from './project-extension-manifest';
export type {ExtensionExecutionMode, ExtensionSourceType} from './project-extension-manifest';
import {readProjectManifest} from './project-extension-manifest';
import type {
  ExtensionExecutionMode,
  ExtensionSourceType,
  ManifestExtension,
} from './project-extension-manifest';

export interface ExtensionDigestEntry {
  /** The extension ID, which is also how an `embedded-data` carrier is addressed. */
  id: string;
  /** The SHA-256 the manifest pins, lowercase hexadecimal. */
  sha256: string;
  sourceType: ExtensionSourceType;
  /** Bytes the SB3 itself holds for this extension; null when it holds only a reference. */
  size: number | null;
  /** The digest of the bytes the SB3 holds; null when it holds only a reference. */
  heldSha256: string | null;
  /** The recorded address, for either reference form or an embedded source that kept its origin. */
  url: string | null;
  /** The archive entry that carries the bytes, for `embedded-file` only. */
  path: string | null;
  execution: ExtensionExecutionMode;
  /** Whether this form can leave a copy in a browser's cache. */
  cacheable: boolean;
}

export interface Sb3ExtensionDigests {
  inputPath: string;
  /** The project's own claim of its address, which is the cache bucket name. Never fetched. */
  uri: string | null;
  manifestPresent: boolean;
  extensions: ExtensionDigestEntry[];
}

export interface ExtensionDigestUsage {
  sha256: string;
  /** Every extension ID that names these bytes, across the inputs, sorted. */
  ids: string[];
  /** Every form these bytes are kept in, across the inputs, in manifest order. */
  sourceTypes: ExtensionSourceType[];
  /** True when at least one input keeps these bytes as `remote-cacheable`. */
  cacheable: boolean;
  /** Byte length when some input holds the bytes; null when every input holds a reference. */
  size: number | null;
  projects: {inputPath: string; uri: string | null}[];
  /** True when more than one input names these bytes. */
  shared: boolean;
}

export interface ExtensionDigestInventory {
  projects: Sb3ExtensionDigests[];
  /** One record per distinct digest, ordered by digest so two runs read the same way. */
  digests: ExtensionDigestUsage[];
}

const archiveSizeLimit = 64 * 1024 * 1024;
const expandedSizeLimit = 256 * 1024 * 1024;
const archiveEntryLimit = 4096;
function isObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

interface ReadArchiveResult {
  entries: Record<string, Uint8Array>;
  project: UnknownRecord;
}

function parseArchive(contents: Uint8Array): ReadArchiveResult {
  const names = new Set<string>();
  let expandedSize = 0;
  const entries = unzipSync(contents, {
    filter: (entry) => {
      validateArchiveEntryName(entry.name);
      assert(!names.has(entry.name), `Duplicate SB3 archive entry: ${entry.name}`);
      names.add(entry.name);
      expandedSize += entry.originalSize;
      assert(
        names.size <= archiveEntryLimit && expandedSize <= expandedSizeLimit,
        'SB3 expansion limit exceeded.',
      );
      return true;
    },
  });
  assert(Object.hasOwn(entries, 'project.json'), 'SB3 archive does not contain project.json.');
  let project: unknown;
  try {
    project = JSON.parse(strFromU8(entries['project.json']));
  } catch (error) {
    throw new Error('SB3 project.json is not valid JSON.', {cause: error});
  }
  assert(isObject(project), 'SB3 project.json must contain a JSON object.');
  return {entries, project};
}

async function readArchive(filePath: string): Promise<Buffer> {
  assert(path.extname(filePath).toLowerCase() === '.sb3', `Expected an .sb3 file: ${filePath}`);
  const stats = await lstat(filePath);
  assert(stats.isFile() && !stats.isSymbolicLink(), `Expected a regular SB3 file: ${filePath}`);
  assert(stats.size <= archiveSizeLimit, `SB3 exceeds the 64 MiB limit: ${filePath}`);
  return readFile(filePath);
}

function heldBytes(extension: ManifestExtension, archive: ReadArchiveResult): Uint8Array | null {
  if (extension.source.type === 'embedded-file') {
    const entryPath = extension.source.path;
    const entry = archive.entries[entryPath];
    assert(
      entry !== undefined,
      `Extension ${extension.id} names a missing archive entry: ${entryPath}`,
    );
    return entry;
  }
  if (extension.source.type === 'embedded-data') {
    const urls: unknown = archive.project.extensionURLs;
    assert(
      isObject(urls) && typeof urls[extension.id] === 'string',
      `Extension ${extension.id} is missing its embedded data carrier in extensionURLs.`,
    );
    return decodeExtensionDataUrl(urls[extension.id]).source;
  }
  return null;
}

/** Reads one SB3's manifest digests; `embedded-data` sizes come from the decoded carrier. */
export function inspectSb3ExtensionDigests(
  inputPath: string,
  contents: Uint8Array,
): Sb3ExtensionDigests {
  const archive = parseArchive(contents);
  const manifest = readProjectManifest(archive.project);
  if (!manifest) {
    return {inputPath, uri: null, manifestPresent: false, extensions: []};
  }
  const extensions = manifest.extensions.map((extension): ExtensionDigestEntry => {
    const bytes = heldBytes(extension, archive);
    return {
      id: extension.id,
      sha256: extension.sha256,
      sourceType: extension.source.type,
      size: bytes ? bytes.byteLength : null,
      heldSha256: bytes ? sha256(bytes) : null,
      url: extension.source.url,
      path: extension.source.path,
      execution: extension.execution,
      cacheable: extension.source.type === 'remote-cacheable',
    };
  });
  return {inputPath, uri: manifest.uri, manifestPresent: true, extensions};
}

/**
 * Builds the list to compare a browser's extension cache against.
 *
 * Whether a digest is shared is decided by how many of the given SB3s name it, and by nothing
 * else: an input that was not given is simply unknown, never absent. The same goes for
 * `cacheable` — it says that some input given here keeps those bytes as `remote-cacheable`, which
 * is the only form a cache may hold, so a digest left over from a project since converted to
 * `remote-non-cacheable` shows up with `cacheable` false.
 */
export async function inventoryExtensionDigests(
  inputPaths: string[],
): Promise<ExtensionDigestInventory> {
  assert(inputPaths.length > 0, 'At least one INPUT.sb3 is required.');
  const resolvedPaths = inputPaths.map((inputPath) => path.resolve(inputPath));
  const seenPaths = new Set<string>();
  for (const resolvedPath of resolvedPaths) {
    assert(!seenPaths.has(resolvedPath), `Duplicate SB3 input: ${resolvedPath}`);
    seenPaths.add(resolvedPath);
  }

  const projects: Sb3ExtensionDigests[] = [];
  for (const resolvedPath of resolvedPaths) {
    projects.push(inspectSb3ExtensionDigests(resolvedPath, await readArchive(resolvedPath)));
  }

  const usages = new Map<string, ExtensionDigestUsage>();
  for (const project of projects) {
    for (const extension of project.extensions) {
      let usage = usages.get(extension.sha256);
      if (!usage) {
        usage = {
          sha256: extension.sha256,
          ids: [],
          sourceTypes: [],
          cacheable: false,
          size: null,
          projects: [],
          shared: false,
        };
        usages.set(extension.sha256, usage);
      }
      if (!usage.ids.includes(extension.id)) usage.ids.push(extension.id);
      if (!usage.sourceTypes.includes(extension.sourceType)) {
        usage.sourceTypes.push(extension.sourceType);
      }
      usage.cacheable = usage.cacheable || extension.cacheable;
      if (usage.size === null) usage.size = extension.size;
      if (!usage.projects.some((entry) => entry.inputPath === project.inputPath)) {
        usage.projects.push({inputPath: project.inputPath, uri: project.uri});
      }
    }
  }

  const digests = [...usages.values()].sort((left, right) => (left.sha256 < right.sha256 ? -1 : 1));
  for (const usage of digests) {
    usage.ids.sort();
    usage.shared = usage.projects.length > 1;
  }
  return {projects, digests};
}

/** Formats the inventory as the lines the CLI prints, one fact per `key=value` pair. */
export function formatExtensionDigestInventory(inventory: ExtensionDigestInventory): string[] {
  const extensionCount = inventory.projects.reduce(
    (total, project) => total + project.extensions.length,
    0,
  );
  const sharedCount = inventory.digests.filter((usage) => usage.shared).length;
  const lines = [
    `Inventory: ${inventory.projects.length} SB3 inputs; ${extensionCount} manifest extensions; ` +
      `${inventory.digests.length} distinct digests (${sharedCount} shared, ` +
      `${inventory.digests.length - sharedCount} in one project).`,
  ];
  for (const project of inventory.projects) {
    if (!project.manifestPresent) {
      lines.push(`${project.inputPath}: manifest=absent`);
      continue;
    }
    lines.push(
      `${project.inputPath}: uri=${project.uri ?? 'absent'}; ` +
        `extensions=${project.extensions.length}`,
    );
    for (const extension of project.extensions) {
      const details = [
        `sha256=${extension.sha256}`,
        `source=${extension.sourceType}`,
        `size=${extension.size === null ? 'not-held' : extension.size}`,
        `cacheable=${extension.cacheable ? 'yes' : 'no'}`,
        `execution=${extension.execution}`,
      ];
      if (extension.path) details.push(`path=${extension.path}`);
      if (extension.url) details.push(`url=${extension.url}`);
      if (extension.heldSha256 && extension.heldSha256 !== extension.sha256) {
        details.push(`held-sha256=${extension.heldSha256}`);
      }
      lines.push(`  ${extension.id}: ${details.join('; ')}`);
    }
  }
  for (const usage of inventory.digests) {
    lines.push(
      `${usage.shared ? 'Shared' : 'Single'}: ${usage.sha256}; ` +
        `projects=${usage.projects.length}; ids=${usage.ids.join(',')}; ` +
        `sources=${usage.sourceTypes.join(',')}; cacheable=${usage.cacheable ? 'yes' : 'no'}; ` +
        `size=${usage.size === null ? 'not-held' : usage.size}`,
    );
  }
  lines.push(
    'Browser caches are not read: IndexedDB belongs to an origin and a browser profile. ' +
      'No URI above was contacted, and an unresolved URI never means an absent project.',
  );
  return lines;
}
