// SPDX-License-Identifier: MPL-2.0

import {validateArchiveEntryName} from './archive';
import {assert} from './assert';
import type {
  EmbeddedExtension,
  ProjectAssetReference,
  ProjectJson,
  Sb3SourceManifest,
  UnknownRecord,
} from './types';

export const sourceFormatVersion = 1;

export function isObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertSameFileSet(
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

export function validateSourceManifest(manifest: unknown): asserts manifest is Sb3SourceManifest {
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

export function validateExtensionLayout(
  extensionManifest: unknown,
  project: ProjectJson,
  extensionFiles: string[],
  validateManagedSource?: (extension: EmbeddedExtension) => unknown,
): {extensionBundles: unknown; extensions: EmbeddedExtension[]} {
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
    if (extension.source !== undefined) {
      assert(isObject(extension.source), `Invalid source for embedded extension ${extension.id}.`);
      const sidecar = extension.source.apiManifest;
      assert(
        sidecar === undefined ||
          (isObject(sidecar) && sidecar.path === `extensions/${extension.id}.manifest.json`),
        `Invalid API manifest path for embedded extension ${extension.id}.`,
      );
    }
    validateManagedSource?.(extension);
    extensionsById.set(extension.id, extension);
    extensions.push(extension);
    expectedFiles.push(`${extension.id}.js`);
    if (extension.source?.apiManifest) {
      expectedFiles.push(extension.source.apiManifest.path.slice('extensions/'.length));
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
    extensionBundles: extensionManifest.extensionBundles,
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
  const fonts = project.customFonts ?? [];
  assert(Array.isArray(fonts), 'project.source.json customFonts must be an array.');
  for (const [index, font] of fonts.entries()) {
    if (!isObject(font) || font.system !== false || font.md5ext === undefined) continue;
    const md5ext = font.md5ext;
    const match = typeof md5ext === 'string' && /^([a-f0-9]{32})\.(ttf|otf|woff2?)$/u.exec(md5ext);
    assert(match, `Invalid font asset reference for font ${index}: ${md5ext}`);
    const [, assetId, dataFormat] = match;
    references.push({asset: {assetId, dataFormat, md5ext}, description: `font ${index}`});
  }
  return references;
}

export function collectSourceAssetReferences(
  project: ProjectJson,
): {filename: string; description: string}[] {
  return collectAssetReferences(project).map(({asset, description}) => {
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
    return {filename: expectedFilename, description};
  });
}
