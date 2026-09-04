// SPDX-License-Identifier: MPL-2.0

import {createHash} from 'node:crypto';

import {validateArchiveEntryName} from './archive';
import {assert} from './assert';
import {validateExtensionApiManifestSourceMetadata} from './extension-api-manifest';
import type {EmbeddedExtension, ExtensionSource} from './types';

export interface ExtensionHeaderMetadata {
  author: string | null;
  description: string | null;
  id: string | null;
  license: string | null;
  name: string | null;
}

export interface ManagedExtensionContents {
  actualId: string | null;
  integrity: string;
  source: ExtensionSource;
}

export function extensionIntegrity(contents: Uint8Array | string): string {
  return `sha256-${createHash('sha256').update(contents).digest('base64')}`;
}

export function extensionHeaderId(contents: Uint8Array | string): string | null {
  return extensionHeaderMetadata(contents).id;
}

export function extensionHeaderMetadata(contents: Uint8Array | string): ExtensionHeaderMetadata {
  const source = Buffer.from(contents).toString('utf8');
  const readField = (field: string): string | null =>
    source.match(new RegExp(`^// ${field}: (.+)\\r?$`, 'mu'))?.[1]?.trim() ?? null;
  const id = readField('ID');
  return {
    author: readField('By'),
    description: readField('Description'),
    id: id && /^[A-Za-z0-9._-]+$/u.test(id) ? id : null,
    license: readField('License'),
    name: readField('Name'),
  };
}

export function validateExtensionSourceMetadata(
  extension: EmbeddedExtension,
): ExtensionSource | null {
  if (extension.source === undefined) {
    return null;
  }

  const source = extension.source as unknown as Record<string, unknown> | undefined;
  assert(
    source && typeof source === 'object' && !Array.isArray(source),
    `Managed extension source must be an object: ${extension.id}`,
  );
  if (source.provider === 'github') {
    assert(
      typeof source.repository === 'string' &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+$/u.test(source.repository),
      `Invalid GitHub repository for extension ${extension.id}: ${source.repository}`,
    );
    assert(
      typeof source.ref === 'string' &&
        source.ref.length > 0 &&
        !/[\u0000-\u0020\u007f]/u.test(source.ref),
      `Invalid Git ref for extension ${extension.id}: ${source.ref}`,
    );
    assert(
      typeof source.resolvedCommit === 'string' && /^[a-f0-9]{40}$/u.test(source.resolvedCommit),
      `Managed extension ${extension.id} requires a 40-character resolvedCommit.`,
    );
  } else if (source.provider === 'npm') {
    assert(
      typeof source.package === 'string' &&
        /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(source.package),
      `Invalid npm package for extension ${extension.id}: ${source.package}`,
    );
    assert(
      typeof source.version === 'string' &&
        /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(source.version),
      `Managed npm extension ${extension.id} requires an exact semantic version.`,
    );
  } else {
    throw new Error(
      `Unsupported extension source provider for ${extension.id}: ${source.provider}`,
    );
  }
  assert(
    typeof source.artifact === 'string' && source.artifact.length > 0,
    `Managed extension ${extension.id} requires an artifact path.`,
  );
  validateArchiveEntryName(source.artifact);
  assert(
    !source.artifact.endsWith('/'),
    `Managed extension artifact must be a file: ${source.artifact}`,
  );
  assert(
    typeof source.integrity === 'string' && /^sha256-[A-Za-z0-9+/]{43}=$/u.test(source.integrity),
    `Managed extension ${extension.id} requires SHA-256 integrity.`,
  );
  validateExtensionApiManifestSourceMetadata(extension);
  return source as unknown as ExtensionSource;
}

export function validateManagedExtensionContents(
  extension: EmbeddedExtension,
  contents: Uint8Array | string,
): ManagedExtensionContents | null {
  const source = validateExtensionSourceMetadata(extension);
  if (!source) {
    return null;
  }

  const actualIntegrity = extensionIntegrity(contents);
  assert(
    actualIntegrity === source.integrity,
    `Managed extension integrity mismatch for ${extension.id}: ` +
      `expected ${source.integrity}, got ${actualIntegrity}`,
  );
  const actualId = extensionHeaderId(contents);
  assert(
    actualId === extension.id,
    `Managed extension header ID mismatch for ${extension.id}: ` +
      `expected ${extension.id}, got ${actualId ?? '(missing)'}`,
  );
  return {actualId, integrity: actualIntegrity, source};
}
