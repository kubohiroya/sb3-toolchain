// SPDX-License-Identifier: MPL-2.0

export const turboWarpCleanUpLayout = Object.freeze({
  columnGap: 96,
  columnTolerance: 256,
  rowGap: 72,
  startX: 48,
  startY: 64,
});

const minimumBlockHeight = 48;
const minimumBlockWidth = 160;
const nestedStackIndent = 64;
const nestedStackPadding = 24;
const nextBlockOverlap = 4;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function compareNumbers(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function inputBlockId(input, blocks) {
  if (!Array.isArray(input)) return null;
  for (const value of input.slice(1)) {
    if (typeof value === 'string' && Object.hasOwn(blocks, value)) return value;
  }
  return null;
}

function displayTextLength(block) {
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

function inputDisplayTextLength(input, blocks) {
  const childId = inputBlockId(input, blocks);
  if (childId) return displayTextLength(blocks[childId]);
  for (const value of input.slice(1)) {
    if (!Array.isArray(value) || value.length < 2) continue;
    const displayValue = value[1];
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

function verticalChildIds(block, blocks) {
  const childIds = [];
  if (isObject(block.inputs)) {
    for (const [inputName, input] of Object.entries(block.inputs)) {
      const childId = inputBlockId(input, blocks);
      if (childId && /^SUBSTACK/u.test(inputName)) childIds.push(childId);
    }
  }
  if (typeof block.next === 'string' && Object.hasOwn(blocks, block.next)) {
    childIds.push(block.next);
  }
  return childIds;
}

function measureStack(blockId, blocks) {
  const measured = new Map();
  const active = new Set();
  const work = [{blockId, finalize: false}];

  while (work.length > 0) {
    const frame = work.pop();
    if (measured.has(frame.blockId) || !isObject(blocks[frame.blockId])) continue;
    const block = blocks[frame.blockId];
    if (!frame.finalize) {
      if (active.has(frame.blockId)) continue;
      active.add(frame.blockId);
      work.push({blockId: frame.blockId, finalize: true});
      const childIds = verticalChildIds(block, blocks);
      for (let index = childIds.length - 1; index >= 0; index -= 1) {
        const childId = childIds[index];
        if (!active.has(childId) && !measured.has(childId)) {
          work.push({blockId: childId, finalize: false});
        }
      }
      continue;
    }

    let height = minimumBlockHeight;
    let width = Math.max(minimumBlockWidth, 80 + displayTextLength(block) * 8);
    if (isObject(block.inputs)) {
      for (const [inputName, input] of Object.entries(block.inputs)) {
        const childId = inputBlockId(input, blocks);
        if (childId && /^SUBSTACK/u.test(inputName)) {
          const nested = measured.get(childId) ?? {height: 0, width: 0};
          height += nested.height + nestedStackPadding;
          width = Math.max(width, nested.width + nestedStackIndent);
        } else {
          width += 24 + inputDisplayTextLength(input, blocks) * 8;
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

function groupIntoColumns(scripts) {
  const columns = [];
  for (const script of scripts) {
    let bestColumn = null;
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

function findTopBlockId(blockId, blocks) {
  const visited = new Set();
  let currentId = blockId;
  while (typeof currentId === 'string' && !visited.has(currentId)) {
    visited.add(currentId);
    const block = blocks[currentId];
    if (!isObject(block)) return null;
    if (block.topLevel === true || block.parent === null) return currentId;
    currentId = block.parent;
  }
  return null;
}

function moveAttachedComments(target, blocks, movements) {
  if (!isObject(target.comments)) return 0;
  let movedCommentCount = 0;
  for (const comment of Object.values(target.comments)) {
    if (!isObject(comment) || typeof comment.blockId !== 'string') continue;
    const topBlockId = findTopBlockId(comment.blockId, blocks);
    const movement = movements.get(topBlockId);
    if (!movement || (!movement.deltaX && !movement.deltaY)) continue;
    if (Number.isFinite(comment.x)) comment.x += movement.deltaX;
    if (Number.isFinite(comment.y)) comment.y += movement.deltaY;
    movedCommentCount += 1;
  }
  return movedCommentCount;
}

function attachedCommentWidths(target, blocks) {
  const widths = new Map();
  if (!isObject(target.comments)) return widths;
  for (const comment of Object.values(target.comments)) {
    if (
      !isObject(comment) ||
      typeof comment.blockId !== 'string' ||
      !Number.isFinite(comment.x) ||
      !Number.isFinite(comment.width)
    ) {
      continue;
    }
    const topBlockId = findTopBlockId(comment.blockId, blocks);
    const topBlock = blocks[topBlockId];
    if (!topBlockId || !isObject(topBlock) || !Number.isFinite(topBlock.x)) continue;
    const width = Math.max(comment.width, comment.x + comment.width - topBlock.x);
    widths.set(topBlockId, Math.max(widths.get(topBlockId) ?? 0, width));
  }
  return widths;
}

function cleanUpTarget(target, targetIndex) {
  if (target.blocks === undefined) {
    return {movedCommentCount: 0, movedScriptCount: 0, scriptCount: 0};
  }
  assert(isObject(target.blocks), `Project target ${targetIndex} blocks must be an object.`);
  const blocks = target.blocks;
  const scripts = [];
  let inputOrder = 0;
  for (const [blockId, block] of Object.entries(blocks)) {
    if (!isObject(block) || block.topLevel !== true) continue;
    assert(
      Number.isFinite(block.x) && Number.isFinite(block.y),
      `Top-level block ${JSON.stringify(blockId)} in project target ${targetIndex} requires numeric x and y coordinates.`,
    );
    scripts.push({
      block,
      blockId,
      inputOrder,
      originalX: block.x,
      originalY: block.y,
      size: measureStack(blockId, blocks),
    });
    inputOrder += 1;
  }

  const movements = new Map();
  const commentWidths = attachedCommentWidths(target, blocks);
  let cursorX = turboWarpCleanUpLayout.startX;
  let movedScriptCount = 0;
  for (const column of groupIntoColumns(scripts)) {
    let cursorY = turboWarpCleanUpLayout.startY;
    let columnWidth = 0;
    for (const script of column.scripts) {
      const deltaX = cursorX - script.originalX;
      const deltaY = cursorY - script.originalY;
      script.block.x = cursorX;
      script.block.y = cursorY;
      movements.set(script.blockId, {deltaX, deltaY});
      if (deltaX || deltaY) movedScriptCount += 1;
      cursorY += script.size.height + turboWarpCleanUpLayout.rowGap;
      columnWidth = Math.max(
        columnWidth,
        script.size.width,
        commentWidths.get(script.blockId) ?? 0,
      );
    }
    cursorX += columnWidth + turboWarpCleanUpLayout.columnGap;
  }

  return {
    movedCommentCount: moveAttachedComments(target, blocks, movements),
    movedScriptCount,
    scriptCount: scripts.length,
  };
}

export function cleanUpTurboWarpBlocks(project) {
  assert(isObject(project), 'TurboWarp project must be an object.');
  assert(Array.isArray(project.targets), 'TurboWarp project targets must be an array.');
  const cleanedProject = structuredClone(project);
  let movedCommentCount = 0;
  let movedScriptCount = 0;
  let scriptCount = 0;
  let targetCount = 0;

  for (const [targetIndex, target] of cleanedProject.targets.entries()) {
    assert(isObject(target), `Project target ${targetIndex} must be an object.`);
    const result = cleanUpTarget(target, targetIndex);
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
