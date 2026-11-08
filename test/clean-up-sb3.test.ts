// SPDX-License-Identifier: MPL-2.0

import {link, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';
import {expect, test} from 'vitest';

import {runCli} from '../src/cli';
import {cleanUpSb3} from '../src/index';

function fixture() {
  const blocks: Record<
    string,
    {opcode: string; topLevel: boolean; next: null; parent: null; x: number; y: number}
  > = Object.fromEntries(
    Array.from({length: 5}, (_, index) => [
      `script${index}`,
      {opcode: 'event_whenflagclicked', topLevel: true, next: null, parent: null, x: 0, y: index},
    ]),
  );
  return {
    targets: [
      {
        blocks: Object.assign({}, blocks, {getter: [12, 'score', 'variable', 0, 10]}),
        comments: {
          attached: {blockId: 'script0', x: -50, y: -30, width: 400, height: 150},
          standalone: {blockId: null, x: 48, y: 64, width: 80, height: 40},
        },
        variables: {variable: ['score', 42]},
      },
      {blocks: {spriteScript: {...blocks.script0}}},
    ] as const,
    extensionURLs: {custom: 'data:text/javascript,example'},
    extensionStorage: {custom: {payload: 'keep'}},
  };
}

test('cleans an SB3 through the CLI and keeps attached comments, script data, and archive entries', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clean-up-sb3-'));
  try {
    const inputPath = path.join(directory, 'input.sb3');
    const outputPath = path.join(directory, 'output.sb3');
    const repeatPath = path.join(directory, 'repeat.sb3');
    const project = fixture();
    const asset = Uint8Array.of(1, 0, 255);
    const archive = zipSync({'project.json': strToU8(JSON.stringify(project)), 'asset.wav': asset});
    await writeFile(inputPath, archive);
    await runCli(['clean-up', inputPath, '--output', outputPath], {log: () => {}});

    const result = await readFile(outputPath);
    const entries = unzipSync(result);
    expect(entries['asset.wav']).toEqual(asset);
    const output = JSON.parse(strFromU8(entries['project.json'])) as ReturnType<typeof fixture>;
    const [stage, sprite] = output.targets;
    const roots = Object.values(stage.blocks).map((block) =>
      Array.isArray(block) ? {x: block[3], y: block[4]} : block,
    );
    expect(new Set(roots.map((block) => block.x)).size).toBeGreaterThan(1);
    expect(new Set(roots.map((block) => block.y)).size).toBeGreaterThan(1);
    const first = stage.blocks.script0;
    expect(stage.comments?.attached.x).toBe(first.x - 50);
    expect(stage.comments?.attached.y).toBe(first.y - 30);
    expect(stage.comments?.attached.y).toBeGreaterThan(104);
    expect(stage.comments?.standalone).toEqual(project.targets[0].comments?.standalone);
    expect(sprite.blocks.spriteScript).toMatchObject({x: 48, y: 64});
    expect(stage.blocks.getter.slice(0, 3)).toEqual([12, 'score', 'variable']);
    expect(stage.variables).toEqual(project.targets[0].variables);
    expect(output.extensionURLs).toEqual(project.extensionURLs);
    expect(output.extensionStorage).toEqual(project.extensionStorage);

    expect(await cleanUpSb3({inputPath: outputPath, outputPath: repeatPath})).toMatchObject({
      movedScriptCount: 0,
      movedCommentCount: 0,
    });
    expect(await readFile(repeatPath)).toEqual(result);
    expect(await readFile(inputPath)).toEqual(Buffer.from(archive));
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

test('protects the input and existing output paths', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clean-up-sb3-'));
  try {
    const inputPath = path.join(directory, 'input.sb3');
    const outputPath = path.join(directory, 'output.sb3');
    const hardLinkPath = path.join(directory, 'same-input.sb3');
    const symlinkPath = path.join(directory, 'dangling.sb3');
    await writeFile(inputPath, zipSync({'project.json': strToU8(JSON.stringify(fixture()))}));
    await link(inputPath, hardLinkPath);
    await symlink(path.join(directory, 'missing'), symlinkPath);
    await writeFile(outputPath, 'existing');
    await expect(cleanUpSb3({inputPath, outputPath: inputPath, yes: true})).rejects.toThrow(
      /output must differ/i,
    );
    await expect(cleanUpSb3({inputPath, outputPath: hardLinkPath, yes: true})).rejects.toThrow(
      /output must differ/i,
    );
    await expect(cleanUpSb3({inputPath, outputPath: symlinkPath, yes: true})).rejects.toThrow(
      /regular SB3 output file/i,
    );
    await expect(cleanUpSb3({inputPath, outputPath})).rejects.toThrow(/requires --yes/i);
    expect(await readFile(outputPath, 'utf8')).toBe('existing');
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});
