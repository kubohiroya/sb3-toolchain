// SPDX-License-Identifier: MPL-2.0

import {assert} from './assert';
import {isObject} from './source-format';
import type {ProjectJson, UnknownRecord} from './types';

/**
 * Opcodes of the hats that start a test script inside a project (kubohiroya/turbowarp-plus-editor#774).
 * The green flag never starts them, so a build may keep them inert or strip them.
 */
export const testHatOpcodes: readonly string[] = Object.freeze([
  'kubohiroyatest_whentest',
  'kubohiroyatest_whensetup',
]);

export interface TestScriptStripSummary {
  removedBlockCount: number;
  removedCommentCount: number;
  removedScriptCount: number;
}

export interface StripTestScriptsResult extends TestScriptStripSummary {
  project: ProjectJson;
}

function referencedBlockIds(block: UnknownRecord): string[] {
  const ids: string[] = [];
  if (typeof block.next === 'string') ids.push(block.next);
  if (isObject(block.inputs)) {
    for (const input of Object.values(block.inputs)) {
      if (!Array.isArray(input)) continue;
      for (const value of input.slice(1)) {
        if (typeof value === 'string') ids.push(value);
      }
    }
  }
  return ids;
}

function rootBlockId(blocks: UnknownRecord, blockId: string): string {
  const visited = new Set<string>();
  let currentId = blockId;
  for (;;) {
    assert(!visited.has(currentId), `Block parent chain has a cycle at: ${blockId}`);
    visited.add(currentId);
    const block = blocks[currentId];
    if (!isObject(block) || typeof block.parent !== 'string' || !(block.parent in blocks)) {
      return currentId;
    }
    currentId = block.parent;
  }
}

/**
 * Removes every script under a test hat, with the comments attached to its blocks.
 * Other scripts, variables, lists, extensions and coordinates are left as they are.
 */
export function stripTestScripts(
  project: ProjectJson,
  opcodes: readonly string[] = testHatOpcodes,
): StripTestScriptsResult {
  assert(isObject(project), 'Project must be an object.');
  assert(Array.isArray(project.targets), 'Project targets must be an array.');
  const hatOpcodes = new Set(opcodes);
  const stripped = structuredClone(project);
  let removedBlockCount = 0;
  let removedCommentCount = 0;
  let removedScriptCount = 0;

  for (const [targetIndex, target] of (stripped.targets as unknown[]).entries()) {
    assert(isObject(target), `Project target ${targetIndex} must be an object.`);
    if (!isObject(target.blocks)) continue;
    const blocks = target.blocks;
    const hatIds = Object.entries(blocks)
      .filter(
        ([, block]) =>
          isObject(block) &&
          block.topLevel === true &&
          typeof block.opcode === 'string' &&
          hatOpcodes.has(block.opcode),
      )
      .map(([blockId]) => blockId);
    if (hatIds.length === 0) continue;

    const removed = new Set<string>();
    const pending = [...hatIds];
    while (pending.length > 0) {
      const blockId = pending.pop() as string;
      if (removed.has(blockId) || !(blockId in blocks)) continue;
      removed.add(blockId);
      const block = blocks[blockId];
      if (isObject(block)) pending.push(...referencedBlockIds(block));
    }
    // A block whose parent chain ends at a test hat belongs to it even if no input names it.
    const hats = new Set(hatIds);
    for (const blockId of Object.keys(blocks)) {
      if (hats.has(rootBlockId(blocks, blockId))) removed.add(blockId);
    }

    for (const blockId of removed) delete blocks[blockId];
    removedBlockCount += removed.size;
    removedScriptCount += hatIds.length;

    if (isObject(target.comments)) {
      for (const [commentId, comment] of Object.entries(target.comments)) {
        if (
          isObject(comment) &&
          typeof comment.blockId === 'string' &&
          removed.has(comment.blockId)
        ) {
          delete target.comments[commentId];
          removedCommentCount += 1;
        }
      }
    }
  }

  return {project: stripped, removedBlockCount, removedCommentCount, removedScriptCount};
}
