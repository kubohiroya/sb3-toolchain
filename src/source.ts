// SPDX-License-Identifier: MPL-2.0

import {createHash} from 'node:crypto';
import {lstat, readdir, readFile} from 'node:fs/promises';
import path from 'node:path';

import {strToU8, zipSync} from 'fflate';

import {validateArchiveEntryName} from './archive';
import {assert, errorMessage} from './assert';
import {validateManagedExtensionApiManifest} from './extension-api-manifest';
import {buildExtensionBundles, validateExtensionBundleConfigurations} from './extension-bundle';
import type {ExtensionBundlePlan} from './extension-bundle';
import {
  validateExtensionSourceMetadata,
  validateManagedExtensionContents,
} from './extension-dependencies';
import {applyProjectAssetAdditions} from './project-asset-additions';
import type {ProjectAssetAdditionsSummary} from './project-asset-additions';
import {cleanUpTurboWarpBlocks} from './turbowarp-clean-up';
import type {
  EmbeddedExtension,
  ExtensionBundleConfiguration,
  ProjectAssetReference,
  ProjectJson,
  Sb3SourceManifest,
  UnknownRecord,
} from './types';

export const sourceFormatVersion = 1;
export const fixedZipTimestamp = new Date(1980, 0, 1, 0, 0, 0, 0);

export interface InspectedSb3Source {
  assetContents: Map<string, Uint8Array>;
  assetReferenceCount: number;
  extensions: EmbeddedExtension[];
  extensionApiManifestContents: Map<string, Uint8Array>;
  extensionBundles: ExtensionBundleConfiguration[];
  extensionContents: Map<string, Uint8Array>;
  project: ProjectJson;
  resolvedSourceDirectory: string;
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
}

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  await assertDirectory(rootDirectory, description);
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

function assertSameFileSet(
  actualFiles: string[],
  expectedFiles: string[],
  description: string,
): void {
  const actual = new Set(actualFiles);
  const expected = new Set(expectedFiles);
  const missing = [...expected].filter((filePath) => !actual.has(filePath)).sort();
  const extra = [...actual].filter((filePath) => !expected.has(filePath)).sort();
  assert(
    missing.length === 0 && extra.length === 0,
    `${description} does not match its manifest. Missing: ${missing.join(', ') || '(none)'}. ` +
      `Extra: ${extra.join(', ') || '(none)'}.`,
  );
}

function md5(contents: Uint8Array | string): string {
  return createHash('md5').update(contents).digest('hex');
}

function validateSourceManifest(manifest: unknown): asserts manifest is Sb3SourceManifest {
  assert(isObject(manifest), 'sb3-source.json must contain an object.');
  assert(
    manifest.formatVersion === sourceFormatVersion,
    `Unsupported SB3 source format version: ${manifest.formatVersion}`,
  );
  assert(
    manifest.project === 'project.source.json',
    'SB3 source format 1 requires project.source.json.',
  );
  assert(
    manifest.embeddedExtensions === 'embedded-extensions.json',
    'SB3 source format 1 requires embedded-extensions.json.',
  );
  assert(
    manifest.assetsDirectory === 'assets',
    'SB3 source format 1 requires the assets directory.',
  );
  assert(
    Array.isArray(manifest.archiveEntries) && manifest.archiveEntries.length > 0,
    'sb3-source.json archiveEntries must be a non-empty array.',
  );

  const seenEntries = new Set<string>();
  let projectEntryCount = 0;
  for (const rawEntryName of manifest.archiveEntries as unknown[]) {
    const entryName = validateArchiveEntryName(rawEntryName);
    assert(!seenEntries.has(entryName), `Duplicate archive entry in manifest: ${entryName}`);
    assert(
      !entryName.endsWith('/'),
      `Directory ZIP entries are not supported in SB3 source format 1: ${entryName}`,
    );
    assert(
      !/^(?:0|[1-9][0-9]*)$/u.test(entryName),
      `Integer-like ZIP entry names cannot preserve JavaScript object order: ${entryName}`,
    );
    seenEntries.add(entryName);
    if (entryName === 'project.json') {
      projectEntryCount += 1;
    }
  }
  assert(projectEntryCount === 1, 'archiveEntries must contain project.json exactly once.');
}

function validateExtensionManifest(
  extensionManifest: unknown,
  project: ProjectJson,
  extensionFiles: string[],
): {extensionBundles: ExtensionBundleConfiguration[]; extensions: EmbeddedExtension[]} {
  assert(isObject(extensionManifest), 'embedded-extensions.json must contain an object.');
  assert(
    extensionManifest.formatVersion === sourceFormatVersion,
    `Unsupported embedded extension manifest version: ${extensionManifest.formatVersion}`,
  );
  assert(
    Array.isArray(extensionManifest.extensions),
    'embedded-extensions.json extensions must be an array.',
  );

  const extensionUrls: unknown = project.extensionURLs ?? {};
  assert(
    isObject(extensionUrls),
    'project.source.json extensionURLs must be an object when present.',
  );
  const extensionsById = new Map<string, EmbeddedExtension>();
  const expectedFiles: string[] = [];
  const extensions: EmbeddedExtension[] = [];

  for (const entry of extensionManifest.extensions as unknown[]) {
    assert(isObject(entry), 'Each embedded extension manifest entry must be an object.');
    const extension = entry as unknown as EmbeddedExtension;
    assert(
      typeof extension.id === 'string' && /^[A-Za-z0-9._-]+$/u.test(extension.id),
      `Invalid embedded extension ID: ${JSON.stringify(extension.id)}`,
    );
    assert(!extensionsById.has(extension.id), `Duplicate embedded extension ID: ${extension.id}`);
    const expectedPath = `extensions/${extension.id}.js`;
    assert(
      extension.path === expectedPath,
      `Embedded extension path must match its ID: expected ${expectedPath}, got ${extension.path}`,
    );
    assert(
      typeof extension.mediaType === 'string' &&
        extension.mediaType.length > 0 &&
        !/[;,\r\n]/u.test(extension.mediaType),
      `Invalid media type for embedded extension ${extension.id}: ${extension.mediaType}`,
    );
    assert(
      Array.isArray(extension.parameters) &&
        extension.parameters.every(
          (parameter) =>
            typeof parameter === 'string' && parameter.length > 0 && !/[;,\r\n]/u.test(parameter),
        ),
      `Invalid data URL parameters for embedded extension ${extension.id}.`,
    );
    assert(
      extension.encoding === 'base64' || extension.encoding === 'percent',
      `Unsupported encoding for embedded extension ${extension.id}: ${extension.encoding}`,
    );
    assert(
      extensionUrls[extension.id] === `embedded-extension:${extension.path}`,
      `project.source.json mapping does not match embedded extension ${extension.id}.`,
    );
    validateExtensionSourceMetadata(extension);
    extensionsById.set(extension.id, extension);
    extensions.push(extension);
    expectedFiles.push(`${extension.id}.js`);
    if (extension.source?.apiManifest) {
      expectedFiles.push(path.posix.relative('extensions', extension.source.apiManifest.path));
    }
  }

  for (const [extensionId, extensionUrl] of Object.entries(extensionUrls)) {
    assert(
      typeof extensionUrl !== 'string' || !extensionUrl.startsWith('data:'),
      `project.source.json still contains an embedded data URL: ${extensionId}`,
    );
    if (typeof extensionUrl === 'string' && extensionUrl.startsWith('embedded-extension:')) {
      assert(
        extensionsById.has(extensionId),
        `project.source.json has no metadata for embedded extension ${extensionId}.`,
      );
    }
  }

  assertSameFileSet(extensionFiles, expectedFiles, 'Embedded extension files');
  return {
    extensionBundles: validateExtensionBundleConfigurations(
      extensionManifest.extensionBundles,
      extensions,
    ),
    extensions,
  };
}

function collectAssetReferences(
  project: ProjectJson,
): {asset: ProjectAssetReference; description: string}[] {
  assert(Array.isArray(project.targets), 'project.source.json targets must be an array.');
  const references: {asset: ProjectAssetReference; description: string}[] = [];
  for (const [targetIndex, target] of (project.targets as unknown[]).entries()) {
    assert(isObject(target), `Project target ${targetIndex} must be an object.`);
    for (const [collectionName, kind] of [
      ['costumes', 'costume'],
      ['sounds', 'sound'],
    ] as const) {
      const assets: unknown = target[collectionName] ?? [];
      assert(
        Array.isArray(assets),
        `Project target ${targetIndex} ${collectionName} must be an array.`,
      );
      for (const [assetIndex, asset] of (assets as unknown[]).entries()) {
        assert(isObject(asset), `Project ${kind} ${targetIndex}:${assetIndex} must be an object.`);
        references.push({asset, description: `${kind} ${targetIndex}:${assetIndex}`});
      }
    }
  }
  return references;
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
  const assetEntries = sourceManifest.archiveEntries.filter(
    (entryName) => entryName !== 'project.json',
  );
  const project: unknown = await readJson(
    path.join(resolvedSourceDirectory, sourceManifest.project),
    'SB3 project source',
  );
  assert(isObject(project), 'project.source.json must contain an object.');
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
  const {extensionBundles, extensions} = validateExtensionManifest(
    extensionManifest,
    project,
    extensionFiles,
  );

  const assetContents = new Map<string, Uint8Array>();
  await Promise.all(
    assetFiles.map(async (assetPath) => {
      assetContents.set(assetPath, await readFile(path.join(assetsDirectory, assetPath)));
    }),
  );
  const referencedAssets = new Set<string>();
  const references = collectAssetReferences(project);
  for (const {asset, description} of references) {
    assert(
      typeof asset.assetId === 'string' && /^[a-f0-9]{32}$/u.test(asset.assetId),
      `Invalid assetId for ${description}: ${asset.assetId}`,
    );
    assert(
      typeof asset.dataFormat === 'string' && /^[A-Za-z0-9]+$/u.test(asset.dataFormat),
      `Invalid dataFormat for ${description}: ${asset.dataFormat}`,
    );
    const expectedFilename = `${asset.assetId}.${asset.dataFormat}`;
    assert(
      asset.md5ext === expectedFilename,
      `Asset filename mismatch for ${description}: expected ${expectedFilename}, got ${asset.md5ext}`,
    );
    const contents = assetContents.get(expectedFilename);
    assert(contents, `Referenced asset is missing for ${description}: ${expectedFilename}`);
    const actualAssetId = md5(contents);
    assert(
      actualAssetId === asset.assetId,
      `Asset content hash mismatch for ${description}: expected ${asset.assetId}, got ${actualAssetId}`,
    );
    referencedAssets.add(expectedFilename);
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

  return {
    assetContents,
    assetReferenceCount: references.length,
    extensions,
    extensionApiManifestContents,
    extensionBundles,
    extensionContents,
    project,
    resolvedSourceDirectory,
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
  buildExtensionBundles({
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
  const {allowedAssetRoots = [], cleanUpBlocks = false, projectAssetsPath} = options;
  assert(typeof cleanUpBlocks === 'boolean', 'cleanUpBlocks must be a boolean.');
  assert(Array.isArray(allowedAssetRoots), 'allowedAssetRoots must be an array.');
  assert(
    projectAssetsPath === undefined || typeof projectAssetsPath === 'string',
    'projectAssetsPath must be a string when provided.',
  );
  const source = await validateSb3Source(sourceDirectory);
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
  const bundled = buildExtensionBundles({
    extensionBundles: source.extensionBundles,
    extensionContents: source.extensionContents,
    extensions: source.extensions,
    project: projectAssets.project,
  });
  let project = structuredClone(bundled.project);
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
  const extensionUrls: Record<string, unknown> = project.extensionURLs ?? {};
  for (const extension of bundled.extensions) {
    const contents = bundled.extensionContents.get(extension.id);
    assert(contents, `Embedded extension has no contents: ${extension.id}`);
    extensionUrls[extension.id] = encodeExtensionDataUrl(extension, contents);
  }
  project.extensionURLs = extensionUrls;

  const archiveEntries: Record<string, Uint8Array> = {};
  for (const entryName of projectAssets.archiveEntries) {
    if (entryName === 'project.json') {
      archiveEntries[entryName] = strToU8(`${JSON.stringify(project)}\n`);
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
    entryCount: projectAssets.archiveEntries.length,
    projectAssetAdditions: projectAssets.summary,
    source,
  };
}
