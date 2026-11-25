// SPDX-License-Identifier: MPL-2.0
import {
  API_MANIFEST,
  DISTRIBUTION_DESCRIPTOR,
  DistributionError,
  EXACT_VERSION,
  NPM_PACKAGE,
  assertDistributionApi,
  parseExtensionDistribution,
  type DistributionArtifact,
  type ExtensionDistribution,
} from '@kubohiroya/turbowarp-extension-manifest/distribution';
import {readPackageResourceDeclaration} from '@kubohiroya/turbowarp-extension-manifest/resources';
import {indexNpmDistribution, readBounded} from './distribution-archive';

const METADATA_BYTES = 256 * 1024;
const API_BYTES = 1024 * 1024;
const BUNDLE_BYTES = 8 * 1024 * 1024;
const TARBALL_BYTES = 16 * 1024 * 1024;
const TAR_BYTES = 48 * 1024 * 1024;
const REGISTRY = 'https://registry.npmjs.org';
const decoder = new TextDecoder('utf-8', {fatal: true});
const RELEASE_URL = /^https:\/\/github\.com\/([\w-]+)\/([\w.-]+)\/releases\/tag\/([\w.+-]+)\/?$/u;

export type PublishedExtensionSource =
  | Readonly<{provider: 'npm'; package: string; version: string; integrity: string}>
  | Readonly<{
      provider: 'github';
      repository: string;
      tag: string;
      commit: string;
      releaseID: number;
      descriptorSHA256: string;
    }>;

export interface PublishedExtension {
  readonly distribution: ExtensionDistribution;
  readonly source: PublishedExtensionSource;
  readonly sourceURL?: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function json(bytes: Uint8Array, limit: number): unknown {
  if (bytes.length > limit)
    throw new DistributionError('SIZE_LIMIT', 'The distribution metadata is too large');
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch (cause) {
    throw new DistributionError('INVALID_JSON', 'Invalid distribution JSON', {cause});
  }
}

async function hash(bytes: Uint8Array<ArrayBuffer>, algorithm: 'SHA-256' | 'SHA-512') {
  return new Uint8Array(await crypto.subtle.digest(algorithm, bytes));
}

async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(await hash(bytes, 'SHA-256'), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function verify(
  bytes: Uint8Array<ArrayBuffer>,
  artifact: DistributionArtifact,
  limit: number,
) {
  if (
    artifact.size > limit ||
    bytes.length !== artifact.size ||
    (await sha256(bytes)) !== artifact.sha256
  ) {
    throw new DistributionError(
      'ARTIFACT_MISMATCH',
      'File size or SHA-256 does not match: ' + artifact.file,
    );
  }
  return bytes;
}

function getAssetDigest(release: Record<string, unknown>, filename: string) {
  const assets = Array.isArray(release.assets) ? release.assets.map(object) : [];
  const matches = assets.filter((asset) => asset.name === filename);
  const digest = matches[0]?.digest;
  if (
    matches.length !== 1 ||
    matches[0]?.state !== 'uploaded' ||
    typeof digest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(digest)
  ) {
    throw new DistributionError(
      'MISSING_RELEASE_ASSET',
      'The release does not provide a unique hashed asset: ' + filename,
    );
  }
  return digest.slice(7);
}

function validateBundle(distribution: ExtensionDistribution, bytes: Uint8Array) {
  // The sample can end mid-character. Keep any unfinished bytes local to this inspection.
  const headerDecoder = new TextDecoder('utf-8', {fatal: true});
  const lines = headerDecoder.decode(bytes.subarray(0, 4096), {stream: true}).split(/\r?\n/u);
  const headers = new Map<string, string>();
  for (const line of lines) {
    if (!/^\/\/ /u.test(line)) break;
    const match = /^\/\/ (Name|ID|License): (.+)$/u.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const value = match[2]!;
    if (headers.has(key))
      throw new DistributionError('BUNDLE_MISMATCH', 'Duplicate TurboWarp bundle metadata');
    headers.set(key, value);
  }
  if (
    headers.get('ID') !== distribution.id ||
    headers.get('Name') !== distribution.name ||
    headers.get('License') !== distribution.license
  ) {
    throw new DistributionError(
      'BUNDLE_MISMATCH',
      'The TurboWarp bundle metadata does not match the distribution',
    );
  }
}

function parseReference(reference: string) {
  const value = reference.trim();
  if (value.length <= 512) {
    const release = RELEASE_URL.exec(value);
    if (
      release &&
      release[2] !== '.' &&
      release[2] !== '..' &&
      EXACT_VERSION.test(release[3]!.replace(/^v/u, ''))
    ) {
      return {
        provider: 'github' as const,
        repository: release[1]! + '/' + release[2]!,
        version: release[3]!,
      };
    }
    const start = value.startsWith('npm:') ? 4 : 0;
    const split = value.lastIndexOf('@');
    const packageName = split > start ? value.slice(start, split) : '';
    const version = value.slice(split + 1);
    if (
      packageName.length <= 214 &&
      version.length <= 128 &&
      NPM_PACKAGE.test(packageName) &&
      EXACT_VERSION.test(version)
    ) {
      return {provider: 'npm' as const, packageName, version};
    }
  }
  throw new DistributionError(
    'INVALID_REFERENCE',
    'Enter an exact npm package version or a GitHub Release tag URL',
  );
}

/** Resolve and verify a published extension without executing any package code. */
export async function resolvePublishedExtension(
  reference: string,
  {fetchImpl = globalThis.fetch, signal}: {fetchImpl?: typeof fetch; signal?: AbortSignal} = {},
): Promise<PublishedExtension> {
  const selected = parseReference(reference);
  const deadline = AbortSignal.timeout(45_000);
  const operation = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const get = async (url: string, limit: number) => {
    try {
      const response = await fetchImpl(url, {
        credentials: 'omit',
        redirect: 'error',
        signal: operation,
      });
      if (!response.ok)
        throw new DistributionError(
          'HTTP_ERROR',
          'Distribution request returned HTTP ' + response.status,
        );
      return await readBounded(response.body, limit);
    } catch (cause) {
      if (cause instanceof DistributionError) throw cause;
      throw new DistributionError('FETCH_FAILED', 'Could not fetch the published distribution', {
        cause,
      });
    }
  };
  const getJSON = async (url: string) =>
    object(json(await get(url, METADATA_BYTES), METADATA_BYTES));
  let distribution: ExtensionDistribution;
  let source: PublishedExtensionSource;
  let sourceURL: string | undefined;
  let bundle: Uint8Array<ArrayBuffer>;
  let api: Uint8Array<ArrayBuffer>;
  if (selected.provider === 'npm') {
    const {packageName, version} = selected;
    const metadata = await getJSON(
      REGISTRY + '/' + encodeURIComponent(packageName) + '/' + encodeURIComponent(version),
    );
    const dist = object(metadata.dist);
    const integrity = dist.integrity;
    const tarball = dist.tarball;
    if (
      metadata.name !== packageName ||
      metadata.version !== version ||
      typeof integrity !== 'string' ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity) ||
      typeof tarball !== 'string'
    ) {
      throw new DistributionError('NPM_METADATA', 'Unexpected npm version metadata');
    }
    let url: URL;
    let path: string;
    try {
      url = new URL(tarball);
      path = decodeURIComponent(url.pathname);
    } catch (cause) {
      throw new DistributionError('NPM_METADATA', 'Invalid npm tarball address', {cause});
    }
    const expectedPath =
      '/' + packageName + '/-/' + packageName.split('/').at(-1) + '-' + version + '.tgz';
    if (
      url.origin !== REGISTRY ||
      path !== expectedPath ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new DistributionError('NPM_METADATA', 'Unexpected npm tarball address');
    }
    const compressed = await get(url.href, TARBALL_BYTES);
    if (
      'sha512-' + btoa(String.fromCharCode(...(await hash(compressed, 'SHA-512')))) !==
      integrity
    ) {
      throw new DistributionError('ARCHIVE_INTEGRITY', 'The npm tarball integrity does not match');
    }
    const tar = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'), {signal: operation});
    const entries = indexNpmDistribution(await readBounded(tar, TAR_BYTES));
    const read = (file: string) => {
      const bytes = entries.get('package/' + file);
      if (!bytes)
        throw new DistributionError('MISSING_ARTIFACT', 'Missing npm distribution file: ' + file);
      return bytes;
    };
    const pkg = object(json(read('package.json'), METADATA_BYTES));
    distribution = parseExtensionDistribution(
      json(read('dist/' + DISTRIBUTION_DESCRIPTOR), METADATA_BYTES),
    );
    if (
      pkg.name !== packageName ||
      pkg.version !== version ||
      distribution.package !== packageName ||
      distribution.version !== version ||
      pkg.license !== distribution.license ||
      JSON.stringify(readPackageResourceDeclaration(pkg)) !== JSON.stringify(distribution.resources)
    ) {
      throw new DistributionError(
        'NPM_METADATA',
        'The npm package and distribution metadata do not agree',
      );
    }
    bundle = read('dist/' + distribution.bundle.file);
    api = read('dist/' + API_MANIFEST);
    source = {provider: 'npm', package: packageName, version, integrity};
  } else {
    const {repository, version: tag} = selected;
    const root = 'https://api.github.com/repos/' + repository;
    const [release, ref] = await Promise.all([
      getJSON(root + '/releases/tags/' + encodeURIComponent(tag)),
      getJSON(root + '/git/ref/tags/' + encodeURIComponent(tag)),
    ]);
    const target = object(ref.object);
    const objectID = /^[a-f0-9]{40}$/u;
    if (
      ref.ref !== 'refs/tags/' + tag ||
      typeof target.sha !== 'string' ||
      !objectID.test(target.sha)
    ) {
      throw new DistributionError('RELEASE_METADATA', 'The GitHub Release tag is invalid');
    }
    const tagged =
      target.type === 'tag'
        ? object((await getJSON(root + '/git/tags/' + target.sha)).object)
        : target;
    const commit = tagged.type === 'commit' ? tagged.sha : null;
    if (
      release.tag_name !== tag ||
      release.draft !== false ||
      typeof release.id !== 'number' ||
      !Number.isSafeInteger(release.id) ||
      typeof commit !== 'string' ||
      !objectID.test(commit)
    ) {
      throw new DistributionError('RELEASE_METADATA', 'The GitHub Release or commit is invalid');
    }
    // Release downloads redirect to a host without CORS. Read the immutable commit and require
    // the digests published for all three release assets to match the bytes served from it.
    const rawRoot = 'https://raw.githubusercontent.com/' + repository + '/' + commit + '/dist/';
    const descriptorSHA256 = getAssetDigest(release, DISTRIBUTION_DESCRIPTOR);
    const descriptorBytes = await get(rawRoot + DISTRIBUTION_DESCRIPTOR, METADATA_BYTES);
    if ((await sha256(descriptorBytes)) !== descriptorSHA256) {
      throw new DistributionError(
        'RELEASE_METADATA',
        'Distribution descriptor does not match the Release asset',
      );
    }
    distribution = parseExtensionDistribution(json(descriptorBytes, METADATA_BYTES));
    if (
      (tag !== distribution.version && tag !== 'v' + distribution.version) ||
      getAssetDigest(release, distribution.bundle.file) !== distribution.bundle.sha256 ||
      getAssetDigest(release, API_MANIFEST) !== distribution.api.sha256
    ) {
      throw new DistributionError(
        'RELEASE_METADATA',
        'Release version or asset digests do not match the distribution',
      );
    }
    if (distribution.bundle.size > BUNDLE_BYTES || distribution.api.size > API_BYTES) {
      throw new DistributionError(
        'SIZE_LIMIT',
        'The GitHub Release exceeds the supported artifact sizes',
      );
    }
    [bundle, api] = await Promise.all([
      get(rawRoot + distribution.bundle.file, distribution.bundle.size),
      get(rawRoot + API_MANIFEST, distribution.api.size),
    ]);
    source = {provider: 'github', repository, tag, commit, releaseID: release.id, descriptorSHA256};
    sourceURL = rawRoot + distribution.bundle.file;
  }
  await Promise.all([
    verify(bundle, distribution.bundle, BUNDLE_BYTES),
    verify(api, distribution.api, API_BYTES),
  ]);
  assertDistributionApi(distribution, json(api, API_BYTES));
  validateBundle(distribution, bundle);
  return Object.freeze({
    distribution,
    source: Object.freeze(source),
    ...(sourceURL ? {sourceURL} : {}),
    bytes: bundle,
  });
}
