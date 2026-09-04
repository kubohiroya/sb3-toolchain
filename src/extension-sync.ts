// SPDX-License-Identifier: MPL-2.0

import {cp, lstat, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {assert, errorMessage} from './assert';
import {
  compareExtensionApiManifests,
  defaultExtensionApiManifestSizeLimit,
  extensionApiManifestIntegrity,
  formatExtensionApiCompatibilityChanges,
  parseExtensionApiManifest,
  validateExtensionApiManifestSourceMetadata,
  validateManagedExtensionApiManifest,
} from './extension-api-manifest';
import type {ExtensionApiCompatibilityChange, ExtensionApiManifest} from './extension-api-manifest';
import {
  extensionHeaderId,
  extensionIntegrity,
  validateExtensionSourceMetadata,
  validateManagedExtensionContents,
} from './extension-dependencies';
import {rewriteExtensionIdDocuments, validateNewExtensionId} from './extension-id-migration';
import type {RewriteExtensionIdDocumentsResult} from './extension-id-migration';
import {readNpmExtensionSource} from './npm-extension-source';
import {
  assertNoInterruptedRollback,
  compareDirectories,
  pathExists,
  replaceDirectoryTransactionally,
} from './output-safety';
import type {DirectoryComparison} from './output-safety';
import {
  createDeterministicSb3,
  inspectSb3SourceForExtensionSync,
  validateSb3Source,
} from './source';
import type {InspectedSb3Source} from './source';
import type {
  EmbeddedExtension,
  EmbeddedExtensionManifest,
  ExtensionSource,
  GitHubExtensionSource,
  ProjectJson,
} from './types';

export const defaultExtensionArtifactSizeLimit = 5 * 1024 * 1024;
const githubApiResponseSizeLimit = 1024 * 1024;

export type FetchImplementation = typeof globalThis.fetch;

export type ExtensionSyncMode = 'sync' | 'update';

/** The candidate manifest is edited in place as a JSON document before it is written back. */
interface MutableExtensionSource {
  apiManifest?: {artifact: string; formatVersion: number; integrity: string; path: string};
  artifact: string;
  integrity: string;
  package?: string;
  provider: string;
  ref?: string;
  resolvedCommit?: string;
  version?: string;
}

interface MutableManifestExtension {
  id: string;
  path: string;
  source?: MutableExtensionSource;
  [key: string]: unknown;
}

interface MutableExtensionManifest {
  extensions: MutableManifestExtension[];
  [key: string]: unknown;
}

interface ApiManifestDownload {
  contents: Buffer;
  manifest: ExtensionApiManifest;
}

interface ExtensionDownload {
  apiManifestDownload: ApiManifestDownload | null;
  commit: string | null;
  compatibilityChanges: ExtensionApiCompatibilityChange[];
  contents: Buffer;
  effectiveExtension: EmbeddedExtension;
  extension: EmbeddedExtension;
  npmVersion?: string;
}

export interface ExtensionSyncConfirmContext {
  comparison: DirectoryComparison;
  sourceDirectory: string;
}

interface UpdateCandidateInput {
  allowBreakingApi: boolean;
  apiManifestArtifact: string | undefined;
  confirmReplace?: (context: ExtensionSyncConfirmContext) => boolean | Promise<boolean>;
  fetchImplementation?: FetchImplementation;
  maximumArtifactBytes: number;
  maximumManifestBytes: number;
  migrateToId: string | undefined;
  mode: ExtensionSyncMode;
  selectedExtensionId: string | undefined;
  sourceArtifact: string | undefined;
  sourceDirectory: string;
  yes: boolean;
}

export interface SyncExtensionsOptions {
  confirmReplace?: (context: ExtensionSyncConfirmContext) => boolean | Promise<boolean>;
  fetch?: FetchImplementation;
  maximumArtifactBytes?: number;
  maximumManifestBytes?: number;
  sourceDirectory: string;
  yes?: boolean;
}

export interface UpdateExtensionsOptions extends SyncExtensionsOptions {
  allowBreakingApi?: boolean;
  apiManifestArtifact?: string;
  extensionId?: string;
  migrateToId?: string;
  sourceArtifact?: string;
}

function assertFetch(fetchImplementation: FetchImplementation | undefined): FetchImplementation {
  assert(
    typeof fetchImplementation === 'function',
    'A Fetch API implementation is required for GitHub extension operations.',
  );
  return fetchImplementation;
}

function githubHeaders(accept: string): Record<string, string> {
  return {
    Accept: accept,
    'User-Agent': 'sb3-toolchain',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function rawArtifactUrl(
  source: GitHubExtensionSource,
  commit: string,
  artifactPath: string = source.artifact,
): string {
  const artifact = artifactPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `https://raw.githubusercontent.com/${source.repository}/${commit}/${artifact}`;
}

async function downloadExtensionApiManifest(
  extension: EmbeddedExtension,
  commit: string,
  fetchImplementation: FetchImplementation,
  maximumManifestBytes: number,
  expectedId: string = extension.id,
): Promise<ApiManifestDownload | null> {
  const metadata = validateExtensionApiManifestSourceMetadata(extension);
  if (!metadata) return null;
  const contents = await fetchBytes(
    fetchImplementation,
    rawArtifactUrl(extension.source as GitHubExtensionSource, commit, metadata.artifact),
    maximumManifestBytes,
    `GitHub extension API manifest download for ${extension.id}`,
    'application/json',
  );
  const manifest = parseExtensionApiManifest(contents, {expectedId});
  return {contents, manifest};
}

function githubCommitUrl(source: GitHubExtensionSource): string {
  return (
    `https://api.github.com/repos/${source.repository}/commits/` + encodeURIComponent(source.ref)
  );
}

async function readLimitedResponse(
  response: Response,
  maximumBytes: number,
  description: string,
): Promise<Buffer> {
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
  const chunks: Buffer[] = [];
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

async function fetchBytes(
  fetchImplementation: FetchImplementation,
  url: string,
  maximumBytes: number,
  description: string,
  accept: string,
): Promise<Buffer> {
  const parsedUrl = new URL(url);
  assert(parsedUrl.protocol === 'https:', `${description} requires HTTPS.`);
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      headers: githubHeaders(accept),
      redirect: 'error',
    });
  } catch (error) {
    throw new Error(`${description} request failed: ${errorMessage(error)}`, {cause: error});
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

async function resolveGithubCommit(
  extension: EmbeddedExtension,
  fetchImplementation: FetchImplementation,
): Promise<string> {
  const source = extension.source as GitHubExtensionSource;
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
  let response: {sha?: unknown} | null;
  try {
    response = JSON.parse(contents.toString('utf8'));
  } catch (error) {
    throw new Error(`GitHub ref lookup for ${extension.id} returned invalid JSON.`, {cause: error});
  }
  assert(
    typeof response?.sha === 'string' && /^[a-f0-9]{40}$/u.test(response.sha),
    `GitHub ref lookup for ${extension.id} returned an invalid commit SHA.`,
  );
  return response.sha as string;
}

async function downloadExtension(
  extension: EmbeddedExtension,
  commit: string,
  fetchImplementation: FetchImplementation,
  maximumArtifactBytes: number,
  expectedId: string = extension.id,
): Promise<Buffer> {
  const contents = await fetchBytes(
    fetchImplementation,
    rawArtifactUrl(extension.source as GitHubExtensionSource, commit),
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

function managedExtensions(source: InspectedSb3Source): EmbeddedExtension[] {
  return source.extensions.filter((extension) => extension.source !== undefined);
}

async function inspectExtensionSource(
  sourceDirectory: string,
  {willReplace = false}: {willReplace?: boolean} = {},
): Promise<InspectedSb3Source> {
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
}: {
  candidateDirectory: string;
  confirmReplace?: (context: ExtensionSyncConfirmContext) => boolean | Promise<boolean>;
  initialSourceFingerprint: string;
  sourceDirectory: string;
  yes: boolean;
}): Promise<{
  changed: boolean;
  comparison: DirectoryComparison;
  rollbackCleanupWarning: string | null;
}> {
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
  apiManifestArtifact,
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
}: UpdateCandidateInput) {
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
  const selected = managed.filter(
    (extension) => selectedExtensionId === undefined || extension.id === selectedExtensionId,
  );
  if (migrateToId !== undefined) {
    assert(mode === 'update', 'Extension ID migration is only available during update.');
    assert(
      selectedExtensionId !== undefined,
      'Extension ID migration requires an explicit existing extension ID.',
    );
    validateNewExtensionId(migrateToId);
    assert(
      selected.every((extension) => extension.source?.provider === 'github'),
      'Extension ID migration is not supported for npm-managed extensions.',
    );
  }
  assert(
    sourceArtifact === undefined || migrateToId !== undefined,
    'A replacement artifact path requires an extension ID migration.',
  );
  assert(
    apiManifestArtifact === undefined || migrateToId !== undefined,
    'A replacement API manifest artifact path requires an extension ID migration.',
  );
  if (migrateToId !== undefined) {
    const extensionManifest = JSON.parse(
      await readFile(
        path.join(source.resolvedSourceDirectory, source.sourceManifest.embeddedExtensions),
        'utf8',
      ),
    ) as EmbeddedExtensionManifest;
    assert(selectedExtensionId !== undefined, 'Extension ID migration requires an extension ID.');
    rewriteExtensionIdDocuments({
      apiManifestArtifact,
      extensionManifest,
      newId: migrateToId,
      oldId: selectedExtensionId,
      project: source.project,
      sourceArtifact,
    });
  }

  const downloads: ExtensionDownload[] = await Promise.all(
    selected.map(async (extension): Promise<ExtensionDownload> => {
      let effectiveExtension = extension;
      if (sourceArtifact !== undefined || apiManifestArtifact !== undefined) {
        const effectiveSource = {...extension.source} as ExtensionSource;
        if (sourceArtifact !== undefined) effectiveSource.artifact = sourceArtifact;
        if (apiManifestArtifact !== undefined) {
          assert(
            effectiveSource.apiManifest,
            `Extension ${extension.id} has no managed API manifest metadata.`,
          );
          effectiveSource.apiManifest = {
            ...effectiveSource.apiManifest,
            artifact: apiManifestArtifact,
          };
        }
        effectiveExtension = {...extension, source: effectiveSource};
      }
      validateExtensionSourceMetadata(effectiveExtension);
      if (effectiveExtension.source?.provider === 'npm') {
        const npmSource = await readNpmExtensionSource(
          effectiveExtension,
          source.resolvedSourceDirectory,
          {
            allowVersionMismatch: mode === 'update',
            maximumArtifactBytes,
            maximumManifestBytes,
          },
        );
        const apiManifestDownload = npmSource.apiManifestContents
          ? {
              contents: npmSource.apiManifestContents,
              manifest: parseExtensionApiManifest(npmSource.apiManifestContents, {
                expectedId: extension.id,
              }),
            }
          : null;
        let compatibilityChanges: ExtensionApiCompatibilityChange[] = [];
        if (mode === 'sync') {
          validateManagedExtensionContents(extension, npmSource.contents);
          if (apiManifestDownload) {
            validateManagedExtensionApiManifest(extension, apiManifestDownload.contents);
          }
        } else if (apiManifestDownload) {
          const installedApiManifestContents = source.extensionApiManifestContents.get(
            extension.id,
          );
          assert(
            installedApiManifestContents,
            `Managed extension API manifest is missing for ${extension.id}.`,
          );
          const installedApiManifest = validateManagedExtensionApiManifest(
            extension,
            installedApiManifestContents,
          )?.manifest;
          assert(
            installedApiManifest,
            `Managed extension API manifest is invalid: ${extension.id}`,
          );
          compatibilityChanges = compareExtensionApiManifests(
            installedApiManifest,
            apiManifestDownload.manifest,
          );
        }
        return {
          apiManifestDownload,
          commit: null,
          compatibilityChanges,
          contents: npmSource.contents,
          effectiveExtension,
          extension,
          npmVersion: npmSource.version,
        };
      }
      const githubFetch = assertFetch(fetchImplementation);
      const commit =
        mode === 'sync'
          ? (extension.source as GitHubExtensionSource).resolvedCommit
          : await resolveGithubCommit(extension, githubFetch);
      const expectedId = migrateToId ?? extension.id;
      const [contents, apiManifestDownload] = await Promise.all([
        downloadExtension(
          effectiveExtension,
          commit,
          githubFetch,
          maximumArtifactBytes,
          expectedId,
        ),
        downloadExtensionApiManifest(
          effectiveExtension,
          commit,
          githubFetch,
          maximumManifestBytes,
          expectedId,
        ),
      ]);
      let compatibilityChanges: ExtensionApiCompatibilityChange[] = [];
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
        )?.manifest;
        assert(installedApiManifest, `Managed extension API manifest is invalid: ${extension.id}`);
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
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as MutableExtensionManifest;
    const projectPath = path.join(candidateDirectory, source.sourceManifest.project);
    const entriesById = new Map(manifest.extensions.map((entry) => [entry.id, entry]));
    let manifestChanged = false;
    let migration: RewriteExtensionIdDocumentsResult | undefined;
    for (const {
      apiManifestDownload,
      commit,
      contents,
      effectiveExtension,
      extension,
      npmVersion,
    } of downloads) {
      if (migrateToId !== undefined) {
        const project = JSON.parse(await readFile(projectPath, 'utf8')) as ProjectJson;
        migration = rewriteExtensionIdDocuments({
          apiManifestArtifact,
          extensionManifest: manifest as unknown as EmbeddedExtensionManifest,
          newId: migrateToId,
          oldId: extension.id,
          project,
          sourceArtifact: effectiveExtension.source?.artifact,
        });
        const migratedExtension = migration.extensionManifest.extensions[
          migration.extensionIndex
        ] as unknown as MutableManifestExtension;
        const migratedSource = migratedExtension.source;
        assert(migratedSource, `Migrated extension has no source metadata: ${extension.id}`);
        migratedSource.resolvedCommit = commit ?? undefined;
        migratedSource.integrity = extensionIntegrity(contents);
        if (apiManifestDownload && migratedSource.apiManifest) {
          migratedSource.apiManifest.integrity = extensionApiManifestIntegrity(
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
        const apiManifestPath = extension.source?.apiManifest?.path;
        assert(apiManifestPath, `Managed extension API manifest path is missing: ${extension.id}`);
        await writeFile(
          path.join(candidateDirectory, apiManifestPath),
          apiManifestDownload.contents,
        );
      }
      if (mode === 'update') {
        const candidateExtension = entriesById.get(extension.id);
        assert(candidateExtension, `Extension manifest entry disappeared: ${extension.id}`);
        const candidateSource = candidateExtension.source;
        assert(candidateSource, `Extension manifest entry has no source: ${extension.id}`);
        const integrity = extensionIntegrity(contents);
        manifestChanged = manifestChanged || candidateSource.integrity !== integrity;
        if (candidateSource.provider === 'npm') {
          manifestChanged = manifestChanged || candidateSource.version !== npmVersion;
          candidateSource.version = npmVersion;
        } else {
          manifestChanged = manifestChanged || candidateSource.resolvedCommit !== commit;
          candidateSource.resolvedCommit = commit ?? undefined;
        }
        candidateSource.integrity = integrity;
        if (apiManifestDownload && candidateSource.apiManifest) {
          const apiManifestIntegrity = extensionApiManifestIntegrity(apiManifestDownload.contents);
          manifestChanged =
            manifestChanged || candidateSource.apiManifest.integrity !== apiManifestIntegrity;
          candidateSource.apiManifest.integrity = apiManifestIntegrity;
          candidateSource.apiManifest.formatVersion = apiManifestDownload.manifest.formatVersion;
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
      extensions: downloads.map(({commit, extension, npmVersion}) => {
        const extensionSource = extension.source;
        return extensionSource?.provider === 'npm'
          ? {
              id: extension.id,
              package: extensionSource.package,
              version: npmVersion,
            }
          : {
              id: migrateToId ?? extension.id,
              previousId: migrateToId === undefined ? undefined : extension.id,
              resolvedCommit: commit,
            };
      }),
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
  sourceDirectory: string,
  {fetch: fetchImplementation = globalThis.fetch}: {fetch?: FetchImplementation} = {},
) {
  const source = await inspectExtensionSource(sourceDirectory);
  return Promise.all(
    managedExtensions(source).map(async (extension) => {
      const extensionSource = extension.source;
      assert(extensionSource, `Managed extension has no source metadata: ${extension.id}`);
      let local = 'valid';
      try {
        const contents = source.extensionContents.get(extension.id);
        assert(contents, `Managed extension contents are missing: ${extension.id}`);
        validateManagedExtensionContents(extension, contents);
        if (extensionSource.apiManifest) {
          const apiManifestContents = source.extensionApiManifestContents.get(extension.id);
          assert(apiManifestContents, `Managed extension API manifest is missing: ${extension.id}`);
          validateManagedExtensionApiManifest(extension, apiManifestContents);
        }
      } catch {
        local = 'modified';
      }
      if (extensionSource.provider === 'npm') {
        const npmSource = await readNpmExtensionSource(extension, source.resolvedSourceDirectory, {
          allowVersionMismatch: true,
          maximumArtifactBytes: defaultExtensionArtifactSizeLimit,
          maximumManifestBytes: defaultExtensionApiManifestSizeLimit,
        });
        if (npmSource.version === extensionSource.version) {
          validateManagedExtensionContents(extension, npmSource.contents);
          if (npmSource.apiManifestContents) {
            validateManagedExtensionApiManifest(extension, npmSource.apiManifestContents);
          }
        }
        return {
          id: extension.id,
          installedVersion: npmSource.version,
          local,
          package: extensionSource.package,
          state: npmSource.version === extensionSource.version ? 'current' : 'update-available',
          version: extensionSource.version,
        };
      }
      const remoteCommit = await resolveGithubCommit(extension, assertFetch(fetchImplementation));
      return {
        id: extension.id,
        local,
        ref: extensionSource.ref,
        remoteCommit,
        resolvedCommit: extensionSource.resolvedCommit,
        state: remoteCommit === extensionSource.resolvedCommit ? 'current' : 'update-available',
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
}: SyncExtensionsOptions) {
  return updateCandidate({
    allowBreakingApi: false,
    apiManifestArtifact: undefined,
    confirmReplace,
    fetchImplementation,
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
  apiManifestArtifact,
  confirmReplace,
  extensionId,
  fetch: fetchImplementation = globalThis.fetch,
  maximumArtifactBytes = defaultExtensionArtifactSizeLimit,
  maximumManifestBytes = defaultExtensionApiManifestSizeLimit,
  migrateToId,
  sourceArtifact,
  sourceDirectory,
  yes = false,
}: UpdateExtensionsOptions) {
  return updateCandidate({
    allowBreakingApi,
    apiManifestArtifact,
    confirmReplace,
    fetchImplementation,
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
