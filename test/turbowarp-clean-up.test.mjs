// SPDX-License-Identifier: MPL-2.0

import assert from 'node:assert/strict';
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {strFromU8, unzipSync} from 'fflate';

import {parseCliArguments} from '../src/cli.js';
import {
  buildSb3,
  cleanUpTurboWarpBlocks,
  createDeterministicSb3,
  turboWarpCleanUpLayout,
} from '../src/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureSourceDirectory = path.join(projectRoot, 'test/fixtures/minimal-source');

function block({next = null, opcode, parent = null, topLevel = false, x, y}) {
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

async function withTemporaryDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sb3-clean-up-test-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
}

function readProject(archive) {
  return JSON.parse(strFromU8(unzipSync(archive)['project.json']));
}

test('lays out every target without deleting project data or changing the input', () => {
  const input = projectWithUntidyBlocks();
  const snapshot = structuredClone(input);
  const result = cleanUpTurboWarpBlocks(input);

  assert.deepEqual(input, snapshot);
  assert.equal(result.targetCount, 2);
  assert.equal(result.scriptCount, 4);
  assert.equal(result.movedScriptCount, 4);
  assert.equal(result.movedCommentCount, 1);

  const [stage, sprite] = result.project.targets;
  assert.deepEqual(
    {x: stage.blocks.upper.x, y: stage.blocks.upper.y},
    {x: turboWarpCleanUpLayout.startX, y: turboWarpCleanUpLayout.startY},
  );
  assert.equal(stage.blocks.lower.x, turboWarpCleanUpLayout.startX);
  assert.equal(
    stage.blocks.lower.y,
    turboWarpCleanUpLayout.startY + 48 + turboWarpCleanUpLayout.rowGap,
  );
  assert.ok(stage.blocks.right.x > stage.blocks.lower.x);
  assert.equal(stage.blocks.right.y, turboWarpCleanUpLayout.startY);
  assert.deepEqual(
    {x: sprite.blocks.sprite.x, y: sprite.blocks.sprite.y},
    {x: turboWarpCleanUpLayout.startX, y: turboWarpCleanUpLayout.startY},
  );
  assert.deepEqual(stage.variables, snapshot.targets[0].variables);
  assert.deepEqual(stage.lists, snapshot.targets[0].lists);
  assert.deepEqual(sprite.variables, snapshot.targets[1].variables);
  assert.deepEqual(sprite.lists, snapshot.targets[1].lists);
  assert.deepEqual(stage.comments.workspace, snapshot.targets[0].comments.workspace);
  assert.deepEqual(
    {x: stage.comments.attached.x, y: stage.comments.attached.y},
    {
      x:
        snapshot.targets[0].comments.attached.x +
        (stage.blocks.lower.x - snapshot.targets[0].blocks.lower.x),
      y:
        snapshot.targets[0].comments.attached.y +
        (stage.blocks.lower.y - snapshot.targets[0].blocks.lower.y),
    },
  );

  const repeated = cleanUpTurboWarpBlocks(result.project);
  assert.deepEqual(repeated.project, result.project);
  assert.equal(repeated.movedScriptCount, 0);
  assert.equal(repeated.movedCommentCount, 0);
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
    assert.deepEqual(Buffer.from(cleaned.archive), Buffer.from(repeated.archive));
    assert.equal(readProject(regular.archive).targets[0].blocks.upper.x, 520);
    assert.deepEqual(
      {
        x: readProject(cleaned.archive).targets[0].blocks.upper.x,
        y: readProject(cleaned.archive).targets[0].blocks.upper.y,
      },
      {x: turboWarpCleanUpLayout.startX, y: turboWarpCleanUpLayout.startY},
    );
    assert.equal(cleaned.blockCleanUp.scriptCount, 3);

    const built = await buildSb3({cleanUpBlocks: true, outputPath, sourceDirectory});
    assert.equal(built.blockCleanUp.scriptCount, 3);
    assert.equal(readProject(await readFile(outputPath)).targets[0].blocks.upper.x, 48);
    assert.equal(await readFile(projectPath, 'utf8'), sourceBeforeBuild);
  });
});

test('parses the opt-in build flag and rejects non-boolean API values', async () => {
  assert.deepEqual(
    parseCliArguments(['build', 'custom-source', '--output', 'project.sb3', '--clean-up-blocks']),
    {
      cleanUpBlocks: true,
      command: 'build',
      outputPath: path.resolve('project.sb3'),
      sourceDirectory: path.resolve('custom-source'),
      yes: false,
    },
  );
  await assert.rejects(
    createDeterministicSb3(fixtureSourceDirectory, {cleanUpBlocks: 'yes'}),
    /cleanUpBlocks must be a boolean/u,
  );
});
