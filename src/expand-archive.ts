// SPDX-License-Identifier: MPL-2.0

import {strFromU8, strToU8, unzipSync} from 'fflate';

import {validateArchiveEntryName} from './archive';
import {assert, errorMessage} from './assert';
import {isObject, sourceFormatVersion} from './source-format';
import type {EmbeddedExtension, ExtensionEncoding, ProjectJson} from './types';

export type Sb3SourceErrorCode =
  | 'invalid-archive'
  | 'archive-limit'
  | 'unsafe-path'
  | 'invalid-project'
  | 'invalid-extension'
  | 'missing-asset'
  | 'invalid-asset'
  | 'invalid-source'
  | 'unsupported-project';

export class Sb3SourceError extends Error {
  constructor(
    readonly code: Sb3SourceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'Sb3SourceError';
  }
}

interface ArchiveLimits {
  maxArchiveBytes: number;
  maxEntryBytes: number;
  maxEntries: number;
  maxExpandedBytes: number;
}

interface ExpandedArchive {
  archiveEntries: string[];
  assets: Map<string, Uint8Array>;
  embeddedExtensions: EmbeddedExtension[];
  extensionFiles: Map<string, Uint8Array>;
  project: ProjectJson;
}

export function decodeExtensionBytes(dataUrl: unknown): {
  encoding: ExtensionEncoding;
  mediaType: string;
  parameters: string[];
  source: Uint8Array;
} {
  assert(
    typeof dataUrl === 'string' && dataUrl.startsWith('data:'),
    'Embedded extension URL must be a data URL.',
  );
  const commaIndex = dataUrl.indexOf(',');
  assert(commaIndex >= 0, 'Embedded extension data URL has no payload separator.');

  const metadata = dataUrl.slice('data:'.length, commaIndex).split(';');
  const mediaType = metadata.shift() || 'text/plain';
  const base64Index = metadata.indexOf('base64');
  const encoding: ExtensionEncoding = base64Index >= 0 ? 'base64' : 'percent';
  if (base64Index >= 0) metadata.splice(base64Index, 1);

  const payload = dataUrl.slice(commaIndex + 1);
  let source: Uint8Array;
  if (encoding === 'base64') {
    assert(
      /^[A-Za-z0-9+/]*={0,2}$/u.test(payload),
      'Embedded extension data URL contains invalid base64.',
    );
    const unpaddedPayload = payload.replace(/=+$/u, '');
    assert(
      unpaddedPayload.length % 4 !== 1,
      'Embedded extension data URL contains invalid base64.',
    );
    const padded = unpaddedPayload.padEnd(Math.ceil(unpaddedPayload.length / 4) * 4, '=');
    source = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } else {
    try {
      source = strToU8(decodeURIComponent(payload));
    } catch {
      throw new Error('Embedded extension data URL contains invalid percent encoding.');
    }
  }

  return {encoding, mediaType, parameters: metadata, source};
}

/** Parse and extract the archive once. Callers choose the rules for extra ZIP entries. */
export function expandArchive(bytes: Uint8Array, limits?: ArchiveLimits): ExpandedArchive {
  if (limits && bytes.byteLength > limits.maxArchiveBytes) {
    throw new Sb3SourceError('archive-limit', 'SB3 exceeds the maximum archive size.');
  }

  const seen = new Set<string>();
  let expandedBytes = 0;
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes, {
      filter({name, originalSize}) {
        try {
          validateArchiveEntryName(name);
        } catch (cause) {
          throw new Sb3SourceError('unsafe-path', errorMessage(cause), {cause});
        }
        if (seen.has(name)) {
          throw new Sb3SourceError('invalid-archive', `Duplicate SB3 archive entry: ${name}`);
        }
        seen.add(name);
        expandedBytes += originalSize;
        if (
          limits &&
          (seen.size > limits.maxEntries ||
            originalSize > limits.maxEntryBytes ||
            expandedBytes > limits.maxExpandedBytes)
        ) {
          throw new Sb3SourceError('archive-limit', 'Expanded SB3 exceeds the archive limits.');
        }
        return true;
      },
    });
  } catch (cause) {
    if (cause instanceof Sb3SourceError) throw cause;
    throw new Sb3SourceError(
      'invalid-archive',
      `SB3 archive is not a valid ZIP: ${errorMessage(cause)}`,
      {cause},
    );
  }
  const archiveEntries = Object.keys(archive);
  if (archiveEntries.length === 0) {
    throw new Sb3SourceError('invalid-archive', 'SB3 archive is empty.');
  }
  if (archiveEntries.length !== seen.size) {
    throw new Sb3SourceError('invalid-archive', 'SB3 archive contains an unsupported entry name.');
  }

  const projectEntry = archive['project.json'];
  if (!projectEntry) {
    throw new Sb3SourceError('invalid-project', 'SB3 archive does not contain project.json.');
  }
  let project: unknown;
  try {
    project = JSON.parse(strFromU8(projectEntry));
  } catch (cause) {
    throw new Sb3SourceError(
      'invalid-project',
      `SB3 project.json is invalid JSON: ${errorMessage(cause)}`,
      {cause},
    );
  }
  if (!isObject(project)) {
    throw new Sb3SourceError('invalid-project', 'SB3 project.json must contain a JSON object.');
  }

  const extensionUrls: unknown = project.extensionURLs ?? {};
  if (!isObject(extensionUrls)) {
    throw new Sb3SourceError(
      'invalid-project',
      'SB3 project.json extensionURLs must be an object when present.',
    );
  }
  const embeddedExtensions: EmbeddedExtension[] = [];
  const extensionFiles = new Map<string, Uint8Array>();
  for (const [extensionId, extensionUrl] of Object.entries(extensionUrls)) {
    if (typeof extensionUrl !== 'string' || !extensionUrl.startsWith('data:')) continue;
    if (!/^[A-Za-z0-9._-]+$/u.test(extensionId)) {
      throw new Sb3SourceError(
        'unsafe-path',
        `Embedded extension ID cannot be used as a filename: ${JSON.stringify(extensionId)}`,
      );
    }
    try {
      const {source, ...metadata} = decodeExtensionBytes(extensionUrl);
      const path = `extensions/${extensionId}.js`;
      extensionUrls[extensionId] = `embedded-extension:${path}`;
      embeddedExtensions.push({
        id: extensionId,
        path,
        mediaType: metadata.mediaType,
        parameters: metadata.parameters,
        encoding: metadata.encoding,
      });
      extensionFiles.set(path, source);
    } catch (cause) {
      throw new Sb3SourceError('invalid-extension', errorMessage(cause), {cause});
    }
  }

  const assets = new Map<string, Uint8Array>();
  for (const name of archiveEntries) {
    if (name !== 'project.json' && !name.endsWith('/')) assets.set(name, archive[name]);
  }
  return {archiveEntries, assets, embeddedExtensions, extensionFiles, project};
}

export function formatSourceFiles({
  archiveEntries,
  assets,
  embeddedExtensions,
  extensionFiles,
  project,
}: ExpandedArchive): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const [name, bytes] of assets) files.set(`assets/${name}`, bytes);
  for (const [name, bytes] of extensionFiles) files.set(name, bytes);

  const documents = {
    'project.source.json': project,
    'embedded-extensions.json': {
      formatVersion: sourceFormatVersion,
      extensions: embeddedExtensions,
    },
    'sb3-source.json': {
      formatVersion: sourceFormatVersion,
      project: 'project.source.json',
      embeddedExtensions: 'embedded-extensions.json',
      assetsDirectory: 'assets',
      archiveEntries,
    },
  };
  for (const [name, value] of Object.entries(documents)) {
    files.set(name, strToU8(`${JSON.stringify(value, null, 2)}\n`));
  }
  return files;
}
