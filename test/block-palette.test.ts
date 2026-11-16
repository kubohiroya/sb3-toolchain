// SPDX-License-Identifier: MPL-2.0

import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';
import {expect, test} from 'vitest';

import {unpackSb3, validateSourceFiles} from '../src/browser';
import {runCli} from '../src/cli';
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

function withoutBlockPalette(manifest: Record<string, unknown>): Record<string, unknown> {
  const copy = {...manifest};
  delete copy.blockPalette;
  return copy;
}

function git(arguments_: string[], cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile('git', arguments_, {cwd, encoding: 'utf8'}, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

async function commitAll(directory: string): Promise<void> {
  await git(['add', '-A'], directory);
  await git(['commit', '--quiet', '-m', 'snapshot'], directory);
}

test('unpacks palette comments into source format 2 and rebuilds the same bytes', async () => {
  const project = paletteProject();
  const input = canonicalSb3(project);
  const {files, warnings} = unpackSb3(input);
  expect(warnings).toEqual([]);

  expect(json(files, 'sb3-source.json')).toStrictEqual({
    formatVersion: 2,
    project: 'project.source.json',
    embeddedExtensions: 'embedded-extensions.json',
    assetsDirectory: 'assets',
    archiveEntries: ['project.json', costumeAsset.md5ext],
    blockPalette: 'block-palette.json',
  });
  expect(json(files, 'embedded-extensions.json').formatVersion).toBe(1);
  expect(strFromU8(files.get('block-palette.json')!)).toBe(
    `${JSON.stringify(
      {
        formatVersion: 1,
        order: stageJson.order,
        sets: stageJson.sets,
        stage: {groups: stageJson.groups},
        sprites: {Sprite1: {groups: spriteJson.groups}},
      },
      null,
      2,
    )}\n`,
  );

  // Only the text changes; ID, position, size, state and order stay as they were.
  const source = json(files, 'project.source.json');
  const expected = paletteProject();
  expected.targets[0].comments.z9.text = blockPaletteCommentReference;
  expected.targets[1].comments['palette-id'].text = blockPaletteCommentReference;
  expect(source).toStrictEqual(expected);
  expect(Object.keys(source.targets[1].comments)).toEqual(['first', 'palette-id']);

  await withTemporaryDirectory(async (directory) => {
    const inputPath = path.join(directory, 'input.sb3');
    const outputDirectory = path.join(directory, 'project');
    await writeFile(inputPath, input);
    const imported = await importSb3({inputPath, outputDirectory});
    expect(imported.warnings).toEqual([]);
    for (const [name, bytes] of files) {
      expect(await readFile(path.join(outputDirectory, name))).toEqual(Buffer.from(bytes));
    }
    await validateSb3Source(outputDirectory);
    const rebuilt = await createDeterministicSb3(outputDirectory);
    expect(Buffer.from(rebuilt.archive)).toEqual(Buffer.from(input));
  });
});

test('identifies palette comments by their marker, not by their ID', () => {
  const project = makeProject({
    sprite1: {
      // A comment ID that an earlier save might have used, but with no marker.
      palette: comment('{"formatVersion":1,"groups":["events"]}'),
      a: comment(spriteText),
    },
    sprite2: {b: comment(spriteText.replace('myExt/geometry', 'pen'))},
  });
  const {files} = unpackSb3(canonicalSb3(project));
  const source = json(files, 'project.source.json');
  expect(source.targets[1].comments.palette.text).toBe('{"formatVersion":1,"groups":["events"]}');
  expect(source.targets[1].comments.a.text).toBe(blockPaletteCommentReference);
  expect(source.targets[2].comments.b.text).toBe(blockPaletteCommentReference);
  expect(json(files, 'block-palette.json')).toStrictEqual({
    formatVersion: 1,
    sprites: {
      Sprite1: {groups: ['events', 'control', 'myExt/geometry']},
      Sprite2: {groups: ['events', 'control', 'pen']},
    },
  });
});

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

test('normalizes parseable non-canonical comments and keeps unreadable ones as plain comments', async () => {
  const handEdited = `my palette\n  {"groups":["events","control"],"formatVersion":1}   // _twplus_palette_  `;
  const broken = `${blockPaletteSpriteCommentHeader}\n{"formatVersion":1,"groups":[}${marker}`;
  const project = makeProject({sprite1: {h: comment(handEdited)}, sprite2: {b: comment(broken)}});
  const {files, warnings} = unpackSb3(canonicalSb3(project));
  expect(warnings).toEqual([
    expect.objectContaining({code: 'block-palette-normalized', target: 'Sprite1', commentId: 'h'}),
    expect.objectContaining({code: 'block-palette-invalid', target: 'Sprite2', commentId: 'b'}),
  ]);
  const source = json(files, 'project.source.json');
  expect(source.targets[2].comments.b.text).toBe(broken);
  expect(json(files, 'block-palette.json')).toStrictEqual({
    formatVersion: 1,
    sprites: {Sprite1: {groups: ['events', 'control']}},
  });
  await withTemporaryDirectory(async (directory) => {
    await writeFiles(directory, files);
    const rebuilt = unzipSync((await createDeterministicSb3(directory)).archive);
    const rebuiltProject = JSON.parse(strFromU8(rebuilt['project.json']));
    expect(rebuiltProject.targets[1].comments.h.text).toBe(
      `${blockPaletteSpriteCommentHeader}\n{"formatVersion":1,"groups":["events","control"]}${marker}`,
    );
    expect(rebuiltProject.targets[2].comments.b.text).toBe(broken);
  });

  // A project whose only palette comment cannot be read stays in format 1.
  const onlyBroken = unpackSb3(canonicalSb3(makeProject({sprite2: {b: comment(broken)}})));
  expect(json(onlyBroken.files, 'sb3-source.json').formatVersion).toBe(1);
  expect(onlyBroken.warnings).toEqual([expect.objectContaining({code: 'block-palette-invalid'})]);
  // Sprite comments must not carry project-wide settings.
  const spriteWithOrder = `${blockPaletteSpriteCommentHeader}\n${JSON.stringify({...spriteJson, order: []})}${marker}`;
  expect(
    unpackSb3(canonicalSb3(makeProject({sprite1: {s: comment(spriteWithOrder)}}))).warnings,
  ).toEqual([expect.objectContaining({code: 'block-palette-invalid'})]);
});

test('rejects two palette comments on one target and comments that look like references', async () => {
  const twice = makeProject({sprite1: {a: comment(spriteText), b: comment(spriteText)}});
  expect(() => unpackSb3(canonicalSb3(twice))).toThrow(
    expect.objectContaining({code: 'invalid-project', message: expect.stringMatching(/only one/u)}),
  );
  await withTemporaryDirectory(async (directory) => {
    const inputPath = path.join(directory, 'twice.sb3');
    await writeFile(inputPath, canonicalSb3(twice));
    await expect(
      importSb3({inputPath, outputDirectory: path.join(directory, 'out')}),
    ).rejects.toThrow(/only one/u);
  });
  const reserved = makeProject({stage: {a: comment(blockPaletteCommentReference)}});
  expect(() => unpackSb3(canonicalSb3(reserved))).toThrow(
    expect.objectContaining({code: 'invalid-project'}),
  );
});

test('validateSourceFiles and check report broken palette settings', async () => {
  const {files: valid} = unpackSb3(canonicalSb3(paletteProject()));
  const broken = (change: (files: Map<string, Uint8Array>) => void) => {
    const files = new Map(valid);
    change(files);
    return files;
  };
  const palette = json(valid, 'block-palette.json');
  const manifest = json(valid, 'sb3-source.json');
  const cases: [string, Map<string, Uint8Array>, RegExp][] = [
    [
      'unknown sprite',
      broken((files) =>
        setJson(files, 'block-palette.json', {
          ...palette,
          sprites: {...palette.sprites, Ghost: {groups: []}},
        }),
      ),
      /unknown sprite: Ghost/u,
    ],
    [
      'bad shape',
      broken((files) => setJson(files, 'block-palette.json', {...palette, stage: {groups: 'x'}})),
      /must be an array/u,
    ],
    [
      'bad group ID',
      broken((files) => setJson(files, 'block-palette.json', {...palette, order: ['a/b/c']})),
      /invalid block group ID/u,
    ],
    [
      'palette version',
      broken((files) => setJson(files, 'block-palette.json', {...palette, formatVersion: 2})),
      /Unsupported block-palette.json formatVersion: 2/u,
    ],
    [
      'unknown key',
      broken((files) => setJson(files, 'block-palette.json', {...palette, extra: true})),
      /unknown key: extra/u,
    ],
    [
      'no settings',
      broken((files) => setJson(files, 'block-palette.json', {formatVersion: 1})),
      /has no settings/u,
    ],
    [
      'setting without reference',
      broken((files) => {
        const project = json(files, 'project.source.json');
        project.targets[1].comments['palette-id'].text = 'gone';
        setJson(files, 'project.source.json', project);
      }),
      /Sprite Sprite1 has block palette settings/u,
    ],
    [
      'reference without setting',
      broken((files) => {
        const project = json(files, 'project.source.json');
        project.targets[2].comments.x = comment(blockPaletteCommentReference);
        setJson(files, 'project.source.json', project);
      }),
      /Sprite Sprite2 has a block palette reference but no settings/u,
    ],
    [
      'reference and raw comment',
      broken((files) => {
        const project = json(files, 'project.source.json');
        project.targets[1].comments.x = comment(spriteText);
        setJson(files, 'project.source.json', project);
      }),
      /both a block palette reference and a block palette comment/u,
    ],
    ['missing file', broken((files) => files.delete('block-palette.json')), /block-palette\.json/u],
    [
      'reference in format 1',
      broken((files) => {
        files.delete('block-palette.json');
        const v1 = withoutBlockPalette(manifest);
        setJson(files, 'sb3-source.json', {...v1, formatVersion: 1});
      }),
      /requires SB3 source format 2/u,
    ],
  ];
  for (const [, files, message] of cases) {
    expect(() => validateSourceFiles(files)).toThrow(
      expect.objectContaining({
        code: 'invalid-block-palette',
        message: expect.stringMatching(message),
      }),
    );
    await withTemporaryDirectory(async (directory) => {
      await writeFiles(directory, files);
      await expect(validateSb3Source(directory)).rejects.toThrow(message);
    });
  }

  // Manifest-level mismatches are source errors.
  const v1WithKey = broken((files) =>
    setJson(files, 'sb3-source.json', {...manifest, formatVersion: 1}),
  );
  expect(() => validateSourceFiles(v1WithKey)).toThrow(
    /blockPalette requires SB3 source format 2/u,
  );
  const v2WithoutKey = broken((files) => {
    const rest = withoutBlockPalette(manifest);
    setJson(files, 'sb3-source.json', rest);
  });
  expect(() => validateSourceFiles(v2WithoutKey)).toThrow(/format 2 requires block-palette.json/u);
  // In format 1, block-palette.json is not part of the folder.
  const {files: v1Files} = unpackSb3(canonicalSb3(makeProject()));
  v1Files.set('block-palette.json', valid.get('block-palette.json')!);
  expect(() => validateSourceFiles(v1Files)).toThrow(/Unexpected source file: block-palette.json/u);
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

test('import moves a folder from format 1 to 2 when settings appear, and back when they go', async () => {
  await withTemporaryDirectory(async (directory) => {
    await git(['init', '--quiet'], directory);
    await git(['config', 'user.name', 'Palette Test'], directory);
    await git(['config', 'user.email', 'palette-test@example.invalid'], directory);
    const inputPath = path.join(directory, 'input.sb3');
    const outputDirectory = path.join(directory, 'app');
    const importOnce = async (project: unknown) => {
      await writeFile(inputPath, canonicalSb3(project));
      const result = await importSb3({
        inputPath,
        outputDirectory,
        protectedRoot: directory,
        yes: true,
      });
      await commitAll(directory);
      return result;
    };

    await importOnce(makeProject({sprite1: {a: comment('note')}}));
    expect(
      JSON.parse(await readFile(path.join(outputDirectory, 'sb3-source.json'), 'utf8'))
        .formatVersion,
    ).toBe(1);

    const withPalette = makeProject({sprite1: {a: comment('note'), p: comment(spriteText)}});
    const upgraded = await importOnce(withPalette);
    expect(upgraded.differenceCounts).toStrictEqual({added: 1, modified: 2, removed: 0});
    const manifest = JSON.parse(
      await readFile(path.join(outputDirectory, 'sb3-source.json'), 'utf8'),
    );
    expect(manifest).toMatchObject({formatVersion: 2, blockPalette: 'block-palette.json'});
    expect(Buffer.from((await createDeterministicSb3(outputDirectory)).archive)).toEqual(
      Buffer.from(canonicalSb3(withPalette)),
    );

    const downgraded = await importOnce(makeProject({sprite1: {a: comment('note')}}));
    expect(downgraded.differenceCounts).toStrictEqual({added: 0, modified: 2, removed: 1});
    const v1 = JSON.parse(await readFile(path.join(outputDirectory, 'sb3-source.json'), 'utf8'));
    expect(v1.formatVersion).toBe(1);
    expect(v1).not.toHaveProperty('blockPalette');
    await expect(readFile(path.join(outputDirectory, 'block-palette.json'))).rejects.toThrow(
      /ENOENT/u,
    );
  });
});

test('build turns each reference back into its own comment and fails above 8000 characters', async () => {
  const {files} = unpackSb3(canonicalSb3(paletteProject()));
  const original = json(files, 'block-palette.json');
  const palette = {...original, sprites: {...original.sprites, Sprite2: {groups: ['pen']}}};
  setJson(files, 'block-palette.json', palette);
  const project = json(files, 'project.source.json');
  project.targets[2].comments.new = comment(blockPaletteCommentReference, {x: 0, y: 0});
  setJson(files, 'project.source.json', project);

  await withTemporaryDirectory(async (directory) => {
    await writeFiles(directory, files);
    const rebuilt = JSON.parse(
      strFromU8(unzipSync((await createDeterministicSb3(directory)).archive)['project.json']),
    );
    expect(rebuilt.targets[0].comments.z9.text).toBe(stageText);
    expect(rebuilt.targets[1].comments['palette-id'].text).toBe(spriteText);
    expect(rebuilt.targets[2].comments.new.text).toBe(
      `${blockPaletteSpriteCommentHeader}\n{"formatVersion":1,"groups":["pen"]}${marker}`,
    );

    // Enough groups to push the stage comment over the limit.
    const groups = Array.from({length: 1500}, (_, index) => `ext${index}`);
    await writeFile(
      path.join(directory, 'block-palette.json'),
      `${JSON.stringify({...palette, order: groups}, null, 2)}\n`,
    );
    const outputPath = path.join(directory, 'too-long.sb3');
    await expect(validateSb3Source(directory)).rejects.toThrow(/the limit is 8000/u);
    await expect(buildSb3({sourceDirectory: directory, outputPath})).rejects.toThrow(
      /Block palette comment for the stage has \d+ characters; the limit is 8000/u,
    );
    await expect(readFile(outputPath)).rejects.toThrow(/ENOENT/u);
  });
});

test('import CLI reports palette comment warnings', async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = path.join(directory, 'input.sb3');
    const broken = `${blockPaletteSpriteCommentHeader}\nnot json${marker}`;
    await writeFile(inputPath, canonicalSb3(makeProject({sprite1: {b: comment(broken)}})));
    const messages: string[] = [];
    await runCli(['import', inputPath, '--output', path.join(directory, 'out')], {
      log: (message) => messages.push(message),
    });
    expect(messages).toContainEqual(
      expect.stringMatching(/^Warning: Block palette comment b on Sprite1 was kept as a plain/u),
    );
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
