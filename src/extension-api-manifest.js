// SPDX-License-Identifier: MPL-2.0

import {createHash} from 'node:crypto';

import {validateArchiveEntryName} from './archive.js';

export const extensionApiManifestFormatVersion = 1;
export const defaultExtensionApiManifestSizeLimit = 1024 * 1024;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function assertExactProperties(value, expected, description) {
  const expectedProperties = new Set(expected);
  const unexpected = Object.keys(value).filter((property) => !expectedProperties.has(property));
  assert(
    unexpected.length === 0,
    `${description} has unsupported properties: ${unexpected.join(', ')}`,
  );
}

function assertNonEmptyString(value, description) {
  assert(
    typeof value === 'string' && value.length > 0,
    `${description} must be a non-empty string.`,
  );
  return value;
}

function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeJsonPointer(value) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

export function extensionApiManifestIntegrity(contents) {
  return `sha256-${createHash('sha256').update(contents).digest('base64')}`;
}

export function extensionApiManifestLocalPath(extensionId) {
  return `extensions/${extensionId}.manifest.json`;
}

export function validateExtensionApiManifestSourceMetadata(extension) {
  const metadata = extension.source?.apiManifest;
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
  assertNonEmptyString(
    metadata.artifact,
    `Managed extension ${extension.id} API manifest artifact`,
  );
  validateArchiveEntryName(metadata.artifact);
  assert(
    !metadata.artifact.endsWith('/'),
    `Managed extension API manifest artifact must be a file: ${metadata.artifact}`,
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
  return metadata;
}

function normalizeArgument(value, blockOpcode, index, menuIds) {
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
  if (value.menu !== undefined) {
    assertNonEmptyString(value.menu, `API manifest block ${blockOpcode} argument ${id} menu`);
    assert(
      menuIds.has(value.menu),
      `API manifest block ${blockOpcode} argument ${id} references unknown menu: ${value.menu}`,
    );
  }
  return value.menu === undefined ? {id, type} : {id, menu: value.menu, type};
}

function normalizeBlock(value, index, menuIds) {
  assert(isObject(value), `API manifest block ${index} must be an object.`);
  assertExactProperties(value, ['arguments', 'blockType', 'opcode'], `API manifest block ${index}`);
  const opcode = assertNonEmptyString(value.opcode, `API manifest block ${index} opcode`);
  const blockType = assertNonEmptyString(value.blockType, `API manifest block ${opcode} blockType`);
  assert(
    Array.isArray(value.arguments),
    `API manifest block ${opcode} arguments must be an array.`,
  );
  const arguments_ = value.arguments.map((argument, argumentIndex) =>
    normalizeArgument(argument, opcode, argumentIndex, menuIds),
  );
  const argumentIds = new Set();
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

function normalizeMenu(value, index) {
  assert(isObject(value), `API manifest menu ${index} must be an object.`);
  assertExactProperties(value, ['acceptReporters', 'id'], `API manifest menu ${index}`);
  const id = assertNonEmptyString(value.id, `API manifest menu ${index} ID`);
  assert(
    typeof value.acceptReporters === 'boolean',
    `API manifest menu ${id} acceptReporters must be a boolean.`,
  );
  return {acceptReporters: value.acceptReporters, id};
}

/**
 * @param {string | Uint8Array} contents
 * @param {{expectedId?: string}} [options]
 */
export function parseExtensionApiManifest(contents, {expectedId} = {}) {
  let manifest;
  try {
    manifest = JSON.parse(Buffer.from(contents).toString('utf8'));
  } catch (error) {
    throw new Error(`Extension API manifest is not valid JSON: ${error.message}`, {cause: error});
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
  const menus = manifest.menus.map(normalizeMenu);
  const menuIds = new Set();
  for (const menu of menus) {
    assert(!menuIds.has(menu.id), `Extension API manifest has duplicate menu ID: ${menu.id}`);
    menuIds.add(menu.id);
  }
  assert(Array.isArray(manifest.blocks), 'Extension API manifest blocks must be an array.');
  const blocks = manifest.blocks.map((block, index) => normalizeBlock(block, index, menuIds));
  const blockOpcodes = new Set();
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
  extension,
  contents,
  {expectedId = extension.id} = {},
) {
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

function addChange(changes, kind, path, before, after, breaking) {
  changes.push({after, before, breaking, kind, path});
}

export function compareExtensionApiManifests(installed, candidate) {
  const changes = [];
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
      for (const property of ['type', 'menu']) {
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
  for (const [menuId, menu] of installedMenus) {
    const path = `/menus/${escapeJsonPointer(menuId)}`;
    const replacement = candidateMenus.get(menuId);
    if (!replacement) {
      addChange(changes, 'menu-removed', path, menu, null, true);
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

export function formatExtensionApiCompatibilityChanges(extensionId, changes) {
  return changes
    .map(
      (change) =>
        `${extensionId} ${change.breaking ? 'breaking' : 'compatible'} ${change.kind} ${change.path}`,
    )
    .join('\n');
}
