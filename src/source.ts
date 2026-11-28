// SPDX-License-Identifier: MPL-2.0

import {createHash} from 'node:crypto';
import {lstat, readdir, readFile} from 'node:fs/promises';
import path from 'node:path';

import {strToU8, zipSync} from 'fflate';

import {assert, errorMessage} from './assert';
import {
  applyBlockPaletteComments,
  resolveBlockPaletteReferences,
  validateBlockPaletteDocument,
} from './block-palette';
import type {BlockPaletteDocument} from './block-palette';
import {extensionLocksEntry, validateExtensionArtifactLock} from './extension-artifact-lock';
import {plusFilePaths, validatePlusArtifacts} from './plus-extension-project';
import {validateManagedExtensionApiManifest} from './extension-api-manifest';
import {validateExtensionBundleConfigurations} from './extension-bundle';
import {buildExtensionBundlesWithModules} from './extension-module-bundle';
import type {ExtensionBundlePlan} from './extension-bundle';
import {
  validateExtensionSourceMetadata,
  validateManagedExtensionContents,
} from './extension-dependencies';
import {applyProjectAssetAdditions} from './project-asset-additions';
import type {ProjectAssetAdditionsSummary} from './project-asset-additions';
import {stripTestScripts} from './test-scripts';
import type {TestScriptStripSummary} from './test-scripts';
import {cleanUpTurboWarpBlocks} from './turbowarp-clean-up';
import {
  assertSameFileSet,
  collectSourceAssetReferences,
  isObject,
  screenStateEntry,
  screenStateFile,
  validateExtensionLayout,
  validateSourceManifest,
} from './source-format';
import type {
  EmbeddedExtension,
  ExtensionBundleConfiguration,
  ProjectJson,
  Sb3SourceManifest,
} from './types';

export {
  blockPaletteSourceFormatVersion,
  sourceFormatVersion,
  supportedSourceFormatVersions,
} from './source-format';
export const fixedZipTimestamp = new Date(1980, 0, 1, 0, 0, 0, 0);

export interface InspectedSb3Source {
  assetContents: Map<string, Uint8Array>;
  assetReferenceCount: number;
  /** `block-palette.json` in source format 2, otherwise null. */
  blockPalette: BlockPaletteDocument | null;
  extensions: EmbeddedExtension[];
  extensionApiManifestContents: Map<string, Uint8Array>;
  extensionBundles: ExtensionBundleConfiguration[];
  extensionContents: Map<string, Uint8Array>;
  project: ProjectJson;
  resolvedSourceDirectory: string;
  /** The Editor's screen state (`.tw-plus/workspace.json`), or null when the folder has none. */
  screenState: Uint8Array | null;
  sourceManifest: Sb3SourceManifest;
}

export interface BlockCleanUpSummary {
  movedCommentCount: number;
  movedScriptCount: number;
  scriptCount: number;
  targetCount: number;
}

export interface DeterministicSb3Options {
  allowedAssetRoots?: string[];
  cleanUpBlocks?: boolean;
  projectAssetsPath?: string;
  /** Removes the scripts under test hats from the generated SB3; the expanded source is unchanged. */
  stripTests?: boolean;
}

export interface DeterministicSb3 {
  archive: Uint8Array;
  assetCount: number;
  assetReferenceCount: number;
  blockCleanUp: BlockCleanUpSummary | null;
  bundlePlans: ExtensionBundlePlan[];
  embeddedExtensionCount: number;
  entryCount: number;
  projectAssetAdditions: Readonly<ProjectAssetAdditionsSummary> | null;
  source: InspectedSb3Source;
  testStrip: TestScriptStripSummary | null;
}

async function readJson(filePath: string, description: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${description} is not valid JSON: ${filePath} (${errorMessage(error)})`, {
      cause: error,
    });
  }
}

async function assertDirectory(directoryPath: string, description: string): Promise<void> {
  const stats = await lstat(directoryPath);
  assert(
    stats.isDirectory() && !stats.isSymbolicLink(),
    `${description} must be a directory, not a file or symbolic link: ${directoryPath}`,
  );
}

async function listRegularFiles(rootDirectory: string, description: string): Promise<string[]> {
  try {
    await assertDirectory(rootDirectory, description);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: string[] = [];

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, {withFileTypes: true});
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? path.posix.join(relativeDirectory, entry.name)
        : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else {
        assert(
          entry.isFile(),
          `${description} contains a symbolic link or unsupported entry: ${relativePath}`,
        );
        files.push(relativePath);
      }
    }
  }

  await visit(rootDirectory, '');
  return files;
}

function md5(contents: Uint8Array | string): string {
  return createHash('md5').update(contents).digest('hex');
}

function percentEncode(contents: Uint8Array): string {
  return [...contents]
    .map((byte) => `%${byte.toString(16).padStart(2, '0').toUpperCase()}`)
    .join('');
}

function encodeExtensionDataUrl(extension: EmbeddedExtension, contents: Uint8Array): string {
  const metadata = [extension.mediaType, ...extension.parameters].join(';');
  if (extension.encoding === 'base64') {
    return `data:${metadata};base64,${Buffer.from(contents).toString('base64')}`;
  }
  return `data:${metadata},${percentEncode(contents)}`;
}

async function inspectSb3Source(
  sourceDirectory: string,
  validateManagedExtensions: boolean,
): Promise<InspectedSb3Source> {
  const resolvedSourceDirectory = path.resolve(sourceDirectory);
  await assertDirectory(resolvedSourceDirectory, 'SB3 source');
  const sourceManifest = await readJson(
    path.join(resolvedSourceDirectory, 'sb3-source.json'),
    'SB3 source manifest',
  );
  validateSourceManifest(sourceManifest);
  // The Editor writes its screen state into the folder whenever it saves; it is optional and only has to be JSON.
  let screenState: Uint8Array | null = null;
  try {
    screenState = await readFile(path.join(resolvedSourceDirectory, screenStateFile));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (screenState) {
    try {
      JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(screenState));
    } catch (cause) {
      throw new Error(`${screenStateFile} is not valid JSON: ${errorMessage(cause)}`, {cause});
    }
  }
  const project: unknown = await readJson(
    path.join(resolvedSourceDirectory, sourceManifest.project),
    'SB3 project source',
  );
  assert(isObject(project), 'project.source.json must contain an object.');
  const plusFiles = plusFilePaths(project);
  for (const name of plusFiles)
    assert(sourceManifest.archiveEntries.includes(name), 'Plus embedded archive entry is missing.');
  const assetEntries = sourceManifest.archiveEntries.filter(
    (entryName) =>
      entryName !== 'project.json' &&
      entryName !== screenStateEntry &&
      entryName !== extensionLocksEntry &&
      !plusFiles.has(entryName),
  );
  const blockPalette =
    sourceManifest.blockPalette === undefined
      ? null
      : validateBlockPaletteDocument(
          await readJson(
            path.join(resolvedSourceDirectory, sourceManifest.blockPalette),
            'Block palette settings',
          ),
        );
  resolveBlockPaletteReferences(project, blockPalette);
  const extensionManifest = await readJson(
    path.join(resolvedSourceDirectory, sourceManifest.embeddedExtensions),
    'Embedded extension manifest',
  );

  const assetsDirectory = path.join(resolvedSourceDirectory, sourceManifest.assetsDirectory);
  const extensionsDirectory = path.join(resolvedSourceDirectory, 'extensions');
  const [assetFiles, extensionFiles] = await Promise.all([
    listRegularFiles(assetsDirectory, 'Assets directory'),
    listRegularFiles(extensionsDirectory, 'Extensions directory'),
  ]);
  assertSameFileSet(assetFiles, assetEntries, 'Asset files');
  const {extensionBundles: bundleConfiguration, extensions} = validateExtensionLayout(
    extensionManifest,
    project,
    extensionFiles,
    validateExtensionSourceMetadata,
  );
  const extensionBundles = validateExtensionBundleConfigurations(bundleConfiguration, extensions);

  const assetContents = new Map<string, Uint8Array>();
  await Promise.all(
    assetFiles.map(async (assetPath) => {
      assetContents.set(assetPath, await readFile(path.join(assetsDirectory, assetPath)));
    }),
  );
  const references = collectSourceAssetReferences(project);
  const referencedAssets = new Set<string>();
  for (const {filename, description} of references) {
    if (referencedAssets.has(filename)) continue;
    const contents = assetContents.get(filename);
    assert(contents, `Referenced asset is missing for ${description}: ${filename}`);
    const assetId = filename.slice(0, 32);
    const actualAssetId = md5(contents);
    assert(
      actualAssetId === assetId,
      `Asset content hash mismatch for ${description}: expected ${assetId}, got ${actualAssetId}`,
    );
    referencedAssets.add(filename);
  }
  const unreferencedAssets = assetFiles.filter((assetPath) => !referencedAssets.has(assetPath));
  assert(
    unreferencedAssets.length === 0,
    `Asset manifest contains unreferenced files: ${unreferencedAssets.join(', ')}`,
  );

  const extensionContents = new Map<string, Uint8Array>();
  const extensionApiManifestContents = new Map<string, Uint8Array>();
  await Promise.all(
    extensions.map(async (extension) => {
      const contents = await readFile(path.join(resolvedSourceDirectory, extension.path));
      if (extension.artifactLock !== undefined) {
        validateExtensionArtifactLock(extension.artifactLock, extension.id, contents);
      }
      if (validateManagedExtensions) {
        validateManagedExtensionContents(extension, contents);
      }
      extensionContents.set(extension.id, contents);
      if (extension.source?.apiManifest) {
        const apiManifestContents = await readFile(
          path.join(resolvedSourceDirectory, extension.source.apiManifest.path),
        );
        if (validateManagedExtensions) {
          validateManagedExtensionApiManifest(extension, apiManifestContents);
        }
        extensionApiManifestContents.set(extension.id, apiManifestContents);
      }
    }),
  );
  validatePlusArtifacts(project, extensions, extensionContents);

  return {
    assetContents,
    assetReferenceCount: references.length,
    blockPalette,
    extensions,
    extensionApiManifestContents,
    extensionBundles,
    extensionContents,
    project,
    resolvedSourceDirectory,
    screenState,
    sourceManifest,
  };
}

export async function inspectSb3SourceForExtensionSync(
  sourceDirectory: string,
): Promise<InspectedSb3Source> {
  return inspectSb3Source(sourceDirectory, false);
}

export async function validateSb3Source(sourceDirectory: string): Promise<InspectedSb3Source> {
  const source = await inspectSb3Source(sourceDirectory, true);
  await buildExtensionBundlesWithModules({
    sourceDirectory: source.resolvedSourceDirectory,
    extensionBundles: source.extensionBundles,
    extensionContents: source.extensionContents,
    extensions: source.extensions,
    project: source.project,
  });
  return source;
}

export async function createDeterministicSb3(
  sourceDirectory: string,
  options: DeterministicSb3Options = {},
): Promise<DeterministicSb3> {
  const {
    allowedAssetRoots = [],
    cleanUpBlocks = false,
    projectAssetsPath,
    stripTests = false,
  } = options;
  assert(typeof cleanUpBlocks === 'boolean', 'cleanUpBlocks must be a boolean.');
  assert(typeof stripTests === 'boolean', 'stripTests must be a boolean.');
  assert(Array.isArray(allowedAssetRoots), 'allowedAssetRoots must be an array.');
  assert(
    projectAssetsPath === undefined || typeof projectAssetsPath === 'string',
    'projectAssetsPath must be a string when provided.',
  );
  const source = await inspectSb3Source(sourceDirectory, true);
  const projectAssets: {
    archiveEntries: string[];
    assetContents: Map<string, Uint8Array>;
    assetReferenceCount: number;
    project: ProjectJson;
    summary: Readonly<ProjectAssetAdditionsSummary> | null;
  } = projectAssetsPath
    ? await applyProjectAssetAdditions({
        allowedAssetRoots,
        assetContents: source.assetContents,
        archiveEntries: source.sourceManifest.archiveEntries,
        manifestPath: projectAssetsPath,
        project: source.project,
      })
    : {
        archiveEntries: source.sourceManifest.archiveEntries,
        assetContents: source.assetContents,
        assetReferenceCount: 0,
        project: source.project,
        summary: null,
      };
  let testStrip: TestScriptStripSummary | null = null;
  let projectToBundle = projectAssets.project;
  if (stripTests) {
    // Before bundling, while the test hats still have their own extension's opcodes.
    const {project: strippedProject, ...summary} = stripTestScripts(projectToBundle);
    projectToBundle = strippedProject;
    testStrip = summary;
  }
  const bundled = await buildExtensionBundlesWithModules({
    sourceDirectory: source.resolvedSourceDirectory,
    extensionBundles: source.extensionBundles,
    extensionContents: source.extensionContents,
    extensions: source.extensions,
    project: projectToBundle,
  });
  const lockedExtensions = source.extensions.filter(
    (extension) => extension.artifactLock !== undefined,
  );
  for (const extension of lockedExtensions) {
    const contents = bundled.extensionContents.get(extension.id);
    assert(
      contents && bundled.extensions.some((item) => item.id === extension.id),
      'Bundling would discard a locked extension; prepare a new verified artifact first',
    );
    validateExtensionArtifactLock(extension.artifactLock, extension.id, contents);
  }
  let project = structuredClone(bundled.project);
  validatePlusArtifacts(project, bundled.extensions, bundled.extensionContents);
  let blockCleanUp: BlockCleanUpSummary | null = null;
  if (cleanUpBlocks) {
    const cleaned = cleanUpTurboWarpBlocks(project);
    project = cleaned.project;
    blockCleanUp = {
      movedCommentCount: cleaned.movedCommentCount,
      movedScriptCount: cleaned.movedScriptCount,
      scriptCount: cleaned.scriptCount,
      targetCount: cleaned.targetCount,
    };
  }
  applyBlockPaletteComments(project, source.blockPalette);
  const extensionUrls: Record<string, unknown> = project.extensionURLs ?? {};
  const plusFiles = plusFilePaths(project);
  for (const extension of bundled.extensions) {
    const contents = bundled.extensionContents.get(extension.id);
    assert(contents, `Embedded extension has no contents: ${extension.id}`);
    if (plusFiles.has(extension.path)) delete extensionUrls[extension.id];
    else extensionUrls[extension.id] = encodeExtensionDataUrl(extension, contents);
  }
  project.extensionURLs = extensionUrls;

  const archiveEntries: Record<string, Uint8Array> = {};
  // The screen state keeps its place in the archive; one the Editor wrote after the import goes last.
  const entryNames = [...projectAssets.archiveEntries];
  if (source.screenState && !entryNames.includes(screenStateEntry))
    entryNames.push(screenStateEntry);
  const lockBytes = lockedExtensions.length
    ? strToU8(
        `${JSON.stringify({formatVersion: 1, extensions: lockedExtensions.map(({id, artifactLock}) => ({id, artifactLock}))})}\n`,
      )
    : null;
  assert(
    lockedExtensions.length <= 256 &&
      (!lockBytes ||
        lockBytes.byteLength <= (project.turboWarpPlus === undefined ? 8 : 1) * 1024 * 1024),
    'Extension locks attachment exceeds its size limit',
  );
  if (lockBytes && !entryNames.includes(extensionLocksEntry)) entryNames.push(extensionLocksEntry);
  for (const entryName of entryNames) {
    if (plusFiles.has(entryName)) {
      const extension = bundled.extensions.find((extension) => extension.path === entryName);
      const contents = extension && bundled.extensionContents.get(extension.id);
      assert(contents, 'Plus embedded archive entry has no contents.');
      archiveEntries[entryName] = contents;
      continue;
    }
    if (entryName === extensionLocksEntry) {
      assert(lockBytes, 'Extension locks attachment lost its records; refusing to discard it');
      archiveEntries[entryName] = lockBytes;
      continue;
    }
    if (entryName === 'project.json') {
      archiveEntries[entryName] = strToU8(`${JSON.stringify(project)}\n`);
      continue;
    }
    if (entryName === screenStateEntry) {
      if (source.screenState) archiveEntries[entryName] = source.screenState;
      continue;
    }
    const contents = projectAssets.assetContents.get(entryName);
    assert(contents, `Archive entry has no contents: ${entryName}`);
    archiveEntries[entryName] = contents;
  }
  const archive = zipSync(archiveEntries, {
    level: 6,
    mtime: fixedZipTimestamp,
  });

  return {
    archive,
    assetCount: projectAssets.assetContents.size,
    assetReferenceCount: source.assetReferenceCount + projectAssets.assetReferenceCount,
    blockCleanUp,
    bundlePlans: bundled.bundlePlans,
    embeddedExtensionCount: bundled.extensions.length,
    entryCount: Object.keys(archiveEntries).length,
    projectAssetAdditions: projectAssets.summary,
    source,
    testStrip,
  };
}
