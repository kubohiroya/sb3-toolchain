// SPDX-License-Identifier: MPL-2.0
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';
import {afterEach, expect, it} from 'vitest';
import {parseCliArguments, runCli} from '../src/cli';

const source = '// Name: Legacy\n// ID: legacy\nScratch.extensions.register({});\n';
const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, {recursive: true, force: true});
});

async function legacySb3() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sb3-project-extensions-'));
  directories.push(directory);
  const inputPath = path.join(directory, 'input.sb3');
  const project = {
    targets: [{isStage: true, blocks: {a: {opcode: 'legacy_go'}}}],
    extensions: ['legacy'],
    extensionURLs: {legacy: dataUrl},
  };
  await writeFile(
    inputPath,
    zipSync({'project.json': strToU8(JSON.stringify(project)), 'a.svg': strToU8('<svg/>')}),
  );
  return {directory, inputPath};
}

it('lists, converts and reopens an SB3 without touching the input', async () => {
  const {directory, inputPath} = await legacySb3();
  const original = await readFile(inputPath);
  const lines: string[] = [];
  await runCli(['extensions', 'list-sb3', inputPath, '--json'], {log: (line) => lines.push(line)});
  const listed = JSON.parse(lines.join('\n')) as {
    extensions: {id: string; format: string; source: {kind: string}}[];
  };
  expect(listed.extensions).toMatchObject([
    {id: 'legacy', format: 'embedded-data', source: {kind: 'unknown'}},
  ]);

  const outputPath = path.join(directory, 'output.sb3');
  lines.length = 0;
  await runCli(
    [
      'extensions',
      'update-sb3',
      inputPath,
      '--format',
      'legacy=embedded-file',
      '--output',
      outputPath,
    ],
    {
      log: (line) => lines.push(line),
    },
  );
  expect(lines.at(-1)).toBe(`Wrote: ${outputPath}.`);
  expect(await readFile(inputPath)).toEqual(original);
  const entries = unzipSync(await readFile(outputPath));
  expect(strFromU8(entries['extensions/legacy.js']!)).toBe(source);
  expect(strFromU8(entries['a.svg']!)).toBe('<svg/>');
  lines.length = 0;
  await runCli(['extensions', 'list-sb3', outputPath], {log: (line) => lines.push(line)});
  expect(lines[0]).toMatch(
    /^legacy\tembedded-file\tversion=unknown\tsource=unknown\tsha256=[a-f0-9]{64}$/u,
  );
});

it('writes nothing when the plan is blocked or only a dry run', async () => {
  const {directory, inputPath} = await legacySb3();
  const outputPath = path.join(directory, 'output.sb3');
  const lines: string[] = [];
  await expect(
    runCli(
      [
        'extensions',
        'update-sb3',
        inputPath,
        '--format',
        'legacy=remote-cacheable',
        '--output',
        outputPath,
      ],
      {
        log: (line) => lines.push(line),
      },
    ),
  ).rejects.toThrow(/blocked/u);
  expect(lines.join('\n')).toMatch(/error URL_REQUIRED/u);
  await expect(readFile(outputPath)).rejects.toMatchObject({code: 'ENOENT'});

  lines.length = 0;
  await runCli(
    ['extensions', 'update-sb3', inputPath, '--format', 'legacy=embedded-file', '--dry-run'],
    {
      log: (line) => lines.push(line),
    },
  );
  expect(lines.at(-1)).toBe('Dry run: nothing was written.');
});

it('reads requests per extension and refuses ambiguous ones', () => {
  expect(
    parseCliArguments([
      'extensions',
      'update-sb3',
      'in.sb3',
      '--version',
      'a=latest',
      '--format',
      'a=embedded-data',
      '--reference',
      'b=npm:pkg',
      '--allow-prerelease',
      '--dry-run',
    ]),
  ).toMatchObject({
    action: 'update-sb3',
    requests: {
      a: {version: 'latest', format: 'embedded-data', allowPrerelease: true},
      b: {reference: 'npm:pkg'},
    },
  });
  expect(() =>
    parseCliArguments(['extensions', 'update-sb3', 'in.sb3', '--version', 'a=latest']),
  ).toThrow(/--dry-run/u);
  expect(() =>
    parseCliArguments(['extensions', 'update-sb3', 'in.sb3', '--format', 'a=zip', '--dry-run']),
  ).toThrow(/--format/u);
  expect(() => parseCliArguments(['extensions', 'update-sb3', 'in.sb3', '--dry-run'])).toThrow(
    /at least one/u,
  );
});
