// SPDX-License-Identifier: MPL-2.0

import {assert} from './assert';
import type {ProjectJson, UnknownRecord} from './types';

export const turboWarpCleanUpLayout = Object.freeze({
  columnGap: 96,
  columnTolerance: 256,
  rowGap: 72,
  startX: 48,
  startY: 64,
});

const minimumBlockHeight = 48;
const compactBlockHeight = 64;
const minimumBlockWidth = 160;
const nestedStackIndent = 64;
const nestedStackPadding = 24;
const nextBlockOverlap = 4;

interface BlockSize {
  height: number;
  width: number;
}

interface Script {
  block: UnknownRecord | unknown[];
  blockId: string;
  inputOrder: number;
  originalX: number;
  originalY: number;
  size: BlockSize;
}

interface ScriptColumn {
  count: number;
  scripts: Script[];
  x: number;
}

interface Bounds extends BlockSize {
  x: number;
  y: number;
}

interface ScriptMovement {
  deltaX: number;
  deltaY: number;
}

export interface TargetCleanUpResult {
  movedCommentCount: number;
  movedScriptCount: number;
  scriptCount: number;
}

export interface TurboWarpCleanUpResult extends TargetCleanUpResult {
  project: ProjectJson;
  targetCount: number;
}

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function inputBlockId(input: unknown, blocks: UnknownRecord): string | null {
  if (!Array.isArray(input)) return null;
  for (const value of (input as unknown[]).slice(1)) {
    if (typeof value === 'string' && Object.hasOwn(blocks, value)) return value;
  }
  return null;
}

function displayTextLength(block: UnknownRecord): number {
  let length = typeof block.opcode === 'string' ? block.opcode.length : 0;
  if (isObject(block.fields)) {
    for (const field of Object.values(block.fields)) {
      if (Array.isArray(field) && field[0] !== undefined && field[0] !== null) {
        length += String(field[0]).length;
      }
    }
  }
  if (isObject(block.mutation) && typeof block.mutation.proccode === 'string') {
    length += block.mutation.proccode.length;
  }
  return length;
}

function inputDisplayTextLength(input: unknown, blocks: UnknownRecord): number {
  const childId = inputBlockId(input, blocks);
  if (childId) {
    const child = blocks[childId];
    return isObject(child) ? displayTextLength(child) : 0;
  }
  if (!Array.isArray(input)) return 0;
  for (const value of (input as unknown[]).slice(1)) {
    if (!Array.isArray(value) || value.length < 2) continue;
    const displayValue: unknown = value[1];
    if (
      typeof displayValue === 'string' ||
      typeof displayValue === 'number' ||
      typeof displayValue === 'boolean'
    ) {
      return String(displayValue).length;
    }
  }
  return 0;
}

function measuredChildIds(block: UnknownRecord, blocks: UnknownRecord, compact: boolean): string[] {
  const childIds: string[] = [];
  if (isObject(block.inputs)) {
    for (const [inputName, input] of Object.entries(block.inputs)) {
      const childId = inputBlockId(input, blocks);
      if (childId && (compact || /^SUBSTACK/u.test(inputName))) childIds.push(childId);
    }
  }
  if (typeof block.next === 'string' && Object.hasOwn(blocks, block.next)) {
    childIds.push(block.next);
  }
  return childIds;
}

function measureStack(blockId: string, blocks: UnknownRecord, compact: boolean): BlockSize {
  const measured = new Map<string, BlockSize>();
  const active = new Set<string>();
  const work: {blockId: string; finalize: boolean}[] = [{blockId, finalize: false}];

  while (work.length > 0) {
    const frame = work.pop();
    if (!frame) break;
    const block = blocks[frame.blockId];
    if (measured.has(frame.blockId) || !isObject(block)) continue;
    if (!frame.finalize) {
      if (active.has(frame.blockId)) continue;
      active.add(frame.blockId);
      work.push({blockId: frame.blockId, finalize: true});
      const childIds = measuredChildIds(block, blocks, compact);
      for (let index = childIds.length - 1; index >= 0; index -= 1) {
        const childId = childIds[index];
        if (!active.has(childId) && !measured.has(childId)) {
          work.push({blockId: childId, finalize: false});
        }
      }
      continue;
    }

    // Rendered statement blocks can be taller than the legacy cleanup estimate.
    let height = compact ? compactBlockHeight : minimumBlockHeight;
    let width = Math.max(minimumBlockWidth, 80 + displayTextLength(block) * 8);
    if (isObject(block.inputs)) {
      for (const [inputName, input] of Object.entries(block.inputs)) {
        const childId = inputBlockId(input, blocks);
        if (childId && /^SUBSTACK/u.test(inputName)) {
          const nested = measured.get(childId) ?? {height: 0, width: 0};
          height += nested.height + nestedStackPadding;
          width = Math.max(width, nested.width + nestedStackIndent);
        } else {
          const reporter = compact && childId ? measured.get(childId) : undefined;
          width += 24 + (reporter?.width ?? inputDisplayTextLength(input, blocks) * 8);
          if (reporter) height = Math.max(height, reporter.height + 16);
        }
      }
    }
    if (typeof block.next === 'string' && Object.hasOwn(blocks, block.next)) {
      const next = measured.get(block.next) ?? {height: 0, width: 0};
      height += Math.max(0, next.height - nextBlockOverlap);
      width = Math.max(width, next.width);
    }
    measured.set(frame.blockId, {height, width});
    active.delete(frame.blockId);
  }

  return measured.get(blockId) ?? {height: 0, width: 0};
}

function groupIntoColumns(scripts: Script[]): ScriptColumn[] {
  const columns: ScriptColumn[] = [];
  for (const script of scripts) {
    let bestColumn: ScriptColumn | null = null;
    let bestError = Number(turboWarpCleanUpLayout.columnTolerance);
    for (const column of columns) {
      const error = Math.abs(script.originalX - column.x);
      if (error < bestError) {
        bestColumn = column;
        bestError = error;
      }
    }
    if (bestColumn) {
      bestColumn.count += 1;
      bestColumn.x = (bestColumn.x * (bestColumn.count - 1) + script.originalX) / bestColumn.count;
      bestColumn.scripts.push(script);
    } else {
      columns.push({count: 1, scripts: [script], x: script.originalX});
    }
  }
  columns.sort((left, right) => compareNumbers(left.x, right.x));
  for (const column of columns) {
    column.scripts.sort(
      (left, right) =>
        compareNumbers(left.originalY, right.originalY) ||
        compareNumbers(left.inputOrder, right.inputOrder),
    );
  }
  return columns;
}

function findTopBlockId(blockId: unknown, blocks: UnknownRecord): string | null {
  const visited = new Set<string>();
  let currentId: unknown = blockId;
  while (typeof currentId === 'string' && !visited.has(currentId)) {
    visited.add(currentId);
    const block = blocks[currentId];
    if (isReporterPrimitive(block)) return currentId;
    if (!isObject(block)) return null;
    if (block.topLevel === true || block.parent === null) return currentId;
    currentId = block.parent;
  }
  return null;
}

function moveAttachedComments(
  target: UnknownRecord,
  blocks: UnknownRecord,
  movements: Map<string, ScriptMovement>,
): number {
  if (!isObject(target.comments)) return 0;
  let movedCommentCount = 0;
  for (const comment of Object.values(target.comments)) {
    if (!isObject(comment) || typeof comment.blockId !== 'string') continue;
    const topBlockId = findTopBlockId(comment.blockId, blocks);
    const movement = topBlockId === null ? undefined : movements.get(topBlockId);
    if (!movement || (!movement.deltaX && !movement.deltaY)) continue;
    if (isFiniteNumber(comment.x)) comment.x += movement.deltaX;
    if (isFiniteNumber(comment.y)) comment.y += movement.deltaY;
    movedCommentCount += 1;
  }
  return movedCommentCount;
}

function attachedCommentWidths(target: UnknownRecord, blocks: UnknownRecord): Map<string, number> {
  const widths = new Map<string, number>();
  if (!isObject(target.comments)) return widths;
  for (const comment of Object.values(target.comments)) {
    if (
      !isObject(comment) ||
      typeof comment.blockId !== 'string' ||
      !isFiniteNumber(comment.x) ||
      !isFiniteNumber(comment.width)
    ) {
      continue;
    }
    const topBlockId = findTopBlockId(comment.blockId, blocks);
    if (!topBlockId) continue;
    const topBlock = blocks[topBlockId];
    if (!isObject(topBlock) || !isFiniteNumber(topBlock.x)) continue;
    const width = Math.max(comment.width, comment.x + comment.width - topBlock.x);
    widths.set(topBlockId, Math.max(widths.get(topBlockId) ?? 0, width));
  }
  return widths;
}

function isReporterPrimitive(value: unknown): value is unknown[] {
  return Array.isArray(value) && (value[0] === 12 || value[0] === 13) && value.length >= 5;
}

function commentBounds(comment: unknown): Bounds | undefined {
  if (
    !isObject(comment) ||
    !isFiniteNumber(comment.x) ||
    !isFiniteNumber(comment.y) ||
    !isFiniteNumber(comment.width) ||
    !isFiniteNumber(comment.height) ||
    comment.width < 0 ||
    comment.height < 0
  )
    return undefined;
  return {x: comment.x, y: comment.y, width: comment.width, height: comment.height};
}

function compactPlacements(
  scripts: Script[],
  target: UnknownRecord,
  blocks: UnknownRecord,
): {script: Script; x: number; y: number}[] {
  const {columnGap, rowGap, startX, startY} = turboWarpCleanUpLayout;
  const items = scripts.map((script) => ({
    script,
    left: 0,
    right: script.size.width,
    top: 0,
    bottom: script.size.height,
  }));
  const byId = new Map(items.map((item) => [item.script.blockId, item]));
  const obstacles: Bounds[] = [];
  if (isObject(target.comments)) {
    for (const comment of Object.values(target.comments)) {
      const bounds = commentBounds(comment);
      if (!bounds || !isObject(comment)) continue;
      const topBlockId = findTopBlockId(comment.blockId, blocks);
      const item = topBlockId === null ? undefined : byId.get(topBlockId);
      if (!item) {
        obstacles.push(bounds);
        continue;
      }
      const x = bounds.x - item.script.originalX;
      const y = bounds.y - item.script.originalY;
      item.left = Math.min(item.left, x);
      item.right = Math.max(item.right, x + bounds.width);
      item.top = Math.min(item.top, y);
      item.bottom = Math.max(item.bottom, y + bounds.height);
    }
  }
  obstacles.sort((a, b) => compareNumbers(a.y, b.y));

  const placements: {script: Script; x: number; y: number}[] = [];
  let bestScore = Infinity;
  let bestRowCount = 1;

  // Try progressively larger column lengths while preserving the original reading order.
  for (let rows = 1; ; rows = Math.min(items.length, rows + Math.ceil(rows / 16))) {
    let width = 0;
    let height = 0;
    for (let first = 0; first < items.length; first += rows) {
      let left = 0;
      let right = 0;
      let columnHeight = 0;
      for (const item of items.slice(first, first + rows)) {
        left = Math.min(left, item.left);
        right = Math.max(right, item.right);
        columnHeight += item.bottom - item.top + rowGap;
      }
      width += right - left + columnGap;
      height = Math.max(height, columnHeight - rowGap);
    }
    // Score the size of the smallest 3:2 rectangle that could contain the layout.
    const score = Math.max((width - columnGap) / 1.5, height);
    if (score < bestScore) {
      bestScore = score;
      bestRowCount = rows;
    }
    if (rows >= items.length) break;
  }

  let cursorX: number = startX;
  for (let first = 0; first < items.length; first += bestRowCount) {
    const column = items.slice(first, first + bestRowCount);
    let left = 0;
    let right = 0;
    for (const item of column) {
      left = Math.min(left, item.left);
      right = Math.max(right, item.right);
    }
    const x = cursorX - Math.floor(left);
    let cursorY: number = startY;
    for (const item of column) {
      for (const obstacle of obstacles) {
        if (
          x + item.left < obstacle.x + obstacle.width + columnGap &&
          x + item.right + columnGap > obstacle.x &&
          cursorY < obstacle.y + obstacle.height + rowGap &&
          cursorY + item.bottom - item.top + rowGap > obstacle.y
        )
          cursorY = obstacle.y + obstacle.height + rowGap;
      }
      placements.push({script: item.script, x, y: cursorY - item.top});
      cursorY += item.bottom - item.top + rowGap;
    }
    cursorX = x + Math.ceil(right) + columnGap;
  }
  return placements;
}

function cleanUpTarget(
  target: UnknownRecord,
  targetIndex: number,
  compact: boolean,
): TargetCleanUpResult {
  if (target.blocks === undefined) {
    return {movedCommentCount: 0, movedScriptCount: 0, scriptCount: 0};
  }
  assert(isObject(target.blocks), `Project target ${targetIndex} blocks must be an object.`);
  const blocks = target.blocks;
  const scripts: Script[] = [];
  for (const [blockId, block] of Object.entries(blocks)) {
    const primitive = compact && isReporterPrimitive(block);
    if (!primitive && (!isObject(block) || block.topLevel !== true)) continue;
    const x = Array.isArray(block) ? block[3] : block.x;
    const y = Array.isArray(block) ? block[4] : block.y;
    assert(
      isFiniteNumber(x) && isFiniteNumber(y),
      `Top-level block ${JSON.stringify(blockId)} in project target ${targetIndex} requires numeric x and y coordinates.`,
    );
    scripts.push({
      block,
      blockId,
      inputOrder: scripts.length,
      originalX: x,
      originalY: y,
      size: primitive
        ? {
            height: minimumBlockHeight,
            width: Math.max(minimumBlockWidth, 80 + String(block[1]).length * 8),
          }
        : measureStack(blockId, blocks, compact),
    });
  }

  const columns = groupIntoColumns(scripts);
  const movements = new Map<string, ScriptMovement>();
  const moveScript = (script: Script, x: number, y: number) => {
    assert(
      isFiniteNumber(x) && isFiniteNumber(y),
      'Calculated SB3 layout coordinates must be finite.',
    );
    if (Array.isArray(script.block)) {
      script.block[3] = x;
      script.block[4] = y;
    } else {
      script.block.x = x;
      script.block.y = y;
    }
    const deltaX = x - script.originalX;
    const deltaY = y - script.originalY;
    if (deltaX || deltaY) movements.set(script.blockId, {deltaX, deltaY});
  };

  if (compact) {
    const ordered = columns.flatMap((column) => column.scripts);
    const placements = compactPlacements(ordered, target, blocks);
    for (const {script, x, y} of placements) moveScript(script, x, y);
  } else {
    const commentWidths = attachedCommentWidths(target, blocks);
    let cursorX: number = turboWarpCleanUpLayout.startX;
    for (const column of columns) {
      let cursorY: number = turboWarpCleanUpLayout.startY;
      let columnWidth = 0;
      for (const script of column.scripts) {
        moveScript(script, cursorX, cursorY);
        cursorY += script.size.height + turboWarpCleanUpLayout.rowGap;
        columnWidth = Math.max(
          columnWidth,
          script.size.width,
          commentWidths.get(script.blockId) ?? 0,
        );
      }
      cursorX += columnWidth + turboWarpCleanUpLayout.columnGap;
    }
  }

  return {
    movedCommentCount: moveAttachedComments(target, blocks, movements),
    movedScriptCount: movements.size,
    scriptCount: scripts.length,
  };
}

export function cleanUpTurboWarpBlocks(
  project: ProjectJson,
  {compact = false}: {compact?: boolean} = {},
): TurboWarpCleanUpResult {
  assert(isObject(project), 'TurboWarp project must be an object.');
  assert(Array.isArray(project.targets), 'TurboWarp project targets must be an array.');
  const cleanedProject = structuredClone(project);
  const targets = cleanedProject.targets as unknown[];
  let movedCommentCount = 0;
  let movedScriptCount = 0;
  let scriptCount = 0;
  let targetCount = 0;

  for (const [targetIndex, target] of targets.entries()) {
    assert(isObject(target), `Project target ${targetIndex} must be an object.`);
    const result = cleanUpTarget(target, targetIndex, compact);
    if (result.scriptCount > 0) targetCount += 1;
    movedCommentCount += result.movedCommentCount;
    movedScriptCount += result.movedScriptCount;
    scriptCount += result.scriptCount;
  }

  return {
    movedCommentCount,
    movedScriptCount,
    project: cleanedProject,
    scriptCount,
    targetCount,
  };
}
