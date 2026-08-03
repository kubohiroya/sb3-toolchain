// SPDX-License-Identifier: MPL-2.0

import {createHash} from 'node:crypto';

import {validateArchiveEntryName} from './archive.js';
import {validateExtensionApiManifestSourceMetadata} from './extension-api-manifest.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function extensionIntegrity(contents) {
  return `sha256-${createHash('sha256').update(contents).digest('base64')}`;
}

export function extensionHeaderId(contents) {
  return extensionHeaderMetadata(contents).id;
}

export function extensionHeaderMetadata(contents) {
  const source = Buffer.from(contents).toString('utf8');
  const readField = (field) =>
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

export function validateExtensionSourceMetadata(extension) {
  if (extension.source === undefined) {
    return null;
  }

  const source = extension.source;
  assert(
    source && typeof source === 'object' && !Array.isArray(source),
    `Managed extension source must be an object: ${extension.id}`,
  );
  assert(
    source.provider === 'github',
    `Unsupported extension source provider for ${extension.id}: ${source.provider}`,
  );
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
  return source;
}

export function validateManagedExtensionContents(extension, contents) {
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
