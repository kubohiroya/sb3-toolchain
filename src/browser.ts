// SPDX-License-Identifier: MPL-2.0

import {md5} from '@noble/hashes/legacy.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import {strFromU8} from 'fflate';

import {validateArchiveEntryName} from './archive';
import {assert, errorMessage} from './assert';
import {expandArchive, formatSourceFiles, Sb3SourceError} from './expand-archive';
import {
  assertSameFileSet,
  collectSourceAssetReferences,
  isObject,
  validateExtensionLayout,
  validateSourceManifest,
} from './source-format';
import type {ProjectJson} from './types';

export {Sb3SourceError} from './expand-archive';
export type {Sb3SourceErrorCode} from './expand-archive';
export {packageVersion} from './constants';

export interface UnpackWarning {
  code: 'directory-entry' | 'unreferenced-asset';
  path: string;
}

export interface UnpackedSb3 {
  files: Map<string, Uint8Array>;
  warnings: UnpackWarning[];
}

const archiveLimits = {
  maxArchiveBytes: 100 * 1024 * 1024,
  maxEntryBytes: 100 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
  maxEntries: 20_000,
};

function validateEditorProject(project: ProjectJson) {
  if (project.turboWarpPlus !== undefined) {
    throw new Sb3SourceError(
      'unsupported-project',
      'Plus extension manifests are not supported in project folders.',
    );
  }
  assert(Array.isArray(project.targets), 'Missing project targets.');
  const targetNames = new Set<string>();
  let stages = 0;
  for (const target of project.targets) {
    assert(
      isObject(target) && typeof target.isStage === 'boolean' && typeof target.name === 'string',
      'Invalid project target.',
    );
    if (target.isStage) {
      stages++;
    } else {
      assert(!targetNames.has(target.name), `Duplicate sprite name: ${target.name}`);
      targetNames.add(target.name);
    }
    assert(target.blocks === undefined || isObject(target.blocks), 'Invalid target blocks.');
    assert(target.comments === undefined || isObject(target.comments), 'Invalid target comments.');
  }
  assert(stages === 1, 'Expected exactly one stage.');
  assert(
    project.extensionURLs === undefined ||
      (isObject(project.extensionURLs) &&
        Object.values(project.extensionURLs).every((url) => typeof url === 'string')),
    'Invalid project extensionURLs.',
  );
}

function validatedAssetReferences(project: ProjectJson) {
  try {
    validateEditorProject(project);
    return collectSourceAssetReferences(project);
  } catch (cause) {
    if (cause instanceof Sb3SourceError) throw cause;
    throw new Sb3SourceError('invalid-project', errorMessage(cause), {cause});
  }
}

/** Validate the layout and asset bytes of a project folder in memory. */
export function validateSourceFiles(files: ReadonlyMap<string, Uint8Array>): void {
  const json = (filename: string): unknown => {
    const bytes = files.get(filename);
    assert(bytes, `Missing source file: ${filename}`);
    return JSON.parse(strFromU8(bytes));
  };

  try {
    const manifest = json('sb3-source.json');
    validateSourceManifest(manifest);
    const project = json(manifest.project);
    assert(isObject(project), 'project.source.json must contain an object.');
    const references = validatedAssetReferences(project);

    const assetEntries = manifest.archiveEntries.filter((name) => name !== 'project.json');
    assertSameFileSet(
      assetEntries,
      references.map(({filename}) => filename),
      'Asset manifest',
    );
    const seen = new Set<string>();
    for (const {filename, description} of references) {
      if (seen.has(filename)) continue;
      seen.add(filename);
      const asset = files.get(`assets/${filename}`);
      if (!asset) {
        throw new Sb3SourceError(
          'missing-asset',
          `Referenced asset is missing for ${description}: ${filename}`,
        );
      }
      if (bytesToHex(md5(asset)) !== filename.slice(0, 32)) {
        throw new Sb3SourceError(
          'invalid-asset',
          `Asset content hash mismatch for ${description}: ${filename}`,
        );
      }
    }

    const extensionFiles: string[] = [];
    const expected = new Set([
      'sb3-source.json',
      manifest.project,
      manifest.embeddedExtensions,
      ...assetEntries.map((name) => `assets/${name}`),
    ]);
    for (const name of files.keys()) {
      try {
        validateArchiveEntryName(name);
      } catch (cause) {
        throw new Sb3SourceError('unsafe-path', errorMessage(cause), {cause});
      }
      if (name.startsWith('extensions/')) {
        extensionFiles.push(name.slice('extensions/'.length));
      } else {
        assert(expected.has(name), `Unexpected source file: ${name}`);
      }
    }
    try {
      validateExtensionLayout(json(manifest.embeddedExtensions), project, extensionFiles);
    } catch (cause) {
      throw new Sb3SourceError('invalid-extension', errorMessage(cause), {cause});
    }
  } catch (cause) {
    if (cause instanceof Sb3SourceError) throw cause;
    throw new Sb3SourceError('invalid-source', errorMessage(cause), {cause});
  }
}

/** Expand an SB3 into files suitable for opening as an Editor project folder. */
export function unpackSb3(bytes: Uint8Array): UnpackedSb3 {
  const expanded = expandArchive(bytes, archiveLimits);
  const references = new Set(
    validatedAssetReferences(expanded.project).map(({filename}) => filename),
  );
  for (const name of references) {
    if (!expanded.assets.has(name)) {
      throw new Sb3SourceError('missing-asset', `Referenced asset is missing: ${name}`);
    }
  }
  const warnings: UnpackWarning[] = [];
  expanded.archiveEntries = expanded.archiveEntries.filter((name) => {
    if (name === 'project.json' || references.has(name)) return true;
    if (name.endsWith('/')) {
      warnings.push({code: 'directory-entry', path: name});
    } else if (/^[a-f0-9]{32}\.[A-Za-z0-9]+$/u.test(name)) {
      expanded.assets.delete(name);
      warnings.push({code: 'unreferenced-asset', path: name});
    } else {
      throw new Sb3SourceError('unsupported-project', `Unsupported SB3 attachment: ${name}`);
    }
    return false;
  });
  const files = formatSourceFiles(expanded);
  validateSourceFiles(files);
  return {files, warnings};
}
