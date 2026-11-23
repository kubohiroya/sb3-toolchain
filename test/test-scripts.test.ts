// SPDX-License-Identifier: MPL-2.0

import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {strFromU8, unzipSync} from 'fflate';
import {expect, test} from 'vitest';

import {parseCliArguments} from '../src/cli';
import {createDeterministicSb3, stripTestScripts} from '../src/index';
import type {ProjectJson} from '../src/index';

const fixtureSourceDirectory = fileURLToPath(new URL('./fixtures/minimal-source', import.meta.url));

function projectWithTests(): ProjectJson {
  return {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        blocks: {
          flag: {opcode: 'event_whenflagclicked', next: 'say', parent: null, topLevel: true},
          say: {
            opcode: 'looks_say',
            next: null,
            parent: 'flag',
            inputs: {MESSAGE: [1, [10, 'hi']]},
          },
          test: {
            opcode: 'kubohiroyatest_whentest',
            next: 'assert',
            parent: null,
            topLevel: true,
            fields: {NAME: ['scenes', null]},
          },
          assert: {
            opcode: 'kubohiroyatest_assert_true',
            next: null,
            parent: 'test',
            inputs: {CONDITION: [2, 'equals']},
          },
          equals: {
            opcode: 'operator_equals',
            next: null,
            parent: 'assert',
            inputs: {OPERAND1: [3, 'answer', [10, '']], OPERAND2: [1, [10, '3']]},
          },
          answer: {opcode: 'sensing_answer', next: null, parent: 'equals'},
          setup: {opcode: 'kubohiroyatest_whensetup', next: null, parent: null, topLevel: true},
          loose: [12, 'score', 'scoreId', 10, 20],
        },
        comments: {
          onTest: {blockId: 'assert', text: 'fails when a scene is lost'},
          onFlag: {blockId: 'flag', text: 'start'},
          free: {blockId: null, text: 'workspace note'},
        },
      },
      {isStage: false, name: 'Sprite1'},
    ],
    extensions: ['kubohiroyatest'],
  };
}

test('strips the scripts under test hats and the comments on their blocks', () => {
  const project = projectWithTests();
  const result = stripTestScripts(project);
  const [stage] = result.project.targets as Array<{blocks: object; comments: object}>;
  expect(Object.keys(stage.blocks)).toStrictEqual(['flag', 'say', 'loose']);
  expect(Object.keys(stage.comments)).toStrictEqual(['onFlag', 'free']);
  expect(result).toMatchObject({
    removedBlockCount: 5,
    removedCommentCount: 1,
    removedScriptCount: 2,
  });
  expect(result.project.extensions).toStrictEqual(['kubohiroyatest']);
  // The input project is not changed.
  expect(Object.keys((project.targets as Array<{blocks: object}>)[0].blocks)).toHaveLength(8);
});

test('leaves a project without test hats unchanged', () => {
  const project: ProjectJson = {targets: [{isStage: true, name: 'Stage', blocks: {}}]};
  const result = stripTestScripts(project);
  expect(result.project).toStrictEqual(project);
  expect(result).toMatchObject({
    removedBlockCount: 0,
    removedCommentCount: 0,
    removedScriptCount: 0,
  });
});

test('builds deterministic SB3 archives with tests kept or stripped', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sb3-toolchain-strip-tests-'));
  try {
    const sourceDirectory = path.join(directory, 'source');
    await cp(fixtureSourceDirectory, sourceDirectory, {recursive: true});
    const projectPath = path.join(sourceDirectory, 'project.source.json');
    const project = JSON.parse(await readFile(projectPath, 'utf8'));
    const {blocks, comments} = (projectWithTests().targets as Array<object>)[0] as {
      blocks: object;
      comments: object;
    };
    Object.assign(project.targets[0], {blocks, comments});
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);

    const builtBlocks = (archive: Uint8Array): string[] =>
      Object.keys(JSON.parse(strFromU8(unzipSync(archive)['project.json'])).targets[0].blocks);
    const [kept, stripped, strippedAgain] = await Promise.all([
      createDeterministicSb3(sourceDirectory),
      createDeterministicSb3(sourceDirectory, {stripTests: true}),
      createDeterministicSb3(sourceDirectory, {stripTests: true}),
    ]);
    expect(kept.testStrip).toBeNull();
    expect(builtBlocks(kept.archive)).toHaveLength(8);
    expect(stripped.testStrip).toStrictEqual({
      removedBlockCount: 5,
      removedCommentCount: 1,
      removedScriptCount: 2,
    });
    expect(builtBlocks(stripped.archive)).toStrictEqual(['flag', 'say', 'loose']);
    expect(Buffer.from(stripped.archive)).toStrictEqual(Buffer.from(strippedAgain.archive));
    expect(Buffer.from(stripped.archive)).not.toStrictEqual(Buffer.from(kept.archive));
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('parses --strip-tests for the build command', () => {
  expect(
    parseCliArguments(['build', 'source', '--output', 'out.sb3', '--strip-tests']),
  ).toMatchObject({command: 'build', stripTests: true});
  expect(parseCliArguments(['build', 'source', '--output', 'out.sb3'])).not.toHaveProperty(
    'stripTests',
  );
});
