// SPDX-License-Identifier: MPL-2.0

import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';
import {expect, test} from 'vitest';

import {Sb3SourceError, unpackSb3, validateSourceFiles} from '../src/browser';
import {importSb3} from '../src/import';
import {createDeterministicSb3} from '../src/source';

function asset(name: string, dataFormat: string, bytes: Uint8Array) {
  const assetId = createHash('md5').update(bytes).digest('hex');
  return {name, assetId, dataFormat, md5ext: `${assetId}.${dataFormat}`};
}

const costume = strToU8('<svg/>');
const sound = new Uint8Array([0, 1, 2, 3]);
const font = new Uint8Array([4, 5, 6, 7]);
const costumeAsset = asset('backdrop', 'svg', costume);
const soundAsset = asset('clip', 'wav', sound);
const fontAsset = asset('font', 'woff2', font);
const project = {
  targets: [{isStage: true, name: 'Stage', costumes: [costumeAsset], sounds: [soundAsset]}],
  customFonts: [{family: 'Project font', system: false, md5ext: fontAsset.md5ext}],
  extensionURLs: {
    embedded:
      'data:text/javascript;charset=utf-8;base64,' +
      Buffer.from('/* extension */').toString('base64'),
    remote: 'https://example.invalid/extension.js',
  },
  extensionStorage: {documents: {intro: {text: '見出し: 内容'}}},
};
const entries = {
  'project.json': strToU8(JSON.stringify(project)),
  [costumeAsset.md5ext]: costume,
  [soundAsset.md5ext]: sound,
  [fontAsset.md5ext]: font,
};

test('browser and CLI emit matching bytes and keep the project data on SB3 rebuild', async () => {
  const input = zipSync(entries);
  const original = input.slice();
  const {files, warnings} = unpackSb3(input);
  expect(warnings).toEqual([]);
  expect(input).toEqual(original);
  expect(files.has('extensions/embedded.js')).toBe(true);
  expect(files.has(`assets/${fontAsset.md5ext}`)).toBe(true);

  const root = await mkdtemp(path.join(os.tmpdir(), 'sb3-browser-unpack-test-'));
  try {
    const inputPath = path.join(root, 'input.sb3');
    const outputDirectory = path.join(root, 'project');
    await writeFile(inputPath, input);
    await importSb3({inputPath, outputDirectory});
    const diskFiles = (await readdir(outputDirectory, {recursive: true, withFileTypes: true}))
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(outputDirectory, path.join(entry.parentPath, entry.name)));
    expect([...files.keys()].sort()).toEqual(diskFiles.sort());
    for (const [filename, bytes] of files) {
      expect(await readFile(path.join(outputDirectory, filename))).toEqual(Buffer.from(bytes));
    }
    const rebuilt = unzipSync((await createDeterministicSb3(outputDirectory)).archive);
    expect(JSON.parse(strFromU8(rebuilt['project.json']))).toEqual(project);
    expect(rebuilt[fontAsset.md5ext]).toEqual(font);
    expect(rebuilt[soundAsset.md5ext]).toEqual(sound);
  } finally {
    await rm(root, {force: true, recursive: true});
  }
});

test('reports unreferenced assets and refuses unknown attachments or Plus manifests', () => {
  const unused = strToU8('unused');
  const unusedFilename = asset('unused', 'svg', unused).md5ext;
  const {files, warnings} = unpackSb3(zipSync({...entries, [unusedFilename]: unused}));
  expect(warnings).toEqual([{code: 'unreferenced-asset', path: unusedFilename}]);
  expect(files.has(`assets/${unusedFilename}`)).toBe(false);
  expect(() => unpackSb3(zipSync({...entries, 'document.yaml': unused}))).toThrow(
    expect.objectContaining({code: 'unsupported-project'}),
  );
  const plus = {...project, turboWarpPlus: {extensions: []}};
  expect(() =>
    unpackSb3(zipSync({...entries, 'project.json': strToU8(JSON.stringify(plus))})),
  ).toThrow(expect.objectContaining({code: 'unsupported-project'}));
});

test('rejects corrupt ZIPs, unsafe paths, missing assets and modified source bytes', () => {
  expect(() => unpackSb3(new Uint8Array([1]))).toThrow(Sb3SourceError);
  for (const name of ['../escape', '/absolute', 'assets\\escape']) {
    expect(() => unpackSb3(zipSync({...entries, [name]: costume}))).toThrow(
      expect.objectContaining({code: 'unsafe-path'}),
    );
  }
  const missing = {...entries};
  delete missing[soundAsset.md5ext];
  expect(() => unpackSb3(zipSync(missing))).toThrow(
    expect.objectContaining({code: 'missing-asset'}),
  );

  const {files} = unpackSb3(zipSync(entries));
  files.set(`assets/${fontAsset.md5ext}`, new Uint8Array([8]));
  expect(() => validateSourceFiles(files)).toThrow(
    expect.objectContaining({code: 'invalid-asset'}),
  );
});

test('opens a Git checkout with no asset or extension directories', async () => {
  const input = zipSync({
    'project.json': strToU8(
      JSON.stringify({
        targets: [{isStage: true, name: 'Stage', costumes: [], sounds: []}],
      }),
    ),
  });
  const {files} = unpackSb3(input);
  expect(files.size).toBe(3);
  const root = await mkdtemp(path.join(os.tmpdir(), 'sb3-browser-checkout-test-'));
  try {
    for (const [name, bytes] of files) await writeFile(path.join(root, name), bytes);
    expect(unzipSync((await createDeterministicSb3(root)).archive)).toHaveProperty('project.json');
  } finally {
    await rm(root, {force: true, recursive: true});
  }
});
