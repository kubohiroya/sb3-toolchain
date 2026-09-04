// SPDX-License-Identifier: MPL-2.0

import {createHash} from 'node:crypto';

import {validateArchiveEntryName} from './archive';
import {assert, errorMessage} from './assert';
import type {EmbeddedExtension, ExtensionApiManifestSource, UnknownRecord} from './types';

export const extensionApiManifestFormatVersion = 1;
export const defaultExtensionApiManifestSizeLimit = 1024 * 1024;

export interface ExtensionApiManifestArgument {
  id: string;
  menu?: string;
  type: string;
}

export interface ExtensionApiManifestBlock {
  arguments: ExtensionApiManifestArgument[];
  blockType: string;
  opcode: string;
}

export interface ExtensionApiManifestMenu {
  acceptReporters: boolean;
  id: string;
}

export interface ExtensionApiManifest {
  blocks: ExtensionApiManifestBlock[];
  formatVersion: number;
  id: string;
  menus: ExtensionApiManifestMenu[];
}

export interface ExtensionApiCompatibilityChange {
  after: unknown;
  before: unknown;
  breaking: boolean;
  kind: string;
  path: string;
}

export interface ValidatedExtensionApiManifest {
  integrity: string;
  manifest: ExtensionApiManifest;
  metadata: ExtensionApiManifestSource;
}

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactProperties(
  value: UnknownRecord,
  expected: string[],
  description: string,
): void {
  const expectedProperties = new Set(expected);
  const unexpected = Object.keys(value).filter((property) => !expectedProperties.has(property));
  assert(
    unexpected.length === 0,
    `${description} has unsupported properties: ${unexpected.join(', ')}`,
  );
}

function assertNonEmptyString(value: unknown, description: string): string {
  assert(
    typeof value === 'string' && value.length > 0,
    `${description} must be a non-empty string.`,
  );
  return value;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

export function extensionApiManifestIntegrity(contents: Uint8Array | string): string {
  return `sha256-${createHash('sha256').update(contents).digest('base64')}`;
}

export function extensionApiManifestLocalPath(extensionId: string): string {
  return `extensions/${extensionId}.manifest.json`;
}

export function validateExtensionApiManifestSourceMetadata(
  extension: EmbeddedExtension,
): ExtensionApiManifestSource | null {
  const metadata: unknown = extension.source?.apiManifest;
  if (metadata === undefined) return null;
  assert(
    isObject(metadata),
    `Managed extension API manifest metadata must be an object: ${extension.id}`,
  );
  assertExactProperties(
    metadata,
    ['artifact', 'formatVersion', 'integrity', 'path'],
    `Managed extension API manifest metadata for ${extension.id}`,
  );
  assert(
    metadata.formatVersion === extensionApiManifestFormatVersion,
    `Managed extension ${extension.id} requires API manifest formatVersion ${extensionApiManifestFormatVersion}.`,
  );
  const artifact = assertNonEmptyString(
    metadata.artifact,
    `Managed extension ${extension.id} API manifest artifact`,
  );
  validateArchiveEntryName(artifact);
  assert(
    !artifact.endsWith('/'),
    `Managed extension API manifest artifact must be a file: ${artifact}`,
  );
  const expectedPath = extensionApiManifestLocalPath(extension.id);
  assert(
    metadata.path === expectedPath,
    `Managed extension API manifest path must match its ID: expected ${expectedPath}, got ${metadata.path}`,
  );
  assert(
    typeof metadata.integrity === 'string' &&
      /^sha256-[A-Za-z0-9+/]{43}=$/u.test(metadata.integrity),
    `Managed extension ${extension.id} API manifest requires SHA-256 integrity.`,
  );
  return metadata as unknown as ExtensionApiManifestSource;
}

function normalizeArgument(
  value: unknown,
  blockOpcode: string,
  index: number,
  menuIds: Set<string>,
): ExtensionApiManifestArgument {
  assert(isObject(value), `API manifest block ${blockOpcode} argument ${index} must be an object.`);
  assertExactProperties(
    value,
    ['id', 'menu', 'type'],
    `API manifest block ${blockOpcode} argument ${index}`,
  );
  const id = assertNonEmptyString(
    value.id,
    `API manifest block ${blockOpcode} argument ${index} ID`,
  );
  const type = assertNonEmptyString(
    value.type,
    `API manifest block ${blockOpcode} argument ${id} type`,
  );
  if (value.menu === undefined) {
    return {id, type};
  }
  const menu = assertNonEmptyString(
    value.menu,
    `API manifest block ${blockOpcode} argument ${id} menu`,
  );
  assert(
    menuIds.has(menu),
    `API manifest block ${blockOpcode} argument ${id} references unknown menu: ${menu}`,
  );
  return {id, menu, type};
}

function normalizeBlock(
  value: unknown,
  index: number,
  menuIds: Set<string>,
): ExtensionApiManifestBlock {
  assert(isObject(value), `API manifest block ${index} must be an object.`);
  assertExactProperties(value, ['arguments', 'blockType', 'opcode'], `API manifest block ${index}`);
  const opcode = assertNonEmptyString(value.opcode, `API manifest block ${index} opcode`);
  const blockType = assertNonEmptyString(value.blockType, `API manifest block ${opcode} blockType`);
  assert(
    Array.isArray(value.arguments),
    `API manifest block ${opcode} arguments must be an array.`,
  );
  const arguments_ = (value.arguments as unknown[]).map((argument, argumentIndex) =>
    normalizeArgument(argument, opcode, argumentIndex, menuIds),
  );
  const argumentIds = new Set<string>();
  for (const argument of arguments_) {
    assert(
      !argumentIds.has(argument.id),
      `API manifest block ${opcode} has duplicate argument ID: ${argument.id}`,
    );
    argumentIds.add(argument.id);
  }
  arguments_.sort((left, right) => compareIds(left.id, right.id));
  return {arguments: arguments_, blockType, opcode};
}

function normalizeMenu(value: unknown, index: number): ExtensionApiManifestMenu {
  assert(isObject(value), `API manifest menu ${index} must be an object.`);
  assertExactProperties(value, ['acceptReporters', 'id'], `API manifest menu ${index}`);
  const id = assertNonEmptyString(value.id, `API manifest menu ${index} ID`);
  assert(
    typeof value.acceptReporters === 'boolean',
    `API manifest menu ${id} acceptReporters must be a boolean.`,
  );
  return {acceptReporters: value.acceptReporters, id};
}

export function parseExtensionApiManifest(
  contents: Uint8Array | string,
  {expectedId}: {expectedId?: string} = {},
): ExtensionApiManifest {
  let manifest: unknown;
  try {
    manifest = JSON.parse(Buffer.from(contents).toString('utf8'));
  } catch (error) {
    throw new Error(`Extension API manifest is not valid JSON: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  assert(isObject(manifest), 'Extension API manifest must contain an object.');
  assertExactProperties(
    manifest,
    ['blocks', 'formatVersion', 'id', 'menus'],
    'Extension API manifest',
  );
  assert(
    manifest.formatVersion === extensionApiManifestFormatVersion,
    `Unsupported extension API manifest formatVersion: ${manifest.formatVersion}`,
  );
  assert(
    typeof manifest.id === 'string' && /^[a-z0-9]+$/u.test(manifest.id),
    `Invalid extension API manifest ID: ${JSON.stringify(manifest.id)}`,
  );
  if (expectedId !== undefined) {
    assert(
      manifest.id === expectedId,
      `Extension API manifest ID mismatch: expected ${expectedId}, got ${manifest.id}`,
    );
  }
  assert(Array.isArray(manifest.menus), 'Extension API manifest menus must be an array.');
  const menus = (manifest.menus as unknown[]).map(normalizeMenu);
  const menuIds = new Set<string>();
  for (const menu of menus) {
    assert(!menuIds.has(menu.id), `Extension API manifest has duplicate menu ID: ${menu.id}`);
    menuIds.add(menu.id);
  }
  assert(Array.isArray(manifest.blocks), 'Extension API manifest blocks must be an array.');
  const blocks = (manifest.blocks as unknown[]).map((block, index) =>
    normalizeBlock(block, index, menuIds),
  );
  const blockOpcodes = new Set<string>();
  for (const block of blocks) {
    assert(
      !blockOpcodes.has(block.opcode),
      `Extension API manifest has duplicate block opcode: ${block.opcode}`,
    );
    blockOpcodes.add(block.opcode);
  }
  blocks.sort((left, right) => compareIds(left.opcode, right.opcode));
  menus.sort((left, right) => compareIds(left.id, right.id));
  return {blocks, formatVersion: extensionApiManifestFormatVersion, id: manifest.id, menus};
}

export function validateManagedExtensionApiManifest(
  extension: EmbeddedExtension,
  contents: Uint8Array | string,
  {expectedId = extension.id}: {expectedId?: string} = {},
): ValidatedExtensionApiManifest | null {
  const metadata = validateExtensionApiManifestSourceMetadata(extension);
  if (!metadata) return null;
  const actualIntegrity = extensionApiManifestIntegrity(contents);
  assert(
    actualIntegrity === metadata.integrity,
    `Managed extension API manifest integrity mismatch for ${extension.id}: ` +
      `expected ${metadata.integrity}, got ${actualIntegrity}`,
  );
  const manifest = parseExtensionApiManifest(contents, {expectedId});
  assert(
    manifest.formatVersion === metadata.formatVersion,
    `Managed extension API manifest version mismatch for ${extension.id}.`,
  );
  return {integrity: actualIntegrity, manifest, metadata};
}

function addChange(
  changes: ExtensionApiCompatibilityChange[],
  kind: string,
  path: string,
  before: unknown,
  after: unknown,
  breaking: boolean,
): void {
  changes.push({after, before, breaking, kind, path});
}

export function compareExtensionApiManifests(
  installed: ExtensionApiManifest,
  candidate: ExtensionApiManifest,
): ExtensionApiCompatibilityChange[] {
  const changes: ExtensionApiCompatibilityChange[] = [];
  const installedBlocks = new Map(installed.blocks.map((block) => [block.opcode, block]));
  const candidateBlocks = new Map(candidate.blocks.map((block) => [block.opcode, block]));
  for (const [opcode, block] of installedBlocks) {
    const path = `/blocks/${escapeJsonPointer(opcode)}`;
    const replacement = candidateBlocks.get(opcode);
    if (!replacement) {
      addChange(changes, 'block-removed', path, block, null, true);
      continue;
    }
    if (block.blockType !== replacement.blockType) {
      addChange(
        changes,
        'block-type-changed',
        `${path}/blockType`,
        block.blockType,
        replacement.blockType,
        true,
      );
    }
    const installedArguments = new Map(block.arguments.map((argument) => [argument.id, argument]));
    const candidateArguments = new Map(
      replacement.arguments.map((argument) => [argument.id, argument]),
    );
    for (const [argumentId, argument] of installedArguments) {
      const argumentPath = `${path}/arguments/${escapeJsonPointer(argumentId)}`;
      const replacementArgument = candidateArguments.get(argumentId);
      if (!replacementArgument) {
        addChange(changes, 'argument-removed', argumentPath, argument, null, true);
        continue;
      }
      for (const property of ['type', 'menu'] as const) {
        if (argument[property] !== replacementArgument[property]) {
          addChange(
            changes,
            `argument-${property}-changed`,
            `${argumentPath}/${property}`,
            argument[property] ?? null,
            replacementArgument[property] ?? null,
            true,
          );
        }
      }
    }
    for (const [argumentId, argument] of candidateArguments) {
      if (!installedArguments.has(argumentId)) {
        addChange(
          changes,
          'argument-added',
          `${path}/arguments/${escapeJsonPointer(argumentId)}`,
          null,
          argument,
          true,
        );
      }
    }
  }
  for (const [opcode, block] of candidateBlocks) {
    if (!installedBlocks.has(opcode)) {
      addChange(changes, 'block-added', `/blocks/${escapeJsonPointer(opcode)}`, null, block, false);
    }
  }

  const installedMenus = new Map(installed.menus.map((menu) => [menu.id, menu]));
  const candidateMenus = new Map(candidate.menus.map((menu) => [menu.id, menu]));
  const referencedInstalledMenus = new Set<string>();
  for (const block of installed.blocks) {
    for (const argument of block.arguments) {
      if (argument.menu !== undefined) referencedInstalledMenus.add(argument.menu);
    }
  }
  for (const [menuId, menu] of installedMenus) {
    const path = `/menus/${escapeJsonPointer(menuId)}`;
    const replacement = candidateMenus.get(menuId);
    if (!replacement) {
      addChange(changes, 'menu-removed', path, menu, null, referencedInstalledMenus.has(menuId));
    } else if (menu.acceptReporters !== replacement.acceptReporters) {
      addChange(
        changes,
        'menu-accept-reporters-changed',
        `${path}/acceptReporters`,
        menu.acceptReporters,
        replacement.acceptReporters,
        true,
      );
    }
  }
  for (const [menuId, menu] of candidateMenus) {
    if (!installedMenus.has(menuId)) {
      addChange(changes, 'menu-added', `/menus/${escapeJsonPointer(menuId)}`, null, menu, false);
    }
  }
  return changes.sort((left, right) =>
    left.path === right.path
      ? compareIds(left.kind, right.kind)
      : compareIds(left.path, right.path),
  );
}

export function formatExtensionApiCompatibilityChanges(
  extensionId: string,
  changes: ExtensionApiCompatibilityChange[],
): string {
  return changes
    .map(
      (change) =>
        `${extensionId} ${change.breaking ? 'breaking' : 'compatible'} ${change.kind} ${change.path}`,
    )
    .join('\n');
}
