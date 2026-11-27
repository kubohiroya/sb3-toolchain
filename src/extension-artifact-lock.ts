// SPDX-License-Identifier: MPL-2.0

import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import {
  assertDistributionApi,
  parseExtensionDistribution,
  EXACT_VERSION,
  NPM_PACKAGE,
} from '@kubohiroya/turbowarp-extension-manifest/distribution';
import type {ExtensionDistribution} from '@kubohiroya/turbowarp-extension-manifest/distribution';
import {assert} from './assert';
import type {StandardExtensionBuild} from './standard-extension-build';
import type {PublishedExtension, PublishedExtensionSource} from './web-distribution';

export const extensionLocksEntry = 'tw-plus/extension-locks.json';
const hashPattern = /^[a-f0-9]{64}$/u;
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
export const artifactSHA256 = (bytes: Uint8Array) => bytesToHex(sha256(bytes));

/** Observations only; this record never grants execution or development-session permission. */
export type ExtensionArtifactLock = Readonly<{
  formatVersion: 1;
  bundleSHA256: string;
  apiJSON: string;
  provenance:
    | Readonly<{
        kind: 'published';
        source: PublishedExtensionSource;
        distribution: ExtensionDistribution;
      }>
    | Readonly<{kind: 'build'; receipt: StandardExtensionBuild['receipt']}>;
}>;

function object(value: unknown): Record<string, unknown> {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    'Invalid extension lock object',
  );
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[]) {
  assert(
    Object.keys(value).length === allowed.length &&
      allowed.every((key) => Object.hasOwn(value, key)),
    'Unsupported extension lock fields; refusing to discard information',
  );
}

function hash(value: unknown): asserts value is string {
  assert(typeof value === 'string' && hashPattern.test(value), 'Invalid extension lock SHA-256');
}

function repository(value: unknown) {
  assert(typeof value === 'string' && repositoryPattern.test(value), 'Invalid lock repository');
}

/** Validate the persisted form before it can be written back by a newer or older reader. */
export function validateExtensionArtifactLock(
  value: unknown,
  id: string,
  bundle?: Uint8Array,
): asserts value is ExtensionArtifactLock {
  const lock = object(value);
  assert(lock.formatVersion === 1, 'Unsupported extension artifact lock version');
  keys(lock, ['formatVersion', 'bundleSHA256', 'apiJSON', 'provenance']);
  hash(lock.bundleSHA256);
  if (bundle)
    assert(artifactSHA256(bundle) === lock.bundleSHA256, 'Extension artifact lock mismatch');
  assert(
    typeof lock.apiJSON === 'string' && lock.apiJSON.length <= 1024 * 1024,
    'Invalid locked API',
  );
  const apiBytes = new TextEncoder().encode(lock.apiJSON);
  assert(apiBytes.length <= 1024 * 1024, 'Locked API exceeds its size limit');
  const api = object(JSON.parse(lock.apiJSON));
  assert(
    api.id === id && [1, 2].includes(api.formatVersion as number) && Array.isArray(api.blocks),
    'Locked API does not match the extension',
  );
  const provenance = object(lock.provenance);
  if (provenance.kind === 'published') {
    keys(provenance, ['kind', 'source', 'distribution']);
    const distribution = parseExtensionDistribution(provenance.distribution);
    // The shared parser normalizes known fields; reject any unknown information instead of losing it.
    keys(object(provenance.distribution), Object.keys(distribution));
    assertDistributionApi(distribution, api);
    assert(
      distribution.id === id &&
        distribution.bundle.sha256 === lock.bundleSHA256 &&
        distribution.api.sha256 === artifactSHA256(apiBytes),
      'Locked distribution artifacts do not agree',
    );
    if (bundle) assert(bundle.length === distribution.bundle.size, 'Locked bundle size mismatch');
    assert(apiBytes.length === distribution.api.size, 'Locked API size mismatch');
    const source = object(provenance.source);
    if (source.provider === 'npm') {
      keys(source, ['provider', 'package', 'version', 'integrity']);
      assert(
        typeof source.package === 'string' &&
          NPM_PACKAGE.test(source.package) &&
          source.package === distribution.package &&
          typeof source.version === 'string' &&
          EXACT_VERSION.test(source.version) &&
          source.version === distribution.version,
        'Invalid locked npm identity',
      );
      assert(
        typeof source.integrity === 'string' &&
          /^sha512-[A-Za-z0-9+/]{86}==$/u.test(source.integrity),
        'Invalid locked npm integrity',
      );
    } else {
      keys(source, [
        'provider',
        'repository',
        'tag',
        'commit',
        'releaseID',
        'descriptorSHA256',
        'assets',
      ]);
      assert(source.provider === 'github', 'Unsupported locked source provider');
      repository(source.repository);
      assert(
        typeof source.tag === 'string' &&
          [distribution.version, 'v' + distribution.version].includes(source.tag),
        'Invalid locked release tag',
      );
      assert(
        typeof source.commit === 'string' && /^[a-f0-9]{40}$/u.test(source.commit),
        'Invalid locked commit',
      );
      assert(
        Number.isSafeInteger(source.releaseID) && (source.releaseID as number) > 0,
        'Invalid locked release ID',
      );
      hash(source.descriptorSHA256);
      const assets = object(source.assets);
      keys(assets, ['descriptor', 'bundle', 'api']);
      const ids = new Set<number>();
      for (const [key, name, digest] of [
        ['descriptor', 'extension-package.json', source.descriptorSHA256],
        ['bundle', distribution.bundle.file, distribution.bundle.sha256],
        ['api', distribution.api.file, distribution.api.sha256],
      ]) {
        const asset = object(assets[key]);
        keys(asset, ['id', 'name', 'sha256']);
        assert(
          Number.isSafeInteger(asset.id) &&
            (asset.id as number) > 0 &&
            !ids.has(asset.id as number),
          'Invalid locked asset ID',
        );
        ids.add(asset.id as number);
        assert(asset.name === name && asset.sha256 === digest, 'Invalid locked asset identity');
      }
    }
  } else {
    assert(provenance.kind === 'build', 'Unsupported extension lock provenance');
    keys(provenance, ['kind', 'receipt']);
    const receipt = object(provenance.receipt);
    keys(receipt, [
      'formatVersion',
      'profile',
      'execution',
      'compiler',
      'snapshotSHA256',
      'lockfileSHA256',
      'outputs',
      'source',
    ]);
    assert(
      receipt.formatVersion === 1 &&
        receipt.profile === 'turbowarp-typescript-v1' &&
        ['sandboxed', 'unsandboxed'].includes(receipt.execution as string),
      'Unsupported build receipt',
    );
    const compiler = object(receipt.compiler);
    keys(compiler, ['name', 'version', 'integrity']);
    assert(
      compiler.name === 'rolldown' &&
        typeof compiler.version === 'string' &&
        EXACT_VERSION.test(compiler.version),
      'Invalid locked compiler',
    );
    assert(
      typeof compiler.integrity === 'string' &&
        /^sha512-[A-Za-z0-9+/]{86}==$/u.test(compiler.integrity),
      'Invalid compiler archive integrity',
    );
    hash(receipt.snapshotSHA256);
    hash(receipt.lockfileSHA256);
    const origin = object(receipt.source);
    if (origin.kind === 'github') {
      keys(origin, ['kind', 'repository', 'commit']);
      repository(origin.repository);
      assert(
        typeof origin.commit === 'string' && /^[a-f0-9]{40}$/u.test(origin.commit),
        'Invalid build commit',
      );
    } else {
      keys(origin, ['kind']);
      assert(origin.kind === 'local-snapshot', 'Unsupported build source');
    }
    const outputs = object(receipt.outputs);
    assert(Object.keys(outputs).length === 4, 'Invalid build outputs');
    for (const [name, digest] of Object.entries(outputs)) {
      assert(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(name), 'Unsafe build output name');
      hash(digest);
    }
    assert(
      Object.values(outputs).includes(lock.bundleSHA256) &&
        outputs['extension-manifest.json'] === artifactSHA256(apiBytes),
      'Build output lock mismatch',
    );
  }
}

export function lockPublishedExtension(candidate: PublishedExtension): ExtensionArtifactLock {
  const lock: ExtensionArtifactLock = {
    formatVersion: 1,
    bundleSHA256: artifactSHA256(candidate.bytes),
    apiJSON: new TextDecoder('utf-8', {fatal: true}).decode(candidate.apiBytes),
    provenance: {kind: 'published', source: candidate.source, distribution: candidate.distribution},
  };
  validateExtensionArtifactLock(lock, candidate.distribution.id, candidate.bytes);
  return structuredClone(lock);
}

export function lockStandardExtensionBuild(build: StandardExtensionBuild): ExtensionArtifactLock {
  assert(
    build.files.size === 4 && Object.keys(build.receipt.outputs).length === 4,
    'Invalid build artifact set',
  );
  for (const [file, bytes] of build.files) {
    assert(
      artifactSHA256(bytes) === build.receipt.outputs[file],
      'Build artifact bytes do not match the receipt',
    );
  }
  const apiJSON = new TextDecoder('utf-8', {fatal: true}).decode(
    build.files.get('extension-manifest.json'),
  );
  const marker = JSON.parse(
    new TextDecoder().decode(build.files.get('extension-development.json')),
  );
  const bytes = build.files.get(marker.bundle.file);
  assert(bytes, 'Missing build bundle');
  const lock: ExtensionArtifactLock = {
    formatVersion: 1,
    bundleSHA256: artifactSHA256(bytes),
    apiJSON,
    provenance: {kind: 'build', receipt: build.receipt},
  };
  validateExtensionArtifactLock(lock, marker.id, bytes);
  return structuredClone(lock);
}
