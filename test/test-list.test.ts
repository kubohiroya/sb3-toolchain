// SPDX-License-Identifier: MPL-2.0

import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {strToU8, zipSync} from 'fflate';
import {expect, test} from 'vitest';

import {parseCliArguments, runCli} from '../src/cli';

test('lists the same stable addresses from SB3 and expanded source, without executing extensions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sb3-test-list-'));
  try {
    const input = path.join(directory, 'project.sb3');
    const source = path.join(directory, 'source');
    await mkdir(source);
    const project = JSON.stringify({
      targets: [
        {
          isStage: true,
          name: 'Stage',
          blocks: {
            later: {
              opcode: 'kubohiroyatest_whentest',
              topLevel: true,
              y: 90,
              inputs: {NAME: [1, 'label']},
            },
            first: {
              opcode: 'kubohiroyatest_whentest',
              topLevel: true,
              inputs: {NAME: [1, [10, '場面と <&>']]},
            },
            label: {opcode: 'text', fields: {TEXT: ['Second', null]}},
            setup: {opcode: 'kubohiroyatest_whensetup', topLevel: true},
            flag: {opcode: 'event_whenflagclicked', topLevel: true},
          },
        },
      ],
      extensionURLs: {fixture: 'https://fixture.invalid/code.js'},
    });
    await writeFile(path.join(source, 'project.source.json'), project);
    await writeFile(
      input,
      zipSync({
        'project.json': strToU8(project),
        'not-executed.js': strToU8('throw new Error("DO NOT EXECUTE");'),
      }),
    );
    const list = async (file: string) => {
      const logs: string[] = [];
      await runCli(['test', 'list', file, '--json'], {
        log: (line) => logs.push(line),
        fetch: () => {
          throw new Error('Listing must not fetch extension code');
        },
      });
      expect(logs).toHaveLength(1);
      return JSON.parse(logs[0]);
    };
    expect(await list(input)).toStrictEqual({
      tests: [
        {address: 'Stage/first', target: 'Stage', blockId: 'first', name: '場面と <&>'},
        {address: 'Stage/later', target: 'Stage', blockId: 'later', name: 'Second'},
      ],
      setups: {Stage: 'setup'},
      duplicateSetups: {},
    });
    expect(await list(source)).toStrictEqual(await list(input));
    const logs: string[] = [];
    await runCli(['test', 'list', input], {log: (line) => logs.push(line)});
    expect(logs).toStrictEqual(['"Stage/first"\t"場面と <&>"', '"Stage/later"\t"Second"']);
    await writeFile(input, zipSync({'only.txt': strToU8('missing project')}));
    await expect(list(input)).rejects.toThrow('does not contain project.json');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('requires an explicit local test list input and rejects unsupported flags', () => {
  expect(() => parseCliArguments(['test', 'list'])).toThrow('Usage: sb3-toolchain test list');
  expect(() => parseCliArguments(['test', 'list', 'input.sb3', '--reporter', 'junit'])).toThrow(
    'Usage',
  );
});
