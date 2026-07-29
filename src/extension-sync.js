// SPDX-License-Identifier: MPL-2.0

import {cp, lstat, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {
  extensionHeaderId,
  extensionIntegrity,
  validateManagedExtensionContents,
} from './extension-dependencies.js';
import {
  assertNoInterruptedRollback,
  compareDirectories,
  pathExists,
  replaceDirectoryTransactionally,
} from './output-safety.js';
import {inspectSb3SourceForExtensionSync, validateSb3Source} from './source.js';

export const defaultExtensionArtifactSizeLimit = 5 * 1024 * 1024;
const githubApiResponseSizeLimit = 1024 * 1024;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertFetch(fetchImplementation) {
  assert(
    typeof fetchImplementation === 'function',
    'A Fetch API implementation is required for GitHub extension operations.',
  );
  return fetchImplementation;
}

function githubHeaders(accept) {
  return {
    Accept: accept,
    'User-Agent': 'sb3-toolchain',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function rawArtifactUrl(source, commit) {
  const artifact = source.artifact
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `https://raw.githubusercontent.com/${source.repository}/${commit}/${artifact}`;
}

function githubCommitUrl(source) {
  return (
    `https://api.github.com/repos/${source.repository}/commits/` + encodeURIComponent(source.ref)
  );
}

async function readLimitedResponse(response, maximumBytes, description) {
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength !== null && contentLength !== undefined) {
    const parsedLength = Number(contentLength);
    assert(
      Number.isSafeInteger(parsedLength) && parsedLength >= 0,
      `${description} returned an invalid Content-Length.`,
    );
    assert(parsedLength <= maximumBytes, `${description} exceeds the ${maximumBytes}-byte limit.`);
  }

  if (!response.body?.getReader) {
    const contents = Buffer.from(await response.arrayBuffer());
    assert(
      contents.length <= maximumBytes,
      `${description} exceeds the ${maximumBytes}-byte limit.`,
    );
    return contents;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalLength = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      totalLength += value.byteLength;
      assert(totalLength <= maximumBytes, `${description} exceeds the ${maximumBytes}-byte limit.`);
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks, totalLength);
}

async function fetchBytes(fetchImplementation, url, maximumBytes, description, accept) {
  const parsedUrl = new URL(url);
  assert(parsedUrl.protocol === 'https:', `${description} requires HTTPS.`);
  let response;
  try {
    response = await fetchImplementation(url, {
      headers: githubHeaders(accept),
      redirect: 'error',
    });
  } catch (error) {
    throw new Error(`${description} request failed: ${error.message}`, {cause: error});
  }
  assert(
    response && typeof response === 'object',
    `${description} request returned an invalid response.`,
  );
  assert(
    response.redirected !== true &&
      (!response.url || new URL(response.url).href === parsedUrl.href),
    `${description} refused a redirected response.`,
  );
  assert(response.ok, `${description} request failed with HTTP ${response.status ?? '(unknown)'}.`);
  return readLimitedResponse(response, maximumBytes, description);
}

async function resolveGithubCommit(extension, fetchImplementation) {
  const source = extension.source;
  if (/^[a-f0-9]{40}$/u.test(source.ref)) {
    return source.ref;
  }
  const contents = await fetchBytes(
    fetchImplementation,
    githubCommitUrl(source),
    githubApiResponseSizeLimit,
    `GitHub ref lookup for ${extension.id}`,
    'application/vnd.github+json',
  );
  let response;
  try {
    response = JSON.parse(contents.toString('utf8'));
  } catch (error) {
    throw new Error(`GitHub ref lookup for ${extension.id} returned invalid JSON.`, {cause: error});
  }
  assert(
    typeof response?.sha === 'string' && /^[a-f0-9]{40}$/u.test(response.sha),
    `GitHub ref lookup for ${extension.id} returned an invalid commit SHA.`,
  );
  return response.sha;
}

async function downloadExtension(extension, commit, fetchImplementation, maximumArtifactBytes) {
  const contents = await fetchBytes(
    fetchImplementation,
    rawArtifactUrl(extension.source, commit),
    maximumArtifactBytes,
    `GitHub artifact download for ${extension.id}`,
    'application/javascript, text/javascript;q=0.9, */*;q=0.1',
  );
  const actualId = extensionHeaderId(contents);
  assert(
    actualId === extension.id,
    `Downloaded extension header ID mismatch for ${extension.id}: ` +
      `expected ${extension.id}, got ${actualId ?? '(missing)'}`,
  );
  return contents;
}

function managedExtensions(source) {
  return source.extensions.filter((extension) => extension.source !== undefined);
}

async function inspectExtensionSource(sourceDirectory, {willReplace = false} = {}) {
  const resolvedSourceDirectory = path.resolve(sourceDirectory);
  if (willReplace) {
    assert(
      resolvedSourceDirectory !== path.parse(resolvedSourceDirectory).root,
      'Refusing to replace a filesystem root during extension synchronization.',
    );
    assert(
      !(await pathExists(path.join(resolvedSourceDirectory, '.git'))),
      'Refusing to replace a Git repository root during extension synchronization.',
    );
  }
  const stats = await lstat(resolvedSourceDirectory);
  assert(
    stats.isDirectory() && !stats.isSymbolicLink(),
    `SB3 source must be a directory, not a file or symbolic link: ${resolvedSourceDirectory}`,
  );
  if (willReplace) {
    await assertNoInterruptedRollback(resolvedSourceDirectory);
  }
  return inspectSb3SourceForExtensionSync(resolvedSourceDirectory);
}

async function installCandidate({candidateDirectory, confirmReplace, sourceDirectory, yes}) {
  const comparison = await compareDirectories(sourceDirectory, candidateDirectory);
  if (comparison.identical) {
    await rm(candidateDirectory, {recursive: true, force: true});
    return {changed: false, comparison, rollbackCleanupWarning: null};
  }

  const context = {comparison, sourceDirectory};
  if (!yes) {
    assert(
      typeof confirmReplace === 'function',
      `Managed extension files differ in ${sourceDirectory}. ` +
        'Non-interactive replacement requires --yes.',
    );
    assert(
      await confirmReplace(context),
      'Extension synchronization cancelled; the existing source was not changed.',
    );
  }

  const latestComparison = await compareDirectories(sourceDirectory, candidateDirectory);
  assert(
    latestComparison.existingFingerprint === comparison.existingFingerprint &&
      latestComparison.candidateFingerprint === comparison.candidateFingerprint,
    'SB3 source or extension candidate changed during synchronization; refusing to replace it.',
  );
  const replacement = await replaceDirectoryTransactionally(candidateDirectory, sourceDirectory);
  return {changed: true, comparison, ...replacement};
}

async function updateCandidate({
  confirmReplace,
  fetchImplementation,
  maximumArtifactBytes,
  mode,
  selectedExtensionId,
  sourceDirectory,
  yes,
}) {
  assert(
    Number.isSafeInteger(maximumArtifactBytes) && maximumArtifactBytes > 0,
    'maximumArtifactBytes must be a positive integer.',
  );
  const source = await inspectExtensionSource(sourceDirectory, {willReplace: true});
  const managed = managedExtensions(source);
  assert(managed.length > 0, 'No managed embedded extensions were found.');
  if (selectedExtensionId !== undefined) {
    assert(
      managed.some((extension) => extension.id === selectedExtensionId),
      `Managed extension was not found: ${selectedExtensionId}`,
    );
  }
  const selected = managed.filter(
    (extension) => selectedExtensionId === undefined || extension.id === selectedExtensionId,
  );

  const downloads = await Promise.all(
    selected.map(async (extension) => {
      const commit =
        mode === 'sync'
          ? extension.source.resolvedCommit
          : await resolveGithubCommit(extension, fetchImplementation);
      const contents = await downloadExtension(
        extension,
        commit,
        fetchImplementation,
        maximumArtifactBytes,
      );
      if (mode === 'sync') {
        validateManagedExtensionContents(extension, contents);
      }
      return {commit, contents, extension};
    }),
  );

  const parentDirectory = path.dirname(source.resolvedSourceDirectory);
  const candidateDirectory = await mkdtemp(
    path.join(parentDirectory, `.${path.basename(source.resolvedSourceDirectory)}.extensions-`),
  );
  let installed = false;
  try {
    await cp(source.resolvedSourceDirectory, candidateDirectory, {
      preserveTimestamps: true,
      recursive: true,
      verbatimSymlinks: true,
    });
    const manifestPath = path.join(candidateDirectory, source.sourceManifest.embeddedExtensions);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const entriesById = new Map(manifest.extensions.map((extension) => [extension.id, extension]));
    let manifestChanged = false;
    for (const {commit, contents, extension} of downloads) {
      await writeFile(path.join(candidateDirectory, extension.path), contents);
      if (mode === 'update') {
        const candidateExtension = entriesById.get(extension.id);
        assert(candidateExtension, `Extension manifest entry disappeared: ${extension.id}`);
        const integrity = extensionIntegrity(contents);
        manifestChanged =
          manifestChanged ||
          candidateExtension.source.resolvedCommit !== commit ||
          candidateExtension.source.integrity !== integrity;
        candidateExtension.source.resolvedCommit = commit;
        candidateExtension.source.integrity = integrity;
      }
    }
    if (manifestChanged) {
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    await validateSb3Source(candidateDirectory);
    const result = await installCandidate({
      candidateDirectory,
      confirmReplace,
      sourceDirectory: source.resolvedSourceDirectory,
      yes,
    });
    installed = true;
    return {
      ...result,
      extensions: downloads.map(({commit, extension}) => ({
        id: extension.id,
        resolvedCommit: commit,
      })),
      mode,
      sourceDirectory: source.resolvedSourceDirectory,
    };
  } finally {
    if (!installed) {
      await rm(candidateDirectory, {recursive: true, force: true});
    }
  }
}

export async function extensionStatus(
  sourceDirectory,
  {fetch: fetchImplementation = globalThis.fetch} = {},
) {
  const source = await inspectExtensionSource(sourceDirectory);
  const fetchFunction = assertFetch(fetchImplementation);
  return Promise.all(
    managedExtensions(source).map(async (extension) => {
      const remoteCommit = await resolveGithubCommit(extension, fetchFunction);
      let local = 'valid';
      try {
        validateManagedExtensionContents(extension, source.extensionContents.get(extension.id));
      } catch {
        local = 'modified';
      }
      return {
        id: extension.id,
        local,
        ref: extension.source.ref,
        remoteCommit,
        resolvedCommit: extension.source.resolvedCommit,
        state: remoteCommit === extension.source.resolvedCommit ? 'current' : 'update-available',
      };
    }),
  );
}

export async function syncExtensions({
  confirmReplace,
  fetch: fetchImplementation = globalThis.fetch,
  maximumArtifactBytes = defaultExtensionArtifactSizeLimit,
  sourceDirectory,
  yes = false,
}) {
  return updateCandidate({
    confirmReplace,
    fetchImplementation: assertFetch(fetchImplementation),
    maximumArtifactBytes,
    mode: 'sync',
    selectedExtensionId: undefined,
    sourceDirectory,
    yes,
  });
}

export async function updateExtensions({
  confirmReplace,
  extensionId,
  fetch: fetchImplementation = globalThis.fetch,
  maximumArtifactBytes = defaultExtensionArtifactSizeLimit,
  sourceDirectory,
  yes = false,
}) {
  return updateCandidate({
    confirmReplace,
    fetchImplementation: assertFetch(fetchImplementation),
    maximumArtifactBytes,
    mode: 'update',
    selectedExtensionId: extensionId,
    sourceDirectory,
    yes,
  });
}
