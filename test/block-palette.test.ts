// SPDX-License-Identifier: MPL-2.0

import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';
import {expect, test} from 'vitest';

import {unpackSb3, validateSourceFiles} from '../src/browser';
import {
  blockPaletteCommentReference,
  blockPaletteSpriteCommentHeader,
  blockPaletteStageCommentHeader,
  buildSb3,
  createDeterministicSb3,
  fixedZipTimestamp,
  importSb3,
  validateSb3Source,
} from '../src/index';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureSourceDirectory = path.join(projectRoot, 'test/fixtures/minimal-source');

const marker = ' // _twplus_palette_';
const stageJson = {
  formatVersion: 1,
  groups: ['looks', 'events', 'control'],
  order: ['events', 'control', 'looks', 'pen'],
  sets: {logic: {name: 'ロジック専用', groups: ['events', 'control', 'operators', 'myExt']}},
};
const spriteJson = {formatVersion: 1, groups: ['events', 'control', 'myExt/geometry']};
const stageText = `${blockPaletteStageCommentHeader}\n${JSON.stringify(stageJson)}${marker}`;
const spriteText = `${blockPaletteSpriteCommentHeader}\n${JSON.stringify(spriteJson)}${marker}`;

const costume = strToU8('<svg/>');
const costumeId = createHash('md5').update(costume).digest('hex');
const costumeAsset = {name: 'c', assetId: costumeId, dataFormat: 'svg', md5ext: `${costumeId}.svg`};

function comment(text: string, overrides: Record<string, unknown> = {}) {
  return {
    blockId: null,
    x: 12,
    y: 34,
    width: 200,
    height: 200,
    minimized: true,
    text,
    ...overrides,
  };
}

type Comments = Record<string, Record<string, unknown>>;

function makeProject({
  stage = {},
  sprite1 = {},
  sprite2 = {},
}: {stage?: Comments; sprite1?: Comments; sprite2?: Comments} = {}) {
  const target = (name: string, isStage: boolean, comments: Comments) => ({
    isStage,
    name,
    blocks: {},
    comments,
    costumes: [costumeAsset],
    sounds: [],
  });
  return {
    targets: [
      target('Stage', true, stage),
      target('Sprite1', false, sprite1),
      target('Sprite2', false, sprite2),
    ],
    monitors: [],
    extensions: [],
    meta: {semver: '3.0.0'},
    // build always writes this key, so a canonical SB3 has it too.
    extensionURLs: {},
  };
}

/** An SB3 laid out exactly as `build` writes it, so that a round trip can be byte-compared. */
function canonicalSb3(project: unknown): Uint8Array {
  return zipSync(
    {'project.json': strToU8(`${JSON.stringify(project)}\n`), [costumeAsset.md5ext]: costume},
    {level: 6, mtime: fixedZipTimestamp},
  );
}

function paletteProject() {
  return makeProject({
    stage: {note: comment('A plain note'), z9: comment(stageText, {x: -50, y: 70})},
    sprite1: {
      first: comment('Another note', {minimized: false}),
      'palette-id': comment(spriteText, {width: 320, height: 90, minimized: false}),
    },
  });
}

async function withTemporaryDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sb3-toolchain-palette-test-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

async function writeFiles(directory: string, files: Map<string, Uint8Array>): Promise<void> {
  for (const [name, bytes] of files) {
    await mkdir(path.dirname(path.join(directory, name)), {recursive: true});
    await writeFile(path.join(directory, name), bytes);
  }
}

function json(files: Map<string, Uint8Array>, name: string): any {
  return JSON.parse(strFromU8(files.get(name)!));
}

function setJson(files: Map<string, Uint8Array>, name: string, value: unknown): void {
  files.set(name, strToU8(`${JSON.stringify(value, null, 2)}\n`));
}

test('keeps source format 1 output unchanged for projects without palette settings', async () => {
  // Hashes of the fixture build and of its browser unpack, taken from sb3-toolchain 0.24.0.
  const built = await createDeterministicSb3(fixtureSourceDirectory);
  expect(createHash('sha256').update(built.archive).digest('hex')).toBe(
    '67f50cc9abc88bb19a52c15b94b79e248d1f1cbd790346706c17afbacd82fd00',
  );
  const {files} = unpackSb3(built.archive);
  const hash = createHash('sha256');
  for (const [name, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    hash.update(name);
    hash.update(bytes);
  }
  expect(hash.digest('hex')).toBe(
    '6827216eddbc70c543817197968292b9e70e0c82274e0428288e6d85458d38af',
  );

  const plain = unpackSb3(canonicalSb3(makeProject({stage: {n: comment('note')}})));
  expect(plain.files.has('block-palette.json')).toBe(false);
  expect(json(plain.files, 'sb3-source.json')).not.toHaveProperty('blockPalette');
  expect(json(plain.files, 'sb3-source.json').formatVersion).toBe(1);
});

test('rejects unsupported source format versions without changing any output', async () => {
  const {files} = unpackSb3(canonicalSb3(paletteProject()));
  setJson(files, 'sb3-source.json', {...json(files, 'sb3-source.json'), formatVersion: 3});
  expect(() => validateSourceFiles(files)).toThrow(/Unsupported SB3 source format version: 3/u);
  await withTemporaryDirectory(async (directory) => {
    const source = path.join(directory, 'source');
    await writeFiles(source, files);
    await expect(validateSb3Source(source)).rejects.toThrow(/version: 3/u);

    const outputPath = path.join(directory, 'out.sb3');
    await expect(buildSb3({sourceDirectory: source, outputPath})).rejects.toThrow(/version: 3/u);
    await expect(readFile(outputPath)).rejects.toThrow(/ENOENT/u);
    await writeFile(outputPath, 'previous');
    await expect(buildSb3({sourceDirectory: source, outputPath, yes: true})).rejects.toThrow(
      /version: 3/u,
    );
    expect(await readFile(outputPath, 'utf8')).toBe('previous');

    // import refuses to replace a folder in a format it does not know.
    const inputPath = path.join(directory, 'input.sb3');
    await writeFile(inputPath, canonicalSb3(paletteProject()));
    const before = await readFile(path.join(source, 'sb3-source.json'));
    await expect(
      importSb3({inputPath, outputDirectory: source, protectedRoot: directory, yes: true}),
    ).rejects.toThrow(/unrecognized directory/u);
    expect(await readFile(path.join(source, 'sb3-source.json'))).toEqual(before);
  });
});

test('the browser build exports the helpers an editor needs to load and save project folders', async () => {
  const browser = await import('../src/browser');
  const project = paletteProject();
  const original = structuredClone(project);

  const {document, warnings} = browser.extractBlockPalette(project);
  expect(warnings).toEqual([]);
  expect(document).not.toBeNull();
  expect(browser.hasBlockPaletteSettings(document!)).toBe(true);
  expect(project.targets[0].comments.z9.text).toBe(blockPaletteCommentReference);

  const references = browser.resolveBlockPaletteReferences(project, document);
  expect(references.map(({text}) => text)).toEqual([stageText, spriteText]);

  browser.applyBlockPaletteComments(project, document);
  expect(project).toEqual(original);
});

test('import keeps palette comments as plain comments in source format 1 and rebuilds the same bytes', async () => {
  const sb3 = canonicalSb3(paletteProject());
  const {files, warnings} = unpackSb3(sb3);
  expect(warnings).toEqual([]);
  expect(json(files, 'sb3-source.json').formatVersion).toBe(1);
  expect(json(files, 'sb3-source.json').blockPalette).toBeUndefined();
  expect(files.has('block-palette.json')).toBe(false);
  expect(json(files, 'project.source.json').targets[0].comments.z9.text).toBe(stageText);
  await withTemporaryDirectory(async (directory) => {
    await writeFiles(directory, files);
    expect(Buffer.from((await createDeterministicSb3(directory)).archive)).toEqual(
      Buffer.from(sb3),
    );
  });
});

test('a source format 2 folder written by 0.25 still checks and builds its palette comments', async () => {
  const {files} = unpackSb3(canonicalSb3(paletteProject()));
  const project = json(files, 'project.source.json');
  project.targets[0].comments.z9.text = blockPaletteCommentReference;
  project.targets[1].comments['palette-id'].text = blockPaletteCommentReference;
  setJson(files, 'project.source.json', project);
  setJson(files, 'block-palette.json', {
    formatVersion: 1,
    order: stageJson.order,
    sets: stageJson.sets,
    stage: {groups: stageJson.groups},
    sprites: {Sprite1: {groups: spriteJson.groups}},
  });
  setJson(files, 'sb3-source.json', {
    ...json(files, 'sb3-source.json'),
    formatVersion: 2,
    blockPalette: 'block-palette.json',
  });
  expect(() => validateSourceFiles(files)).not.toThrow();
  await withTemporaryDirectory(async (directory) => {
    await writeFiles(directory, files);
    await validateSb3Source(directory);
    const rebuilt = JSON.parse(
      strFromU8(unzipSync((await createDeterministicSb3(directory)).archive)['project.json']),
    );
    expect(rebuilt.targets[0].comments.z9.text).toBe(stageText);
    expect(rebuilt.targets[1].comments['palette-id'].text).toBe(spriteText);
  });
});

const screenState = strToU8(
  '{"version":1,"savedAt":1,"slices":{"blockPalette":{"version":1,"sprites":{"Sprite1":{"groups":["events"]}}}}}',
);

function sb3WithScreenState(): Uint8Array {
  return zipSync(
    {
      'project.json': strToU8(`${JSON.stringify(makeProject())}\n`),
      [costumeAsset.md5ext]: costume,
      'tw-plus/workspace.json': screenState,
    },
    {level: 6, mtime: fixedZipTimestamp},
  );
}

test('the Editor screen state goes to .tw-plus/workspace.json and back, byte for byte', async () => {
  const sb3 = sb3WithScreenState();
  const {files, warnings} = unpackSb3(sb3);
  expect(warnings).toEqual([]);
  expect(files.get('.tw-plus/workspace.json')).toEqual(screenState);
  expect([...files.keys()].some((name) => name.startsWith('assets/tw-plus'))).toBe(false);
  expect(json(files, 'sb3-source.json').archiveEntries).toEqual([
    'project.json',
    costumeAsset.md5ext,
    'tw-plus/workspace.json',
  ]);
  expect(() => validateSourceFiles(files)).not.toThrow();
  await withTemporaryDirectory(async (directory) => {
    const inputPath = path.join(directory, 'in.sb3');
    await writeFile(inputPath, sb3);
    const outputDirectory = path.join(directory, 'source');
    await importSb3({inputPath, outputDirectory});
    expect(
      new Uint8Array(await readFile(path.join(outputDirectory, '.tw-plus/workspace.json'))),
    ).toEqual(screenState);
    expect(Buffer.from((await createDeterministicSb3(outputDirectory)).archive)).toEqual(
      Buffer.from(sb3),
    );
  });
});

test('a screen state the Editor wrote after the import is built as the last entry', async () => {
  const {files} = unpackSb3(canonicalSb3(makeProject()));
  files.set('.tw-plus/workspace.json', screenState);
  expect(() => validateSourceFiles(files)).not.toThrow();
  await withTemporaryDirectory(async (directory) => {
    await writeFiles(directory, files);
    const archive = unzipSync((await createDeterministicSb3(directory)).archive);
    expect(Object.keys(archive)).toEqual([
      'project.json',
      costumeAsset.md5ext,
      'tw-plus/workspace.json',
    ]);
    expect(archive['tw-plus/workspace.json']).toEqual(screenState);
  });
});

test('a screen state that is not JSON is reported, and a folder without one builds without the entry', async () => {
  const {files} = unpackSb3(sb3WithScreenState());
  files.set('.tw-plus/workspace.json', strToU8('{not json'));
  expect(() => validateSourceFiles(files)).toThrow(/workspace\.json is not valid JSON/u);
  await withTemporaryDirectory(async (directory) => {
    await writeFiles(directory, files);
    await expect(validateSb3Source(directory)).rejects.toThrow(
      /workspace\.json is not valid JSON/u,
    );
    await rm(path.join(directory, '.tw-plus'), {recursive: true});
    const archive = unzipSync((await createDeterministicSb3(directory)).archive);
    expect(Object.keys(archive)).toEqual(['project.json', costumeAsset.md5ext]);
  });
});
