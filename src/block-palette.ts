// SPDX-License-Identifier: MPL-2.0

/**
 * Block palette settings (source format 2).
 *
 * In an SB3, each sprite or stage carries at most one comment whose second line ends with
 * {@link blockPaletteCommentMarker}. In a source folder, those comments live in
 * `block-palette.json`, and the comment text in `project.source.json` becomes
 * {@link blockPaletteCommentReference}. This module is shared by the Node and browser builds,
 * so it must not import Node built-ins.
 */

import {assert} from './assert';
import type {ProjectJson, UnknownRecord} from './types';

export const blockPaletteFormatVersion = 1;
export const blockPaletteFile = 'block-palette.json';
export const blockPaletteCommentMarker = ' // _twplus_palette_';
export const blockPaletteCommentReference = `block-palette:${blockPaletteFile}`;
export const blockPaletteCommentMaxLength = 8000;
export const blockPaletteSpriteCommentHeader =
  'TurboWarp Plus Editor block palette for this sprite. ' +
  'You can delete this comment to reset the palette.';
export const blockPaletteStageCommentHeader =
  'TurboWarp Plus Editor block palette for the stage. ' +
  'You can delete this comment to reset the palette.';

const markerToken = '// _twplus_palette_';
const groupIdPattern = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9_-]+)?$/u;
const setIdPattern = /^[A-Za-z_][A-Za-z0-9_-]*$/u;

export interface BlockPaletteTargetSetting {
  groups: string[];
}

export interface BlockPaletteSet {
  name: string;
  groups: string[];
}

export interface BlockPaletteDocument {
  formatVersion: 1;
  order?: string[];
  sets?: Record<string, BlockPaletteSet>;
  stage?: BlockPaletteTargetSetting;
  sprites?: Record<string, BlockPaletteTargetSetting>;
}

export type BlockPaletteWarningCode = 'block-palette-normalized' | 'block-palette-invalid';

export interface BlockPaletteWarning {
  code: BlockPaletteWarningCode;
  commentId: string;
  message: string;
  target: string;
}

interface ProjectTargetComments {
  comments: Record<string, UnknownRecord>;
  isStage: boolean;
  name: string;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: UnknownRecord, allowed: string[], description: string): void {
  for (const key of Object.keys(value)) {
    assert(allowed.includes(key), `${description} has an unknown key: ${key}`);
  }
}

function validateGroupList(value: unknown, description: string): string[] {
  assert(Array.isArray(value), `${description} must be an array of block group IDs.`);
  const seen = new Set<string>();
  for (const group of value as unknown[]) {
    assert(
      typeof group === 'string' && groupIdPattern.test(group),
      `${description} contains an invalid block group ID: ${JSON.stringify(group)}`,
    );
    assert(!seen.has(group), `${description} contains a duplicate block group ID: ${group}`);
    seen.add(group);
  }
  return [...seen];
}

function validateTargetSetting(value: unknown, description: string): BlockPaletteTargetSetting {
  assert(isRecord(value), `${description} must be an object.`);
  assertOnlyKeys(value, ['groups'], description);
  return {groups: validateGroupList(value.groups, `${description} groups`)};
}

function validateSets(value: unknown, description: string): Record<string, BlockPaletteSet> {
  assert(isRecord(value), `${description} must be an object.`);
  return Object.fromEntries(
    Object.entries(value).map(([setId, set]) => {
      assert(setIdPattern.test(setId), `${description} has an invalid set ID: ${setId}`);
      const setDescription = `${description}.${setId}`;
      assert(isRecord(set), `${setDescription} must be an object.`);
      assertOnlyKeys(set, ['name', 'groups'], setDescription);
      assert(
        typeof set.name === 'string' && set.name.length > 0,
        `${setDescription} name must be a non-empty string.`,
      );
      return [
        setId,
        {name: set.name, groups: validateGroupList(set.groups, `${setDescription} groups`)},
      ];
    }),
  );
}

function canonicalDocument(parts: Omit<BlockPaletteDocument, 'formatVersion'>) {
  const document: BlockPaletteDocument = {formatVersion: blockPaletteFormatVersion};
  if (parts.order !== undefined) document.order = parts.order;
  if (parts.sets !== undefined) document.sets = parts.sets;
  if (parts.stage !== undefined) document.stage = parts.stage;
  if (parts.sprites !== undefined && Object.keys(parts.sprites).length > 0) {
    document.sprites = parts.sprites;
  }
  return document;
}

export function hasBlockPaletteSettings(document: BlockPaletteDocument): boolean {
  return (
    document.order !== undefined ||
    document.sets !== undefined ||
    document.stage !== undefined ||
    (document.sprites !== undefined && Object.keys(document.sprites).length > 0)
  );
}

function stageHasSettings(document: BlockPaletteDocument): boolean {
  return (
    document.order !== undefined || document.sets !== undefined || document.stage !== undefined
  );
}

/** Validate the shape of `block-palette.json` without looking at the project. */
export function validateBlockPaletteDocument(value: unknown): BlockPaletteDocument {
  const description = blockPaletteFile;
  assert(isRecord(value), `${description} must contain an object.`);
  assertOnlyKeys(value, ['formatVersion', 'order', 'sets', 'stage', 'sprites'], description);
  assert(
    value.formatVersion === blockPaletteFormatVersion,
    `Unsupported ${description} formatVersion: ${String(value.formatVersion)}`,
  );
  let sprites: Record<string, BlockPaletteTargetSetting> | undefined;
  if (value.sprites !== undefined) {
    assert(isRecord(value.sprites), `${description} sprites must be an object.`);
    assert(
      Object.keys(value.sprites).length > 0,
      `${description} sprites must be omitted when it has no sprites.`,
    );
    sprites = Object.fromEntries(
      Object.entries(value.sprites).map(([name, setting]) => [
        name,
        validateTargetSetting(setting, `${description} sprites.${name}`),
      ]),
    );
  }
  const document = canonicalDocument({
    order: value.order === undefined ? undefined : validateGroupList(value.order, 'order'),
    sets: value.sets === undefined ? undefined : validateSets(value.sets, `${description} sets`),
    stage:
      value.stage === undefined
        ? undefined
        : validateTargetSetting(value.stage, `${description} stage`),
    sprites,
  });
  assert(
    hasBlockPaletteSettings(document),
    `${description} has no settings; remove it and use SB3 source format 1.`,
  );
  return document;
}

export function serializeBlockPaletteDocument(document: BlockPaletteDocument): string {
  return `${JSON.stringify(canonicalDocument(document), null, 2)}\n`;
}

/**
 * List each target's comments. In strict mode, a malformed target or comment is an error;
 * otherwise it is skipped so unpacking stays as permissive as it was in source format 1.
 */
function targetComments(project: ProjectJson, strict = true): ProjectTargetComments[] {
  if (!strict && !Array.isArray(project.targets)) return [];
  assert(Array.isArray(project.targets), 'Project targets must be an array.');
  const targets: ProjectTargetComments[] = [];
  for (const [index, target] of (project.targets as unknown[]).entries()) {
    if (!strict && !isRecord(target)) continue;
    assert(isRecord(target), `Project target ${index} must be an object.`);
    const comments: unknown = target.comments ?? {};
    if (!strict && !isRecord(comments)) continue;
    assert(isRecord(comments), `Project target ${index} comments must be an object.`);
    const records = Object.fromEntries(
      Object.entries(comments).filter(([id, comment]) => {
        assert(
          !strict || isRecord(comment),
          `Project target ${index} comment ${id} must be an object.`,
        );
        return isRecord(comment);
      }),
    ) as Record<string, UnknownRecord>;
    targets.push({
      comments: records,
      isStage: target.isStage === true,
      name: typeof target.name === 'string' ? target.name : String(index),
    });
  }
  return targets;
}

function isMarkedComment(comment: UnknownRecord): boolean {
  return typeof comment.text === 'string' && comment.text.includes(markerToken);
}

function isReferenceComment(comment: UnknownRecord): boolean {
  return comment.text === blockPaletteCommentReference;
}

function canonicalCommentText(
  document: BlockPaletteDocument,
  target: {isStage: boolean; name: string},
): string {
  let payload: UnknownRecord;
  if (target.isStage) {
    payload = {formatVersion: blockPaletteFormatVersion};
    if (document.stage) payload.groups = document.stage.groups;
    if (document.order) payload.order = document.order;
    if (document.sets) payload.sets = document.sets;
  } else {
    const setting = document.sprites?.[target.name];
    assert(setting, `${blockPaletteFile} has no setting for sprite ${target.name}.`);
    payload = {formatVersion: blockPaletteFormatVersion, groups: setting.groups};
  }
  const header = target.isStage ? blockPaletteStageCommentHeader : blockPaletteSpriteCommentHeader;
  return `${header}\n${JSON.stringify(payload)}${blockPaletteCommentMarker}`;
}

/**
 * The canonical comment text for one sprite or the stage. Fails when the text is longer than
 * 8000 characters, which Scratch 3 refuses to load.
 */
export function formatBlockPaletteComment(
  document: BlockPaletteDocument,
  target: {isStage: boolean; name: string},
): string {
  const text = canonicalCommentText(document, target);
  const length = Array.from(text).length;
  assert(
    length <= blockPaletteCommentMaxLength,
    `Block palette comment for ${target.isStage ? 'the stage' : `sprite ${target.name}`} has ` +
      `${length} characters; the limit is ${blockPaletteCommentMaxLength}.`,
  );
  return text;
}

type ParsedComment =
  | {ok: true; value: Omit<BlockPaletteDocument, 'formatVersion' | 'sprites'>}
  | {ok: false; reason: string};

function parseMarkedComment(comment: UnknownRecord, isStage: boolean): ParsedComment {
  if (comment.extraText !== undefined) {
    return {ok: false, reason: 'the comment has extraText'};
  }
  const lines = (comment.text as string).split('\n');
  const markedLines = lines.filter((line) => line.includes(markerToken));
  if (markedLines.length !== 1) {
    return {ok: false, reason: 'the marker must appear on exactly one line'};
  }
  const [line] = markedLines;
  const json = line.slice(0, line.indexOf(markerToken)).trim();
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return {ok: false, reason: 'the marked line is not valid JSON'};
  }
  try {
    assert(isRecord(value), 'the JSON must be an object');
    assertOnlyKeys(
      value,
      isStage ? ['formatVersion', 'groups', 'order', 'sets'] : ['formatVersion', 'groups'],
      'the JSON',
    );
    assert(
      value.formatVersion === blockPaletteFormatVersion,
      `unsupported formatVersion ${String(value.formatVersion)}`,
    );
    assert(isStage || value.groups !== undefined, 'the JSON has no groups');
    const parsed = {
      order: value.order === undefined ? undefined : validateGroupList(value.order, 'order'),
      sets: value.sets === undefined ? undefined : validateSets(value.sets, 'sets'),
      stage:
        value.groups === undefined
          ? undefined
          : {groups: validateGroupList(value.groups, 'groups')},
    };
    assert(
      parsed.order !== undefined || parsed.sets !== undefined || parsed.stage !== undefined,
      'the JSON has no settings',
    );
    return {ok: true, value: parsed};
  } catch (error) {
    return {ok: false, reason: error instanceof Error ? error.message : String(error)};
  }
}

/**
 * Move palette comments from an SB3 project into a `block-palette.json` document.
 * The project is changed in place: each recognized comment keeps its ID, position, size,
 * state and order, and its text becomes {@link blockPaletteCommentReference}.
 */
export function extractBlockPalette(project: ProjectJson): {
  document: BlockPaletteDocument | null;
  warnings: BlockPaletteWarning[];
} {
  const warnings: BlockPaletteWarning[] = [];
  const parts: Omit<BlockPaletteDocument, 'formatVersion'> = {};
  const sprites: [string, BlockPaletteTargetSetting][] = [];
  for (const target of targetComments(project, false)) {
    const marked = Object.entries(target.comments).filter(([, comment]) =>
      isMarkedComment(comment),
    );
    const references = Object.values(target.comments).filter(isReferenceComment);
    assert(
      references.length === 0,
      `${target.isStage ? 'The stage' : `Sprite ${target.name}`} has a comment whose text is ` +
        `reserved for block palette references: ${blockPaletteCommentReference}`,
    );
    assert(
      marked.length <= 1,
      `${target.isStage ? 'The stage' : `Sprite ${target.name}`} has ${marked.length} block ` +
        'palette comments; only one is allowed.',
    );
    if (marked.length === 0) continue;
    const [[commentId, comment]] = marked;
    const parsed = parseMarkedComment(comment, target.isStage);
    if (!parsed.ok) {
      warnings.push({
        code: 'block-palette-invalid',
        commentId,
        message:
          `Block palette comment ${commentId} on ${target.name} was kept as a plain comment ` +
          `and ignored: ${parsed.reason}.`,
        target: target.name,
      });
      continue;
    }
    if (target.isStage) {
      Object.assign(parts, parsed.value);
    } else {
      assert(
        !sprites.some(([name]) => name === target.name),
        `Duplicate sprite name with block palette settings: ${target.name}`,
      );
      sprites.push([target.name, parsed.value.stage!]);
    }
    const document = canonicalDocument({...parts, sprites: Object.fromEntries(sprites)});
    const canonicalText = canonicalCommentText(document, target);
    if (comment.text !== canonicalText) {
      warnings.push({
        code: 'block-palette-normalized',
        commentId,
        message:
          `Block palette comment ${commentId} on ${target.name} is not in the canonical form; ` +
          'it will be rewritten on build.',
        target: target.name,
      });
    }
    comment.text = blockPaletteCommentReference;
  }
  const document = canonicalDocument({...parts, sprites: Object.fromEntries(sprites)});
  return {document: hasBlockPaletteSettings(document) ? document : null, warnings};
}

/**
 * Check that `project.source.json` and `block-palette.json` agree, and return the canonical
 * comment text for each reference. `document` is null for source format 1.
 */
export function resolveBlockPaletteReferences(
  project: ProjectJson,
  document: BlockPaletteDocument | null,
): {comment: UnknownRecord; text: string}[] {
  const resolved: {comment: UnknownRecord; text: string}[] = [];
  const targets = targetComments(project, document !== null);
  if (document === null) {
    for (const target of targets) {
      assert(
        !Object.values(target.comments).some(isReferenceComment),
        `project.source.json refers to ${blockPaletteFile}, which requires SB3 source format 2.`,
      );
    }
    return resolved;
  }
  const spriteNames = new Set(targets.filter(({isStage}) => !isStage).map(({name}) => name));
  for (const name of Object.keys(document.sprites ?? {})) {
    assert(spriteNames.has(name), `${blockPaletteFile} refers to an unknown sprite: ${name}`);
  }
  for (const target of targets) {
    const label = target.isStage ? 'The stage' : `Sprite ${target.name}`;
    const references = Object.values(target.comments).filter(isReferenceComment);
    const marked = Object.values(target.comments).filter(isMarkedComment);
    const expected = target.isStage
      ? stageHasSettings(document)
      : document.sprites?.[target.name] !== undefined;
    assert(
      references.length <= 1,
      `${label} has ${references.length} block palette references; only one is allowed.`,
    );
    assert(
      references.length === 0 || marked.length === 0,
      `${label} has both a block palette reference and a block palette comment.`,
    );
    assert(
      references.length === (expected ? 1 : 0),
      expected
        ? `${label} has block palette settings in ${blockPaletteFile} but no comment that ` +
            `refers to it (${blockPaletteCommentReference}).`
        : `${label} has a block palette reference but no settings in ${blockPaletteFile}.`,
    );
    if (references.length === 1) {
      resolved.push({comment: references[0], text: formatBlockPaletteComment(document, target)});
    }
  }
  return resolved;
}

/** Replace each reference comment in a cloned project with its canonical SB3 text. */
export function applyBlockPaletteComments(
  project: ProjectJson,
  document: BlockPaletteDocument | null,
): void {
  for (const {comment, text} of resolveBlockPaletteReferences(project, document)) {
    comment.text = text;
  }
}
