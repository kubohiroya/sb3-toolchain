// SPDX-License-Identifier: MPL-2.0

import {createHash} from 'node:crypto';
import {lstat, readdir, readFile} from 'node:fs/promises';
import path from 'node:path';

import {strToU8, zipSync} from 'fflate';

import {validateArchiveEntryName} from './archive.js';
import {buildExtensionBundles, validateExtensionBundleConfigurations} from './extension-bundle.js';
import {
  validateExtensionSourceMetadata,
  validateManagedExtensionContents,
} from './extension-dependencies.js';

export const sourceFormatVersion = 1;
export const fixedZipTimestamp = new Date(1980, 0, 1, 0, 0, 0, 0);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson(filePath, description) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${description} is not valid JSON: ${filePath} (${error.message})`, {
      cause: error,
    });
  }
}

async function assertDirectory(directoryPath, description) {
  const stats = await lstat(directoryPath);
  assert(
    stats.isDirectory() && !stats.isSymbolicLink(),
    `${description} must be a directory, not a file or symbolic link: ${directoryPath}`,
  );
}

async function listRegularFiles(rootDirectory, description) {
  await assertDirectory(rootDirectory, description);
  const files = [];

  async function visit(directory, relativeDirectory) {
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

function assertSameFileSet(actualFiles, expectedFiles, description) {
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

function md5(contents) {
  return createHash('md5').update(contents).digest('hex');
}

function validateSourceManifest(manifest) {
  assert(
    manifest && typeof manifest === 'object' && !Array.isArray(manifest),
    'sb3-source.json must contain an object.',
  );
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

  const seenEntries = new Set();
  let projectEntryCount = 0;
  for (const entryName of manifest.archiveEntries) {
    validateArchiveEntryName(entryName);
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
  return manifest.archiveEntries.filter((entryName) => entryName !== 'project.json');
}

function validateExtensionManifest(extensionManifest, project, extensionFiles) {
  assert(
    extensionManifest && typeof extensionManifest === 'object' && !Array.isArray(extensionManifest),
    'embedded-extensions.json must contain an object.',
  );
  assert(
    extensionManifest.formatVersion === sourceFormatVersion,
    `Unsupported embedded extension manifest version: ${extensionManifest.formatVersion}`,
  );
  assert(
    Array.isArray(extensionManifest.extensions),
    'embedded-extensions.json extensions must be an array.',
  );

  const extensionUrls = project.extensionURLs ?? {};
  assert(
    extensionUrls && typeof extensionUrls === 'object' && !Array.isArray(extensionUrls),
    'project.source.json extensionURLs must be an object when present.',
  );
  const extensionsById = new Map();
  const expectedFiles = [];

  for (const extension of extensionManifest.extensions) {
    assert(
      extension && typeof extension === 'object' && !Array.isArray(extension),
      'Each embedded extension manifest entry must be an object.',
    );
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
    expectedFiles.push(`${extension.id}.js`);
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
      extensionManifest.extensions,
    ),
    extensions: extensionManifest.extensions,
  };
}

function collectAssetReferences(project) {
  assert(Array.isArray(project.targets), 'project.source.json targets must be an array.');
  const references = [];
  for (const [targetIndex, target] of project.targets.entries()) {
    assert(
      target && typeof target === 'object' && !Array.isArray(target),
      `Project target ${targetIndex} must be an object.`,
    );
    for (const [collectionName, kind] of [
      ['costumes', 'costume'],
      ['sounds', 'sound'],
    ]) {
      const assets = target[collectionName] ?? [];
      assert(
        Array.isArray(assets),
        `Project target ${targetIndex} ${collectionName} must be an array.`,
      );
      for (const [assetIndex, asset] of assets.entries()) {
        assert(
          asset && typeof asset === 'object' && !Array.isArray(asset),
          `Project ${kind} ${targetIndex}:${assetIndex} must be an object.`,
        );
        references.push({asset, description: `${kind} ${targetIndex}:${assetIndex}`});
      }
    }
  }
  return references;
}

function percentEncode(contents) {
  return [...contents]
    .map((byte) => `%${byte.toString(16).padStart(2, '0').toUpperCase()}`)
    .join('');
}

function encodeExtensionDataUrl(extension, contents) {
  const metadata = [extension.mediaType, ...extension.parameters].join(';');
  if (extension.encoding === 'base64') {
    return `data:${metadata};base64,${Buffer.from(contents).toString('base64')}`;
  }
  return `data:${metadata},${percentEncode(contents)}`;
}

async function inspectSb3Source(sourceDirectory, validateManagedExtensions) {
  const resolvedSourceDirectory = path.resolve(sourceDirectory);
  await assertDirectory(resolvedSourceDirectory, 'SB3 source');
  const sourceManifest = await readJson(
    path.join(resolvedSourceDirectory, 'sb3-source.json'),
    'SB3 source manifest',
  );
  const assetEntries = validateSourceManifest(sourceManifest);
  const project = await readJson(
    path.join(resolvedSourceDirectory, sourceManifest.project),
    'SB3 project source',
  );
  assert(
    project && typeof project === 'object' && !Array.isArray(project),
    'project.source.json must contain an object.',
  );
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

  const assetContents = new Map();
  await Promise.all(
    assetFiles.map(async (assetPath) => {
      assetContents.set(assetPath, await readFile(path.join(assetsDirectory, assetPath)));
    }),
  );
  const referencedAssets = new Set();
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

  const extensionContents = new Map();
  await Promise.all(
    extensions.map(async (extension) => {
      const contents = await readFile(path.join(resolvedSourceDirectory, extension.path));
      if (validateManagedExtensions) {
        validateManagedExtensionContents(extension, contents);
      }
      extensionContents.set(extension.id, contents);
    }),
  );

  return {
    assetContents,
    assetReferenceCount: references.length,
    extensions,
    extensionBundles,
    extensionContents,
    project,
    resolvedSourceDirectory,
    sourceManifest,
  };
}

export async function inspectSb3SourceForExtensionSync(sourceDirectory) {
  return inspectSb3Source(sourceDirectory, false);
}

export async function validateSb3Source(sourceDirectory) {
  const source = await inspectSb3Source(sourceDirectory, true);
  buildExtensionBundles({
    extensionBundles: source.extensionBundles,
    extensionContents: source.extensionContents,
    extensions: source.extensions,
    project: source.project,
  });
  return source;
}

export async function createDeterministicSb3(sourceDirectory) {
  const source = await validateSb3Source(sourceDirectory);
  const bundled = buildExtensionBundles({
    extensionBundles: source.extensionBundles,
    extensionContents: source.extensionContents,
    extensions: source.extensions,
    project: source.project,
  });
  const project = structuredClone(bundled.project);
  for (const extension of bundled.extensions) {
    project.extensionURLs[extension.id] = encodeExtensionDataUrl(
      extension,
      bundled.extensionContents.get(extension.id),
    );
  }

  /** @type {Record<string, Uint8Array>} */
  const archiveEntries = {};
  for (const entryName of source.sourceManifest.archiveEntries) {
    archiveEntries[entryName] =
      entryName === 'project.json'
        ? strToU8(`${JSON.stringify(project)}\n`)
        : source.assetContents.get(entryName);
  }
  const archive = zipSync(archiveEntries, {
    level: 6,
    mtime: fixedZipTimestamp,
  });

  return {
    archive,
    assetCount: source.assetContents.size,
    assetReferenceCount: source.assetReferenceCount,
    bundlePlans: bundled.bundlePlans,
    embeddedExtensionCount: bundled.extensions.length,
    entryCount: source.sourceManifest.archiveEntries.length,
    source,
  };
}
