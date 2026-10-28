// SPDX-License-Identifier: MPL-2.0

import {assert} from './assert';
import type {ExtensionBundleMetadata} from './types';

const textFields = [
  'description',
  'author',
  'authorURL',
  'version',
  'updatedAt',
  'repository',
  'docsURL',
  'banner',
  'package',
] as const;

function singleLine(value: unknown, field: string): string {
  assert(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 1000 &&
      value === value.trim() &&
      !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value),
    `Bundle metadata ${field} must be a non-empty single line of at most 1000 characters.`,
  );
  return value;
}

function externalUrl(value: string, field: string, protocols = ['https:']): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Bundle metadata ${field} must be an absolute URL.`);
  }
  assert(
    protocols.includes(url.protocol) && url.hostname && !url.username && !url.password,
    `Bundle metadata ${field} must use ${protocols.join(' or ')} without credentials.`,
  );
  return value;
}

function bannerUrl(value: string): string {
  if (!/^data:/iu.test(value)) return externalUrl(value, 'banner');
  const match =
    /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)(?:;charset=utf-8)?(;base64)?,(.+)$/iu.exec(value);
  assert(
    match && !/%(?![\da-f]{2})/iu.test(match[2]),
    'Invalid bundle metadata banner image data URL.',
  );
  if (match[1]) {
    let payload: string;
    try {
      payload = decodeURIComponent(match[2]);
    } catch {
      throw new Error('Invalid bundle metadata banner base64 data URL.');
    }
    assert(
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(payload) &&
        Buffer.from(payload, 'base64').length > 0,
      'Invalid bundle metadata banner base64 data URL.',
    );
  }
  const comma = value.indexOf(',');
  return value.slice(0, comma).toLowerCase() + value.slice(comma);
}

/** No owner, package, link, license, or permission is inferred from the first bundle member. */
export function validateExtensionBundleMetadata(value: unknown): ExtensionBundleMetadata {
  assert(
    value &&
      typeof value === 'object' &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)),
    'Bundle metadata must be an object.',
  );
  const record = value as Record<string, unknown>;
  const metadata: ExtensionBundleMetadata = {};
  for (const key of Object.keys(record)) {
    assert(
      key === 'descriptions' || (textFields as readonly string[]).includes(key),
      `Unknown bundle metadata field: ${key}`,
    );
  }
  for (const field of textFields) {
    if (record[field] === undefined) continue;
    let text = singleLine(record[field], field);
    if (field === 'authorURL') text = externalUrl(text, field, ['https:', 'http:']);
    if (field === 'repository' || field === 'docsURL') text = externalUrl(text, field);
    if (field === 'banner') text = bannerUrl(text);
    if (field === 'package') {
      assert(
        text.length <= 214 &&
          /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(text) &&
          !['node_modules', 'favicon.ico'].includes(text),
        'Invalid bundle metadata npm package name.',
      );
    }
    metadata[field] = text;
  }
  assert(
    !metadata.authorURL || metadata.author,
    'Bundle metadata authorURL requires an explicit author.',
  );
  if (record.descriptions !== undefined) {
    assert(
      record.descriptions &&
        typeof record.descriptions === 'object' &&
        [Object.prototype, null].includes(Object.getPrototypeOf(record.descriptions)),
      'Bundle metadata descriptions must be an object.',
    );
    metadata.descriptions = {};
    for (const [locale, text] of Object.entries(record.descriptions).sort(([a], [b]) =>
      a.localeCompare(b, 'en'),
    )) {
      assert(
        /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u.test(locale),
        `Invalid bundle metadata locale: ${locale}`,
      );
      metadata.descriptions[locale] = singleLine(text, `descriptions.${locale}`);
    }
  }
  return metadata;
}
