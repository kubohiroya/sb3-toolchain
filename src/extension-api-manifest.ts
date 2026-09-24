// SPDX-License-Identifier: MPL-2.0

import {createHash} from 'node:crypto';

import {validateArchiveEntryName} from './archive';
import {assert, errorMessage} from './assert';
import type {EmbeddedExtension, ExtensionApiManifestSource, UnknownRecord} from './types';

/** The version assumed when none is recorded; version 2 is also supported. */
export const extensionApiManifestFormatVersion = 1;
export const extensionApiManifestFormatVersions = [1, 2] as const;
export const defaultExtensionApiManifestSizeLimit = 1024 * 1024;

/**
 * Version 2 carries the metadata a server-side compiler needs to lower a block into its own IR.
 *
 * These vocabularies match `@kubohiroya/turbowarp-extension-manifest`, which produces the manifests,
 * and the compiler manifest reader in `turbowarp-http-server`, which consumes them. A value accepted
 * here but rejected there would let an unusable extension through an update.
 */
export const extensionApiManifestResultTypes = [
  'json',
  'boolean',
  'number',
  'string',
  'void',
  // A string whose content is serialized JSON or YAML, which `string` alone would not record.
  'jsonText',
  'yamlText',
] as const;
export const extensionApiManifestEffects = [
  'pure',
  'immutable',
  'control',
  'request-read',
  'response-write',
  'storage-read',
  'storage-write',
  'binary-read',
  'binary-write',
  'state',
] as const;

export type ExtensionApiManifestFormatVersion = (typeof extensionApiManifestFormatVersions)[number];
export type ExtensionApiManifestResultType = (typeof extensionApiManifestResultTypes)[number];
export type ExtensionApiManifestEffect = (typeof extensionApiManifestEffects)[number];

export interface ExtensionApiManifestServer {
  irOperation?: string;
  supported: boolean;
}

export interface ExtensionApiManifestArgument {
  id: string;
  maximum?: number;
  menu?: string;
  minimum?: number;
  normalizesTo?: 'pathSegments';
  staticLiteral?: boolean;
  type: string;
}

export interface ExtensionApiManifestBlock {
  arguments: ExtensionApiManifestArgument[];
  blockType: string;
  effect?: ExtensionApiManifestEffect;
  errors?: string[];
  immutable?: boolean;
  opcode: string;
  resultType?: ExtensionApiManifestResultType;
  server?: ExtensionApiManifestServer;
}

export interface ExtensionApiManifestMenu {
  acceptReporters: boolean;
  id: string;
}

export interface ExtensionApiManifestPathSegmentType {
  kind: 'discriminatedUnion';
  variants: {kind: string; valueType: string}[];
}

export interface ExtensionApiManifestDataReferenceType {
  kind: string;
  lifetime: string;
  scope: string;
  valueType: string;
}

export interface ExtensionApiManifest {
  blocks: ExtensionApiManifestBlock[];
  /** Version 2 only: what the values this extension hands out refer to, and for how long. */
  dataReferenceType?: ExtensionApiManifestDataReferenceType;
  formatVersion: number;
  id: string;
  menus: ExtensionApiManifestMenu[];
  /** Version 2 only: how a compiler should read the path arguments this extension takes. */
  pathSegmentType?: ExtensionApiManifestPathSegmentType;
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

export interface ExtensionApiManifestParseSuccess {
  error: null;
  manifest: ExtensionApiManifest;
}

export interface ExtensionApiManifestParseFailure {
  error: string;
  manifest: null;
}

export type ExtensionApiManifestParseResult =
  ExtensionApiManifestParseSuccess | ExtensionApiManifestParseFailure;

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
    extensionApiManifestFormatVersions.includes(
      metadata.formatVersion as ExtensionApiManifestFormatVersion,
    ),
    `Managed extension ${extension.id} requires API manifest formatVersion ${extensionApiManifestFormatVersions.join(' or ')}.`,
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
  formatVersion: ExtensionApiManifestFormatVersion,
): ExtensionApiManifestArgument {
  assert(isObject(value), `API manifest block ${blockOpcode} argument ${index} must be an object.`);
  assertExactProperties(
    value,
    formatVersion === 1
      ? ['id', 'menu', 'type']
      : ['id', 'maximum', 'menu', 'minimum', 'normalizesTo', 'staticLiteral', 'type'],
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
  const constraints =
    formatVersion === 1 ? {} : argumentConstraints(value, `${blockOpcode} argument ${id}`);
  if (value.menu === undefined) {
    return {id, type, ...constraints};
  }
  const menu = assertNonEmptyString(
    value.menu,
    `API manifest block ${blockOpcode} argument ${id} menu`,
  );
  assert(
    menuIds.has(menu),
    `API manifest block ${blockOpcode} argument ${id} references unknown menu: ${menu}`,
  );
  return {id, menu, type, ...constraints};
}

function argumentConstraints(
  value: UnknownRecord,
  label: string,
): Partial<ExtensionApiManifestArgument> {
  const constraints: Partial<ExtensionApiManifestArgument> = {};
  if (value.normalizesTo !== undefined) {
    assert(
      value.normalizesTo === 'pathSegments',
      `API manifest block ${label} normalizesTo must be pathSegments.`,
    );
    constraints.normalizesTo = 'pathSegments';
  }
  if (value.staticLiteral !== undefined) {
    constraints.staticLiteral = assertBoolean(
      value.staticLiteral,
      `API manifest block ${label} staticLiteral`,
    );
  }
  for (const key of ['minimum', 'maximum'] as const) {
    const bound = value[key];
    if (bound === undefined) continue;
    assert(
      typeof bound === 'number' && Number.isFinite(bound),
      `API manifest block ${label} ${key} must be a finite number.`,
    );
    constraints[key] = bound;
  }
  return constraints;
}

function normalizeBlock(
  value: unknown,
  index: number,
  menuIds: Set<string>,
  formatVersion: ExtensionApiManifestFormatVersion,
): ExtensionApiManifestBlock {
  assert(isObject(value), `API manifest block ${index} must be an object.`);
  assertExactProperties(
    value,
    formatVersion === 1
      ? ['arguments', 'blockType', 'opcode']
      : [
          'arguments',
          'blockType',
          'effect',
          'errors',
          'immutable',
          'opcode',
          'resultType',
          'server',
        ],
    `API manifest block ${index}`,
  );
  const opcode = assertNonEmptyString(value.opcode, `API manifest block ${index} opcode`);
  const blockType = assertNonEmptyString(value.blockType, `API manifest block ${opcode} blockType`);
  assert(
    Array.isArray(value.arguments),
    `API manifest block ${opcode} arguments must be an array.`,
  );
  const arguments_ = (value.arguments as unknown[]).map((argument, argumentIndex) =>
    normalizeArgument(argument, opcode, argumentIndex, menuIds, formatVersion),
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
  const block: ExtensionApiManifestBlock = {arguments: arguments_, blockType, opcode};
  if (formatVersion === 1) return block;
  return {
    ...block,
    effect: assertEnum(
      value.effect,
      extensionApiManifestEffects,
      `API manifest block ${opcode} effect`,
    ),
    errors: normalizeErrors(value.errors, opcode),
    immutable: assertBoolean(value.immutable, `API manifest block ${opcode} immutable`),
    resultType: assertEnum(
      value.resultType,
      extensionApiManifestResultTypes,
      `API manifest block ${opcode} resultType`,
    ),
    server: normalizeServer(value.server, opcode),
  };
}

function normalizeExtensionTypes(manifest: UnknownRecord): Partial<ExtensionApiManifest> {
  const types: Partial<ExtensionApiManifest> = {};
  if (manifest.pathSegmentType !== undefined) {
    const pathType = manifest.pathSegmentType;
    assert(isObject(pathType), 'API manifest pathSegmentType must be an object.');
    assertExactProperties(pathType, ['kind', 'variants'], 'API manifest pathSegmentType');
    assert(
      pathType.kind === 'discriminatedUnion',
      'API manifest pathSegmentType kind must be discriminatedUnion.',
    );
    assert(
      Array.isArray(pathType.variants) && pathType.variants.length > 0,
      'API manifest pathSegmentType variants must be a non-empty array.',
    );
    types.pathSegmentType = {
      kind: 'discriminatedUnion',
      variants: (pathType.variants as unknown[]).map((variant, index) => {
        const label = `API manifest pathSegmentType variants[${index}]`;
        assert(isObject(variant), `${label} must be an object.`);
        assertExactProperties(variant, ['kind', 'valueType'], label);
        return {
          kind: assertNonEmptyString(variant.kind, `${label} kind`),
          valueType: assertNonEmptyString(variant.valueType, `${label} valueType`),
        };
      }),
    };
  }
  if (manifest.dataReferenceType !== undefined) {
    const reference = manifest.dataReferenceType;
    assert(isObject(reference), 'API manifest dataReferenceType must be an object.');
    assertExactProperties(
      reference,
      ['kind', 'lifetime', 'scope', 'valueType'],
      'API manifest dataReferenceType',
    );
    types.dataReferenceType = {
      kind: assertNonEmptyString(reference.kind, 'API manifest dataReferenceType kind'),
      lifetime: assertNonEmptyString(reference.lifetime, 'API manifest dataReferenceType lifetime'),
      scope: assertNonEmptyString(reference.scope, 'API manifest dataReferenceType scope'),
      valueType: assertNonEmptyString(
        reference.valueType,
        'API manifest dataReferenceType valueType',
      ),
    };
  }
  return types;
}

function normalizeErrors(value: unknown, opcode: string): string[] {
  assert(Array.isArray(value), `API manifest block ${opcode} errors must be an array.`);
  // Error codes keep their declared order: the manifest documents them as a list, not a set.
  return (value as unknown[]).map((error, index) =>
    assertNonEmptyString(error, `API manifest block ${opcode} errors[${index}]`),
  );
}

function normalizeServer(value: unknown, opcode: string): ExtensionApiManifestServer {
  assert(isObject(value), `API manifest block ${opcode} server must be an object.`);
  assertExactProperties(value, ['irOperation', 'supported'], `API manifest block ${opcode} server`);
  const supported = assertBoolean(value.supported, `API manifest block ${opcode} server.supported`);
  if (value.irOperation === undefined) {
    assert(
      !supported,
      `API manifest block ${opcode} server.irOperation is required when supported is true.`,
    );
    return {supported};
  }
  return {
    irOperation: assertNonEmptyString(
      value.irOperation,
      `API manifest block ${opcode} server.irOperation`,
    ),
    supported,
  };
}

function assertBoolean(value: unknown, label: string): boolean {
  assert(typeof value === 'boolean', `${label} must be a boolean.`);
  return value;
}

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  assert(
    typeof value === 'string' && allowed.includes(value as T),
    `${label} must be one of: ${allowed.join(', ')}.`,
  );
  return value as T;
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
    isObject(manifest) && manifest.formatVersion === 2
      ? ['blocks', 'dataReferenceType', 'formatVersion', 'id', 'menus', 'pathSegmentType']
      : ['blocks', 'formatVersion', 'id', 'menus'],
    'Extension API manifest',
  );
  const formatVersion = manifest.formatVersion as ExtensionApiManifestFormatVersion;
  assert(
    extensionApiManifestFormatVersions.includes(formatVersion),
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
    normalizeBlock(block, index, menuIds, formatVersion),
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
  return {
    blocks,
    formatVersion,
    id: manifest.id,
    menus,
    ...(formatVersion === 1 ? {} : normalizeExtensionTypes(manifest)),
  };
}

/**
 * Parse an extension API manifest without throwing.
 *
 * `parseExtensionApiManifest` aborts on the first problem, which suits callers
 * that treat an invalid manifest as fatal. Callers that audit several manifests
 * and report every failure together need the error as a value instead.
 */
export function tryParseExtensionApiManifest(
  contents: Uint8Array | string,
  options: {expectedId?: string} = {},
): ExtensionApiManifestParseResult {
  try {
    return {error: null, manifest: parseExtensionApiManifest(contents, options)};
  } catch (error) {
    return {error: errorMessage(error), manifest: null};
  }
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

/**
 * Compares the format version 2 metadata of one block.
 *
 * Every change to a declared contract counts as breaking, in both directions: a consumer can rely on
 * a block being immutable just as readily as on it not being. The two exceptions are a block gaining
 * server support and a block declaring a new error code, which only widen what the block offers.
 */
function compareBlockMetadata(
  changes: ExtensionApiCompatibilityChange[],
  installed: ExtensionApiManifestBlock,
  candidate: ExtensionApiManifestBlock,
  path: string,
): void {
  for (const property of ['resultType', 'effect', 'immutable'] as const) {
    if (installed[property] !== candidate[property]) {
      addChange(
        changes,
        `block-${property}-changed`,
        `${path}/${property}`,
        installed[property] ?? null,
        candidate[property] ?? null,
        true,
      );
    }
  }

  const installedErrors = new Set(installed.errors ?? []);
  const candidateErrors = new Set(candidate.errors ?? []);
  for (const code of installedErrors) {
    if (!candidateErrors.has(code)) {
      addChange(changes, 'block-error-removed', `${path}/errors`, code, null, true);
    }
  }
  for (const code of candidateErrors) {
    if (!installedErrors.has(code)) {
      addChange(changes, 'block-error-added', `${path}/errors`, null, code, false);
    }
  }

  const installedServer = installed.server;
  const candidateServer = candidate.server;
  if (installedServer?.supported !== candidateServer?.supported) {
    addChange(
      changes,
      'block-server-supported-changed',
      `${path}/server/supported`,
      installedServer?.supported ?? null,
      candidateServer?.supported ?? null,
      installedServer?.supported === true,
    );
  }
  if (installedServer?.irOperation !== candidateServer?.irOperation) {
    addChange(
      changes,
      'block-server-ir-operation-changed',
      `${path}/server/irOperation`,
      installedServer?.irOperation ?? null,
      candidateServer?.irOperation ?? null,
      true,
    );
  }
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
  if (installed.formatVersion !== candidate.formatVersion) {
    // Going up adds metadata, which no existing consumer was reading. Going down removes metadata a
    // server-side compiler may already lower against, so that direction breaks.
    addChange(
      changes,
      'format-version-changed',
      '/formatVersion',
      installed.formatVersion,
      candidate.formatVersion,
      candidate.formatVersion < installed.formatVersion,
    );
  }
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
    compareBlockMetadata(changes, block, replacement, path);
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
      for (const property of [
        'type',
        'menu',
        'normalizesTo',
        'staticLiteral',
        'minimum',
        'maximum',
      ] as const) {
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
