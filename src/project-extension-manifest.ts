// SPDX-License-Identifier: MPL-2.0

// Pure manifest parsing shared by archive validation and the Node inventory. Never fetches or executes code.
import {assert} from './assert';
import type {UnknownRecord} from './types';

/** The project.json member the loader family keeps its manifest under. */
export const projectManifestKey = 'turboWarpPlus';

/**
 * The four forms an author can keep one extension in, spelled as the manifest spells them.
 *
 * Two hold a reference and two hold the bytes. Only `remote-cacheable` can ever leave a copy in a
 * browser, which is what makes the distinction worth reporting at all.
 */
export const extensionSourceTypes = Object.freeze([
  'remote-non-cacheable',
  'remote-cacheable',
  'embedded-file',
  'embedded-data',
] as const);

export type ExtensionSourceType = (typeof extensionSourceTypes)[number];

export type ExtensionExecutionMode = 'sandboxed' | 'unsandboxed';

const manifestExtensionLimit = 64;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const extensionIdPattern = /^[a-zA-Z][a-zA-Z0-9]{0,63}$/u;
const embeddedPathPattern = /^extensions\/[a-zA-Z0-9][a-zA-Z0-9._/-]*\.js$/u;

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKnownMembers(value: unknown, allowed: string[], label: string): UnknownRecord {
  assert(isObject(value), `${label} must be a JSON object.`);
  const unknownMembers = Object.keys(value).filter((key) => !allowed.includes(key));
  assert(unknownMembers.length === 0, `${label} has unknown members: ${unknownMembers.join(', ')}`);
  return value;
}

/** One rule for every address the manifest records, applied without contacting anything. */
function manifestAddress(value: unknown, what: string): string {
  assert(
    typeof value === 'string' && value.length > 0 && value.length <= 4096,
    `${what} must be an absolute HTTPS URL.`,
  );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${what} must be an absolute HTTPS URL.`);
  }
  assert(
    url.protocol === 'https:' && !url.username && !url.password && !url.hash,
    `${what} requires HTTPS without credentials or a fragment.`,
  );
  return url.href;
}

/** Split by carrier, so only `embedded-file` carries an archive path to look up. */
type ManifestSource =
  | {type: 'remote-non-cacheable' | 'remote-cacheable'; path: null; url: string}
  | {type: 'embedded-file'; path: string; url: string | null}
  | {type: 'embedded-data'; path: null; url: string | null};

function readManifestSource(value: unknown, id: string): ManifestSource {
  assert(isObject(value), `Extension ${id} is missing its source.`);
  const {type} = value;
  if (type === 'remote-non-cacheable' || type === 'remote-cacheable') {
    assertKnownMembers(value, ['type', 'url'], `Extension ${id} source`);
    return {type, path: null, url: manifestAddress(value.url, `Extension ${id} source URL`)};
  }
  if (type === 'embedded-file') {
    assertKnownMembers(value, ['type', 'path', 'url'], `Extension ${id} source`);
    const sourcePath = value.path;
    assert(
      typeof sourcePath === 'string' &&
        sourcePath.length <= 256 &&
        embeddedPathPattern.test(sourcePath) &&
        !sourcePath.split('/').some((part) => !part || part === '.' || part === '..'),
      `Extension ${id} has an unsafe embedded path: ${JSON.stringify(sourcePath)}`,
    );
    return {
      type,
      path: sourcePath,
      url:
        value.url === undefined ? null : manifestAddress(value.url, `Extension ${id} source URL`),
    };
  }
  if (type === 'embedded-data') {
    assertKnownMembers(value, ['type', 'url'], `Extension ${id} source`);
    return {
      type,
      path: null,
      url:
        value.url === undefined ? null : manifestAddress(value.url, `Extension ${id} source URL`),
    };
  }
  // Name each retired spelling and what replaces it, so a project written by an older version
  // reports something a reader can act on instead of "unsupported".
  assert(
    type !== 'remote',
    `Extension ${id}: a remote source is now remote-cacheable or remote-non-cacheable.`,
  );
  assert(type !== 'cached', `Extension ${id}: a cached source is now embedded-file with a url.`);
  assert(
    type !== 'embedded',
    `Extension ${id}: an embedded source is now embedded-file or embedded-data.`,
  );
  throw new Error(`Extension ${id} has an unsupported source type: ${JSON.stringify(type)}`);
}

export interface ManifestExtension {
  id: string;
  sha256: string;
  execution: ExtensionExecutionMode;
  source: ManifestSource;
  artifactLockFormatVersion?: 1;
}

interface ProjectManifest {
  uri: string | null;
  extensions: ManifestExtension[];
}

/**
 * Validates only what this inventory reports, without resolving dependencies or granting anything.
 *
 * The manifest is the author's claim about their own project, so it is read as untrusted data: the
 * members are checked, and nothing in it is contacted or executed.
 */
export function readProjectManifest(project: unknown): ProjectManifest | null {
  assert(isObject(project), 'SB3 project.json must contain a JSON object.');
  if (!Object.hasOwn(project, projectManifestKey)) return null;
  const manifest = assertKnownMembers(
    project[projectManifestKey],
    ['schemaVersion', 'uri', 'extensions'],
    'Project manifest',
  );
  assert(manifest.schemaVersion === 1, 'Only project manifest schemaVersion 1 is supported.');
  const uri = manifest.uri === undefined ? null : manifestAddress(manifest.uri, 'A project URI');
  assert(
    Array.isArray(manifest.extensions) && manifest.extensions.length <= manifestExtensionLimit,
    `Project manifest extensions must be an array of at most ${manifestExtensionLimit} entries.`,
  );

  const seenIds = new Set<string>();
  const extensions = manifest.extensions.map((entry: unknown): ManifestExtension => {
    const extension = assertKnownMembers(
      entry,
      [
        'id',
        'source',
        'execution',
        'sha256',
        'version',
        'publisher',
        'capabilities',
        'dependencies',
        'artifactLockFormatVersion',
      ],
      'Project manifest extension',
    );
    const {id} = extension;
    assert(
      typeof id === 'string' && extensionIdPattern.test(id) && !seenIds.has(id),
      `Invalid or duplicate manifest extension ID: ${JSON.stringify(id)}`,
    );
    seenIds.add(id);
    assert(
      extension.execution === 'sandboxed' || extension.execution === 'unsandboxed',
      `Extension ${id} requires an explicit sandboxed or unsandboxed execution request.`,
    );
    assert(
      typeof extension.sha256 === 'string' && sha256Pattern.test(extension.sha256),
      `Extension ${id} requires a lowercase SHA-256 pin.`,
    );
    assert(
      extension.artifactLockFormatVersion === undefined ||
        extension.artifactLockFormatVersion === 1,
      `Extension ${id} has an unsupported artifact lock format.`,
    );
    return {
      id,
      sha256: extension.sha256,
      execution: extension.execution,
      source: readManifestSource(extension.source, id),
      ...(extension.artifactLockFormatVersion === 1 ? {artifactLockFormatVersion: 1 as const} : {}),
    };
  });
  return {uri, extensions};
}
