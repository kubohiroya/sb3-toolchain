// SPDX-License-Identifier: MPL-2.0

import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {strFromU8, unzipSync} from 'fflate';
import {expect, test} from 'vitest';

import {parseCliArguments} from '../src/cli';
import {
  buildSb3,
  cleanUpTurboWarpBlocks,
  createDeterministicSb3,
  turboWarpCleanUpLayout,
} from '../src/index';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureSourceDirectory = path.join(projectRoot, 'test/fixtures/minimal-source');

interface TestBlock {
  fields: Record<string, unknown>;
  inputs: Record<string, unknown>;
  next: string | null;
  opcode: string;
  parent: string | null;
  shadow: boolean;
  topLevel: boolean;
  x?: number;
  y?: number;
}

function block({
  next = null,
  opcode,
  parent = null,
  topLevel = false,
  x,
  y,
}: {
  next?: string | null;
  opcode: string;
  parent?: string | null;
  topLevel?: boolean;
  x?: number;
  y?: number;
}): TestBlock {
  return {
    fields: {},
    inputs: {},
    next,
    opcode,
    parent,
    shadow: false,
    topLevel,
    ...(topLevel ? {x, y} : {}),
  };
}

function projectWithUntidyBlocks() {
  return {
    targets: [
      {
        blocks: {
          lower: block({
            next: 'lower-next',
            opcode: 'event_whenflagclicked',
            topLevel: true,
            x: 500,
            y: 400,
          }),
          'lower-next': block({opcode: 'looks_show', parent: 'lower'}),
          upper: block({
            opcode: 'event_whenflagclicked',
            topLevel: true,
            x: 520,
            y: 100,
          }),
          right: block({
            opcode: 'event_whenbroadcastreceived',
            topLevel: true,
            x: 900,
            y: 50,
          }),
        },
        comments: {
          attached: {
            blockId: 'lower-next',
            height: 100,
            minimized: false,
            text: 'Attached comment',
            width: 160,
            x: 550,
            y: 450,
          },
          workspace: {
            blockId: null,
            height: 100,
            minimized: false,
            text: 'Workspace comment',
            width: 160,
            x: 20,
            y: 30,
          },
        },
        isStage: true,
        lists: {stageList: ['list', []]},
        name: 'Stage',
        variables: {stageVariable: ['variable', 0]},
      },
      {
        blocks: {
          sprite: block({opcode: 'event_whenflagclicked', topLevel: true, x: -20, y: -10}),
        },
        comments: {},
        isStage: false,
        lists: {localList: ['local list', []]},
        name: 'Sprite1',
        variables: {localVariable: ['local variable', 0]},
      },
    ],
  };
}

async function withTemporaryDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sb3-clean-up-test-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
}

function readProject(archive: Uint8Array): any {
  return JSON.parse(strFromU8(unzipSync(archive)['project.json']));
}

function targetsOf(project: {targets?: unknown}): any[] {
  return project.targets as any[];
}

test('lays out every target without deleting project data or changing the input', () => {
  const input = projectWithUntidyBlocks();
  const snapshot: any = structuredClone(input);
  const result = cleanUpTurboWarpBlocks(input);

  expect(input).toStrictEqual(snapshot);
  expect(result.targetCount).toBe(2);
  expect(result.scriptCount).toBe(4);
  expect(result.movedScriptCount).toBe(4);
  expect(result.movedCommentCount).toBe(1);

  const [stage, sprite] = targetsOf(result.project);
  expect({x: stage.blocks.upper.x, y: stage.blocks.upper.y}).toStrictEqual({
    x: turboWarpCleanUpLayout.startX,
    y: turboWarpCleanUpLayout.startY,
  });
  expect(stage.blocks.lower.x).toBe(turboWarpCleanUpLayout.startX);
  expect(stage.blocks.lower.y).toBe(
    turboWarpCleanUpLayout.startY + 48 + turboWarpCleanUpLayout.rowGap,
  );
  expect(stage.blocks.right.x > stage.blocks.lower.x).toBeTruthy();
  expect(stage.blocks.right.y).toBe(turboWarpCleanUpLayout.startY);
  expect({x: sprite.blocks.sprite.x, y: sprite.blocks.sprite.y}).toStrictEqual({
    x: turboWarpCleanUpLayout.startX,
    y: turboWarpCleanUpLayout.startY,
  });
  expect(stage.variables).toStrictEqual(snapshot.targets[0].variables);
  expect(stage.lists).toStrictEqual(snapshot.targets[0].lists);
  expect(sprite.variables).toStrictEqual(snapshot.targets[1].variables);
  expect(sprite.lists).toStrictEqual(snapshot.targets[1].lists);
  expect(stage.comments.workspace).toStrictEqual(snapshot.targets[0].comments.workspace);
  expect({x: stage.comments.attached.x, y: stage.comments.attached.y}).toStrictEqual({
    x:
      snapshot.targets[0].comments.attached.x +
      (stage.blocks.lower.x - snapshot.targets[0].blocks.lower.x),
    y:
      snapshot.targets[0].comments.attached.y +
      (stage.blocks.lower.y - snapshot.targets[0].blocks.lower.y),
  });

  const repeated = cleanUpTurboWarpBlocks(result.project);
  expect(repeated.project).toStrictEqual(result.project);
  expect(repeated.movedScriptCount).toBe(0);
  expect(repeated.movedCommentCount).toBe(0);
});

test('handles large linear stacks without depending on the JavaScript call stack', () => {
  const blockCount = 5000;
  const blocks: Record<string, TestBlock> = {};
  for (let index = 0; index < blockCount; index += 1) {
    const blockId = `block-${index}`;
    blocks[blockId] = block({
      next: index + 1 < blockCount ? `block-${index + 1}` : null,
      opcode: 'looks_show',
      parent: index === 0 ? null : `block-${index - 1}`,
      topLevel: index === 0,
      x: 100,
      y: 200,
    });
  }

  const result = cleanUpTurboWarpBlocks({
    targets: [{blocks, comments: {}, isStage: true, name: 'Stage'}],
  });
  expect(result.scriptCount).toBe(1);
  expect({
    x: targetsOf(result.project)[0].blocks['block-0'].x,
    y: targetsOf(result.project)[0].blocks['block-0'].y,
  }).toStrictEqual({x: turboWarpCleanUpLayout.startX, y: turboWarpCleanUpLayout.startY});
});

test('reserves column width for attached comments and inline primitive values', () => {
  const commentBlocks = {
    left: block({opcode: 'event_whenflagclicked', topLevel: true, x: 0, y: 0}),
    right: block({opcode: 'event_whenflagclicked', topLevel: true, x: 500, y: 0}),
  };
  const inlineBlocks = {
    left: block({opcode: 'looks_say', topLevel: true, x: 0, y: 0}),
    right: block({opcode: 'event_whenflagclicked', topLevel: true, x: 500, y: 0}),
  };
  inlineBlocks.left.inputs.MESSAGE = [1, [10, 'x'.repeat(200)]];
  const result = cleanUpTurboWarpBlocks({
    targets: [
      {
        blocks: commentBlocks,
        comments: {
          wide: {
            blockId: 'left',
            height: 100,
            minimized: false,
            text: 'Wide comment',
            width: 1000,
            x: 300,
            y: 0,
          },
        },
        isStage: true,
        name: 'Stage',
      },
      {blocks: inlineBlocks, comments: {}, isStage: false, name: 'Sprite1'},
    ],
  });

  const [commentTarget, inlineTarget] = targetsOf(result.project);
  const commentRight = commentTarget.comments.wide.x + commentTarget.comments.wide.width;
  expect(commentTarget.blocks.right.x - commentRight).toBe(turboWarpCleanUpLayout.columnGap);
  expect(inlineTarget.blocks.right.x - inlineTarget.blocks.left.x > 200 * 8).toBeTruthy();
});

test('builds an opt-in cleaned archive without modifying expanded sources', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    const outputPath = path.join(directory, 'cleaned.sb3');
    await cp(fixtureSourceDirectory, sourceDirectory, {recursive: true});
    const projectPath = path.join(sourceDirectory, 'project.source.json');
    const sourceProject = JSON.parse(await readFile(projectPath, 'utf8'));
    sourceProject.targets[0].blocks = projectWithUntidyBlocks().targets[0].blocks;
    sourceProject.targets[0].comments = projectWithUntidyBlocks().targets[0].comments;
    await writeFile(projectPath, `${JSON.stringify(sourceProject, null, 2)}\n`);
    const sourceBeforeBuild = await readFile(projectPath, 'utf8');

    const regular = await createDeterministicSb3(sourceDirectory);
    const [cleaned, repeated] = await Promise.all([
      createDeterministicSb3(sourceDirectory, {cleanUpBlocks: true}),
      createDeterministicSb3(sourceDirectory, {cleanUpBlocks: true}),
    ]);
    expect(Buffer.from(cleaned.archive)).toStrictEqual(Buffer.from(repeated.archive));
    expect(readProject(regular.archive).targets[0].blocks.upper.x).toBe(520);
    expect({
      x: readProject(cleaned.archive).targets[0].blocks.upper.x,
      y: readProject(cleaned.archive).targets[0].blocks.upper.y,
    }).toStrictEqual({x: turboWarpCleanUpLayout.startX, y: turboWarpCleanUpLayout.startY});
    expect(cleaned.blockCleanUp?.scriptCount).toBe(3);

    const built = await buildSb3({cleanUpBlocks: true, outputPath, sourceDirectory});
    expect(built.blockCleanUp?.scriptCount).toBe(3);
    expect(readProject(await readFile(outputPath)).targets[0].blocks.upper.x).toBe(48);
    expect(await readFile(projectPath, 'utf8')).toBe(sourceBeforeBuild);
  });
});

test('parses the opt-in build flag and rejects non-boolean API values', async () => {
  expect(
    parseCliArguments(['build', 'custom-source', '--output', 'project.sb3', '--clean-up-blocks']),
  ).toStrictEqual({
    cleanUpBlocks: true,
    command: 'build',
    outputPath: path.resolve('project.sb3'),
    sourceDirectory: path.resolve('custom-source'),
    yes: false,
  });
  await expect(
    createDeterministicSb3(fixtureSourceDirectory, {
      cleanUpBlocks: 'yes',
    } as unknown as {cleanUpBlocks?: boolean}),
  ).rejects.toThrow(/cleanUpBlocks must be a boolean/u);
});
