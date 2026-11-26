// SPDX-License-Identifier: MPL-2.0

import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {strToU8, zipSync} from 'fflate';
import {expect, test} from 'vitest';

import {parseCliArguments, runCli} from '../src/cli';
import {allowsEditorNavigation} from '../src/test-run';

const sha256 = '7f6541ce906594cde7d02498c65e8a800f0c194a924d288f9de4d702e738d868';
const extensionId = 'kubohiroyatest';
const extensionPath = 'extensions/turbowarp-test.js';
const revision = 'a'.repeat(40);
const runtimeDirectory = process.env.E2E_SB3_TEST_EDITOR_DIR;
const runtimeRevision = process.env.E2E_SB3_TEST_EDITOR_REVISION;
const extension = process.env.E2E_SB3_TEST_EXTENSION_JS;

function archive(code: Uint8Array, actual: number, extra: object = {}) {
  const project = {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {
          hat: {
            opcode: 'kubohiroyatest_whentest',
            next: 'assert',
            parent: null,
            inputs: {NAME: [1, [10, 'real & pinned']]},
            fields: {},
            shadow: false,
            topLevel: true,
            x: 40,
            y: 40,
          },
          assert: {
            opcode: 'kubohiroyatest_assert_strict_equals',
            next: null,
            parent: 'hat',
            inputs: {ACTUAL: [1, [4, actual]], EXPECTED: [1, [4, 10]]},
            fields: {},
            shadow: false,
            topLevel: false,
          },
        },
        comments: {},
        currentCostume: 0,
        costumes: [],
        sounds: [],
        volume: 100,
        layerOrder: 0,
        tempo: 60,
        videoTransparency: 50,
        videoState: 'off',
      },
    ],
    monitors: [],
    extensions: [extensionId],
    meta: {semver: '3.0.0'},
    turboWarpPlus: {
      schemaVersion: 1,
      extensions: [
        {
          id: extensionId,
          source: {type: 'embedded-file', path: extensionPath},
          execution: 'unsandboxed',
          sha256,
          dependencies: [],
          capabilities: [],
        },
      ],
    },
    ...extra,
  };
  return zipSync({'project.json': strToU8(JSON.stringify(project)), [extensionPath]: code});
}

test('refuses legacy URLs, other extensions, and replaced embedded bytes before opening the Editor', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sb3-run-refuse-'));
  try {
    const input = path.join(dir, 'input.sb3');
    const args = [
      'test',
      'run',
      input,
      '--editor-dir',
      'this-directory-does-not-exist',
      '--editor-revision',
      revision,
    ];
    expect(() => parseCliArguments([...args, '--reporter', 'unknown'])).toThrow('Only the junit');
    const bytes = strToU8('throw new Error("must not run")');
    for (const [extra, message] of [
      [{extensionURLs: {fixture: 'https://fixture.invalid/code.js'}}, 'Legacy extension URLs'],
      [{extensions: [extensionId, 'extra']}, 'only the pinned TurboWarp Test extension'],
      [{}, 'extension bytes do not match'],
    ] as const) {
      await writeFile(input, archive(bytes, 10, extra));
      await expect(runCli(args)).rejects.toThrow(message);
    }
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('allows only the loopback driver, its test frame, and local frame URLs; never file or remote navigation', () => {
  const driver = 'http://127.0.0.1/turbowarp-plus-editor/cli-test-run.html';
  const frame = 'http://127.0.0.1/turbowarp-plus-editor/test-frame.html';
  expect(allowsEditorNavigation(driver, false)).toBe(true);
  expect(allowsEditorNavigation(frame, true)).toBe(true);
  expect(allowsEditorNavigation('blob:http://127.0.0.1/local', true)).toBe(true);
  for (const url of [
    'file:///tmp/test-frame.html',
    'https://fixture.invalid/test-frame.html',
    'http://127.0.0.1:8080/turbowarp-plus-editor/test-frame.html',
    'blob:https://fixture.invalid/external',
  ]) {
    expect(allowsEditorNavigation(url, true)).toBe(false);
    expect(allowsEditorNavigation(url, false)).toBe(false);
  }
});

test('does not accept the archive manifest alone, a remote source, or an unsandboxed optional grant', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sb3-run-grants-'));
  try {
    const input = path.join(dir, 'input.sb3');
    const args = ['test', 'run', input, '--editor-dir', 'unused', '--editor-revision', revision];
    const digest = '0'.repeat(64);
    const grant = `fixture=${digest}`;
    expect(() =>
      parseCliArguments([...args, '--allow-sandboxed', grant, '--allow-sandboxed', grant]),
    ).toThrow('unique');
    expect(() =>
      parseCliArguments([...args, '--allow-sandboxed', `kubohiroyatest=${digest}`]),
    ).toThrow('unique');
    const testSpec = {
      id: extensionId,
      execution: 'unsandboxed',
      sha256,
      source: {type: 'embedded-file', path: extensionPath},
    };
    const sandbox = {
      id: 'fixture',
      execution: 'sandboxed',
      sha256: digest,
      source: {type: 'embedded-file', path: 'extensions/fixture.js'},
    };
    const put = (spec: object) =>
      writeFile(
        input,
        archive(strToU8('must not run'), 10, {
          extensions: [extensionId, 'fixture'],
          turboWarpPlus: {schemaVersion: 1, extensions: [testSpec, spec]},
        }),
      );
    await put(sandbox);
    await expect(runCli(args)).rejects.toThrow('only the pinned TurboWarp Test extension');
    await expect(runCli([...args, '--allow-sandboxed', `unknown=${digest}`])).rejects.toThrow(
      'exact CLI grants',
    );
    for (const spec of [
      {...sandbox, execution: 'unsandboxed'},
      {...sandbox, source: {type: 'remote-cacheable', url: 'https://fixture.invalid/code.js'}},
      {...sandbox, sha256: '1'.repeat(64)},
    ]) {
      await put(spec);
      await expect(runCli([...args, '--allow-sandboxed', grant])).rejects.toThrow(
        'embedded extension metadata',
      );
    }
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test.skipIf(!runtimeDirectory || !runtimeRevision || !extension)(
  'runs the selected SB3 test in the pinned Editor, exports JUnit, and rejects a failing assertion',
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sb3-run-real-'));
    try {
      const code = await readFile(extension!);
      for (const actual of [10, 15]) {
        const input = path.join(dir, `test-${actual}.sb3`);
        const output = path.join(dir, `test-${actual}.xml`);
        await writeFile(input, archive(code, actual));
        const run = runCli([
          'test',
          'run',
          input,
          '--editor-dir',
          runtimeDirectory!,
          '--editor-revision',
          runtimeRevision!,
          '--test',
          'Stage/hat',
          '--reporter',
          'junit',
          '--out',
          output,
        ]);
        const result = await run.then(
          () => 'passed',
          (error: Error) => error.message,
        );
        expect(result).toBe(actual === 15 ? 'One or more project tests did not pass.' : 'passed');
        const xml = await readFile(output, 'utf8');
        expect(xml).toContain('address" value="Stage/hat"');
        expect(xml).toContain('real &amp; pinned');
        expect(xml).toContain(`tests="1" failures="${actual === 10 ? 0 : 1}" errors="0"`);
        expect(xml.includes('at block assert, expected 10, actual 15')).toBe(actual === 15);
      }
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  },
  90_000,
);
