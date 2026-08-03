// SPDX-License-Identifier: MPL-2.0

import {cp, lstat, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {
  compareExtensionApiManifests,
  defaultExtensionApiManifestSizeLimit,
  extensionApiManifestIntegrity,
  formatExtensionApiCompatibilityChanges,
  parseExtensionApiManifest,
  validateExtensionApiManifestSourceMetadata,
  validateManagedExtensionApiManifest,
} from './extension-api-manifest.js';
import {
  extensionHeaderId,
  extensionIntegrity,
  validateExtensionSourceMetadata,
  validateManagedExtensionContents,
} from './extension-dependencies.js';
import {rewriteExtensionIdDocuments, validateNewExtensionId} from './extension-id-migration.js';
import {
  assertNoInterruptedRollback,
  compareDirectories,
  pathExists,
  replaceDirectoryTransactionally,
} from './output-safety.js';
import {
  createDeterministicSb3,
  inspectSb3SourceForExtensionSync,
  validateSb3Source,
} from './source.js';

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

function rawArtifactUrl(source, commit, artifactPath = source.artifact) {
  const artifact = artifactPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `https://raw.githubusercontent.com/${source.repository}/${commit}/${artifact}`;
}

async function downloadExtensionApiManifest(
  extension,
  commit,
  fetchImplementation,
  maximumManifestBytes,
  expectedId = extension.id,
) {
  const metadata = validateExtensionApiManifestSourceMetadata(extension);
  if (!metadata) return null;
  const contents = await fetchBytes(
    fetchImplementation,
    rawArtifactUrl(extension.source, commit, metadata.artifact),
    maximumManifestBytes,
    `GitHub extension API manifest download for ${extension.id}`,
    'application/json',
  );
  const manifest = parseExtensionApiManifest(contents, {expectedId});
  return {contents, manifest};
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

async function downloadExtension(
  extension,
  commit,
  fetchImplementation,
  maximumArtifactBytes,
  expectedId = extension.id,
) {
  const contents = await fetchBytes(
    fetchImplementation,
    rawArtifactUrl(extension.source, commit),
    maximumArtifactBytes,
    `GitHub artifact download for ${extension.id}`,
    'application/javascript, text/javascript;q=0.9, */*;q=0.1',
  );
  const actualId = extensionHeaderId(contents);
  assert(
    actualId === expectedId,
    `Downloaded extension header ID mismatch for ${extension.id}: ` +
      `expected ${expectedId}, got ${actualId ?? '(missing)'}`,
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

async function installCandidate({
  candidateDirectory,
  confirmReplace,
  initialSourceFingerprint,
  sourceDirectory,
  yes,
}) {
  const comparison = await compareDirectories(sourceDirectory, candidateDirectory);
  assert(
    comparison.existingFingerprint === initialSourceFingerprint,
    'SB3 source changed while extension artifacts were being fetched; refusing to replace it.',
  );
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
  allowBreakingApi,
  confirmReplace,
  fetchImplementation,
  maximumArtifactBytes,
  maximumManifestBytes,
  migrateToId,
  mode,
  selectedExtensionId,
  sourceArtifact,
  sourceDirectory,
  yes,
}) {
  assert(
    Number.isSafeInteger(maximumArtifactBytes) && maximumArtifactBytes > 0,
    'maximumArtifactBytes must be a positive integer.',
  );
  assert(
    Number.isSafeInteger(maximumManifestBytes) && maximumManifestBytes > 0,
    'maximumManifestBytes must be a positive integer.',
  );
  assert(!allowBreakingApi || yes, '--allow-breaking-api requires --yes.');
  const source = await inspectExtensionSource(sourceDirectory, {willReplace: true});
  const initialComparison = await compareDirectories(
    source.resolvedSourceDirectory,
    source.resolvedSourceDirectory,
  );
  assert(
    initialComparison.identical &&
      initialComparison.existingFingerprint === initialComparison.candidateFingerprint,
    'SB3 source changed while its initial state was being inspected.',
  );
  const managed = managedExtensions(source);
  assert(managed.length > 0, 'No managed embedded extensions were found.');
  if (selectedExtensionId !== undefined) {
    assert(
      managed.some((extension) => extension.id === selectedExtensionId),
      `Managed extension was not found: ${selectedExtensionId}`,
    );
  }
  if (migrateToId !== undefined) {
    assert(mode === 'update', 'Extension ID migration is only available during update.');
    assert(
      selectedExtensionId !== undefined,
      'Extension ID migration requires an explicit existing extension ID.',
    );
    validateNewExtensionId(migrateToId);
  }
  assert(
    sourceArtifact === undefined || migrateToId !== undefined,
    'A replacement artifact path requires an extension ID migration.',
  );
  const selected = managed.filter(
    (extension) => selectedExtensionId === undefined || extension.id === selectedExtensionId,
  );
  if (migrateToId !== undefined) {
    const extensionManifest = JSON.parse(
      await readFile(
        path.join(source.resolvedSourceDirectory, source.sourceManifest.embeddedExtensions),
        'utf8',
      ),
    );
    rewriteExtensionIdDocuments({
      extensionManifest,
      newId: migrateToId,
      oldId: selectedExtensionId,
      project: source.project,
      sourceArtifact,
    });
  }

  const downloads = await Promise.all(
    selected.map(async (extension) => {
      const effectiveExtension =
        sourceArtifact === undefined
          ? extension
          : {
              ...extension,
              source: {...extension.source, artifact: sourceArtifact},
            };
      validateExtensionSourceMetadata(effectiveExtension);
      const commit =
        mode === 'sync'
          ? extension.source.resolvedCommit
          : await resolveGithubCommit(extension, fetchImplementation);
      const expectedId = migrateToId ?? extension.id;
      const [contents, apiManifestDownload] = await Promise.all([
        downloadExtension(
          effectiveExtension,
          commit,
          fetchImplementation,
          maximumArtifactBytes,
          expectedId,
        ),
        downloadExtensionApiManifest(
          effectiveExtension,
          commit,
          fetchImplementation,
          maximumManifestBytes,
          expectedId,
        ),
      ]);
      let compatibilityChanges = [];
      if (mode === 'sync') {
        validateManagedExtensionContents(extension, contents);
        if (apiManifestDownload) {
          validateManagedExtensionApiManifest(extension, apiManifestDownload.contents);
        }
      } else if (apiManifestDownload) {
        const installedApiManifestContents = source.extensionApiManifestContents.get(extension.id);
        assert(
          installedApiManifestContents,
          `Managed extension API manifest is missing for ${extension.id}.`,
        );
        const installedApiManifest = validateManagedExtensionApiManifest(
          extension,
          installedApiManifestContents,
        ).manifest;
        compatibilityChanges = compareExtensionApiManifests(
          installedApiManifest,
          apiManifestDownload.manifest,
        );
      }
      return {
        apiManifestDownload,
        commit,
        compatibilityChanges,
        contents,
        effectiveExtension,
        extension,
      };
    }),
  );
  const breakingApiChanges = downloads.flatMap((download) =>
    download.compatibilityChanges
      .filter((change) => change.breaking)
      .map((change) => ({...change, extensionId: download.extension.id})),
  );
  if (breakingApiChanges.length > 0 && !allowBreakingApi) {
    const details = downloads
      .filter((download) => download.compatibilityChanges.some((change) => change.breaking))
      .map((download) =>
        formatExtensionApiCompatibilityChanges(
          download.extension.id,
          download.compatibilityChanges.filter((change) => change.breaking),
        ),
      )
      .join('\n');
    throw new Error(
      `Extension API update contains ${breakingApiChanges.length} breaking change(s). ` +
        'Review the reported paths, then use --allow-breaking-api with --yes to apply.\n' +
        details,
    );
  }

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
    const projectPath = path.join(candidateDirectory, source.sourceManifest.project);
    const entriesById = new Map(manifest.extensions.map((extension) => [extension.id, extension]));
    let manifestChanged = false;
    let migration;
    for (const {
      apiManifestDownload,
      commit,
      contents,
      effectiveExtension,
      extension,
    } of downloads) {
      if (migrateToId !== undefined) {
        const project = JSON.parse(await readFile(projectPath, 'utf8'));
        migration = rewriteExtensionIdDocuments({
          extensionManifest: manifest,
          newId: migrateToId,
          oldId: extension.id,
          project,
          sourceArtifact: effectiveExtension.source.artifact,
        });
        const migratedExtension = migration.extensionManifest.extensions[migration.extensionIndex];
        migratedExtension.source.resolvedCommit = commit;
        migratedExtension.source.integrity = extensionIntegrity(contents);
        if (apiManifestDownload) {
          migratedExtension.source.apiManifest.integrity = extensionApiManifestIntegrity(
            apiManifestDownload.contents,
          );
        }
        const writes = [
          writeFile(projectPath, `${JSON.stringify(migration.project, null, 2)}\n`),
          writeFile(manifestPath, `${JSON.stringify(migration.extensionManifest, null, 2)}\n`),
          writeFile(path.join(candidateDirectory, migration.newPath), contents),
        ];
        if (apiManifestDownload && migration.newApiManifestPath) {
          writes.push(
            writeFile(
              path.join(candidateDirectory, migration.newApiManifestPath),
              apiManifestDownload.contents,
            ),
          );
        }
        await Promise.all(writes);
        await rm(path.join(candidateDirectory, migration.oldPath));
        if (migration.oldApiManifestPath) {
          await rm(path.join(candidateDirectory, migration.oldApiManifestPath));
        }
        continue;
      }
      await writeFile(path.join(candidateDirectory, extension.path), contents);
      if (apiManifestDownload) {
        await writeFile(
          path.join(candidateDirectory, extension.source.apiManifest.path),
          apiManifestDownload.contents,
        );
      }
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
        if (apiManifestDownload) {
          const apiManifestIntegrity = extensionApiManifestIntegrity(apiManifestDownload.contents);
          manifestChanged =
            manifestChanged ||
            candidateExtension.source.apiManifest.integrity !== apiManifestIntegrity;
          candidateExtension.source.apiManifest.integrity = apiManifestIntegrity;
          candidateExtension.source.apiManifest.formatVersion =
            apiManifestDownload.manifest.formatVersion;
        }
      }
    }
    if (manifestChanged && migrateToId === undefined) {
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    if (migration) {
      await createDeterministicSb3(candidateDirectory);
    } else {
      await validateSb3Source(candidateDirectory);
    }
    const result = await installCandidate({
      candidateDirectory,
      confirmReplace,
      initialSourceFingerprint: initialComparison.existingFingerprint,
      sourceDirectory: source.resolvedSourceDirectory,
      yes,
    });
    installed = true;
    return {
      ...result,
      apiCompatibility: downloads
        .filter(({apiManifestDownload}) => apiManifestDownload !== null)
        .map(({compatibilityChanges, extension}) => ({
          changes: compatibilityChanges,
          id: migrateToId ?? extension.id,
          previousId: migrateToId === undefined ? undefined : extension.id,
        })),
      extensions: downloads.map(({commit, extension}) => ({
        id: migrateToId ?? extension.id,
        previousId: migrateToId === undefined ? undefined : extension.id,
        resolvedCommit: commit,
      })),
      migration:
        migration === undefined
          ? null
          : {
              counts: migration.counts,
              fromId: selectedExtensionId,
              toId: migrateToId,
              totalChanges: migration.totalChanges,
              unclassifiedReferences: migration.unclassifiedReferences,
            },
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
        if (extension.source.apiManifest) {
          validateManagedExtensionApiManifest(
            extension,
            source.extensionApiManifestContents.get(extension.id),
          );
        }
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
  maximumManifestBytes = defaultExtensionApiManifestSizeLimit,
  sourceDirectory,
  yes = false,
}) {
  return updateCandidate({
    allowBreakingApi: false,
    confirmReplace,
    fetchImplementation: assertFetch(fetchImplementation),
    maximumArtifactBytes,
    maximumManifestBytes,
    migrateToId: undefined,
    mode: 'sync',
    selectedExtensionId: undefined,
    sourceArtifact: undefined,
    sourceDirectory,
    yes,
  });
}

export async function updateExtensions({
  allowBreakingApi = false,
  confirmReplace,
  extensionId,
  fetch: fetchImplementation = globalThis.fetch,
  maximumArtifactBytes = defaultExtensionArtifactSizeLimit,
  maximumManifestBytes = defaultExtensionApiManifestSizeLimit,
  migrateToId,
  sourceArtifact,
  sourceDirectory,
  yes = false,
}) {
  return updateCandidate({
    allowBreakingApi,
    confirmReplace,
    fetchImplementation: assertFetch(fetchImplementation),
    maximumArtifactBytes,
    maximumManifestBytes,
    migrateToId,
    mode: 'update',
    selectedExtensionId: extensionId,
    sourceArtifact,
    sourceDirectory,
    yes,
  });
}
