// SPDX-License-Identifier: MPL-2.0

import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {strFromU8, unzipSync} from 'fflate';
import {expect, test} from 'vitest';
import {stringify} from 'yaml';

import {parseCliArguments, runCli} from '../src/cli';
import {buildSb3, createDeterministicSb3} from '../src/index';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureSourceDirectory = path.join(projectRoot, 'test/fixtures/minimal-source');

function md5(contents: Uint8Array | string): string {
  return createHash('md5').update(contents).digest('hex');
}

function createWave({sampleCount = 4, sampleRate = 8000} = {}) {
  const bytesPerSample = 2;
  const dataSize = sampleCount * bytesPerSample;
  const contents = Buffer.alloc(44 + dataSize);
  contents.write('RIFF', 0);
  contents.writeUInt32LE(36 + dataSize, 4);
  contents.write('WAVE', 8);
  contents.write('fmt ', 12);
  contents.writeUInt32LE(16, 16);
  contents.writeUInt16LE(1, 20);
  contents.writeUInt16LE(1, 22);
  contents.writeUInt32LE(sampleRate, 24);
  contents.writeUInt32LE(sampleRate * bytesPerSample, 28);
  contents.writeUInt16LE(bytesPerSample, 32);
  contents.writeUInt16LE(16, 34);
  contents.write('data', 36);
  contents.writeUInt32LE(dataSize, 40);
  return contents;
}

async function withTemporaryDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sb3-toolchain-project-assets-test-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), {recursive: true});
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sprite() {
  return {
    layerOrder: 6,
    visible: false,
    x: 4,
    y: -16,
    size: 70,
    direction: 90,
    draggable: false,
    rotationStyle: 'all around',
    volume: 100,
  };
}

function image(kind: string, file: string, extra: Record<string, unknown> = {}): any {
  return {
    kind,
    file,
    bitmapResolution: 2,
    rotationCenterX: 507,
    rotationCenterY: 507,
    ...extra,
  };
}

function manifest(): any {
  return {
    formatVersion: 1,
    sprites: {Princess: sprite()},
    assets: {
      Princess: image('costume', '../inputs/Princess.png', {
        target: 'Princess',
        license: 'CC-BY-SA-4.0: LICENSES.md',
      }),
      Sunset: image('backdrop', '../inputs/Princess.png'),
      PrincessSound: {
        kind: 'sound',
        target: 'Princess',
        name: 'Princess',
        file: '../inputs/Princess.wav',
      },
    },
  };
}

test('adds editable JSON or YAML sprite assets and backdrops without modifying source', async () => {
  await withTemporaryDirectory(async (directory) => {
    const configurationDirectory = path.join(directory, 'configuration');
    const assetsDirectory = path.join(directory, 'inputs');
    const jsonManifestPath = path.join(configurationDirectory, 'project-assets.json');
    const yamlManifestPath = path.join(configurationDirectory, 'project-assets.yml');
    const outputPath = path.join(directory, 'project.sb3');
    const princess = Buffer.from('not-a-real-png-but-content-addressed');
    const voice = createWave();
    const specification = manifest();
    await mkdir(assetsDirectory, {recursive: true});
    await Promise.all([
      writeFile(path.join(assetsDirectory, 'Princess.png'), princess),
      writeFile(path.join(assetsDirectory, 'Princess.wav'), voice),
      writeJson(jsonManifestPath, specification),
      writeFile(yamlManifestPath, stringify(specification)),
    ]);
    const sourceBefore = await readFile(
      path.join(fixtureSourceDirectory, 'project.source.json'),
      'utf8',
    );
    const options = {allowedAssetRoots: [directory]};
    const [first, second, yaml] = await Promise.all([
      createDeterministicSb3(fixtureSourceDirectory, {
        ...options,
        projectAssetsPath: jsonManifestPath,
      }),
      createDeterministicSb3(fixtureSourceDirectory, {
        ...options,
        projectAssetsPath: jsonManifestPath,
      }),
      createDeterministicSb3(fixtureSourceDirectory, {
        ...options,
        projectAssetsPath: yamlManifestPath,
      }),
    ]);
    expect(Buffer.from(first.archive)).toStrictEqual(Buffer.from(second.archive));
    expect(Buffer.from(first.archive)).toStrictEqual(Buffer.from(yaml.archive));
    expect(first.projectAssetAdditions).toStrictEqual({
      assetFileCount: 2,
      backdropCount: 1,
      costumeCount: 1,
      soundCount: 1,
      spriteCount: 1,
    });
    expect(first.assetCount).toBe(3);
    expect(first.assetReferenceCount).toBe(4);
    expect(first.entryCount).toBe(4);

    const archive = unzipSync(first.archive);
    const project = JSON.parse(strFromU8(archive['project.json']));
    const stage = project.targets.find(({isStage}: any) => isStage);
    expect(stage.costumes.map(({name}: any) => name)).toStrictEqual(['pixel', 'Sunset']);
    const princessTargets = project.targets.filter(({name}: any) => name === 'Princess');
    expect(princessTargets.length).toBe(1);
    expect(princessTargets[0]).toStrictEqual({
      isStage: false,
      name: 'Princess',
      variables: {},
      lists: {},
      broadcasts: {},
      blocks: {},
      comments: {},
      currentCostume: 0,
      costumes: [
        {
          name: 'Princess',
          bitmapResolution: 2,
          dataFormat: 'png',
          assetId: md5(princess),
          md5ext: `${md5(princess)}.png`,
          rotationCenterX: 507,
          rotationCenterY: 507,
        },
      ],
      sounds: [
        {
          name: 'Princess',
          assetId: md5(voice),
          dataFormat: 'wav',
          format: '',
          md5ext: `${md5(voice)}.wav`,
          rate: 8000,
          sampleCount: 4,
        },
      ],
      volume: 100,
      layerOrder: 6,
      visible: false,
      x: 4,
      y: -16,
      size: 70,
      direction: 90,
      draggable: false,
      rotationStyle: 'all around',
    });
    expect(Buffer.from(archive[`${md5(princess)}.png`])).toStrictEqual(princess);
    expect(Buffer.from(archive[`${md5(voice)}.wav`])).toStrictEqual(voice);
    expect(await readFile(path.join(fixtureSourceDirectory, 'project.source.json'), 'utf8')).toBe(
      sourceBefore,
    );

    const built = await buildSb3({
      ...options,
      outputPath,
      projectAssetsPath: yamlManifestPath,
      sourceDirectory: fixtureSourceDirectory,
    });
    expect(built.changed).toBe(true);
    expect(await readFile(outputPath)).toStrictEqual(Buffer.from(first.archive));

    const cliOutputPath = path.join(directory, 'cli-project.sb3');
    const messages: string[] = [];
    await runCli(
      [
        'build',
        fixtureSourceDirectory,
        '--project-assets',
        yamlManifestPath,
        '--allow-asset-root',
        directory,
        '--output',
        cliOutputPath,
      ],
      {log: (message) => messages.push(message)},
    );
    expect(await readFile(cliOutputPath)).toStrictEqual(Buffer.from(first.archive));
    expect(messages[0]).toMatch(/^Built: .* \(4 entries, 3 assets,/u);
  });
});

test('parses project asset options for check and build', () => {
  expect(
    parseCliArguments([
      'check',
      'source',
      '--project-assets',
      'project-assets.yml',
      '--allow-asset-root',
      'resources',
    ]),
  ).toStrictEqual({
    allowedAssetRoots: [path.resolve('resources')],
    command: 'check',
    projectAssetsPath: path.resolve('project-assets.yml'),
    sourceDirectory: path.resolve('source'),
  });
  expect(
    parseCliArguments([
      'build',
      'source',
      '--output',
      'output.sb3',
      '--project-assets',
      'project-assets.json',
      '--allow-asset-root',
      'resources',
      '--yes',
    ]),
  ).toStrictEqual({
    allowedAssetRoots: [path.resolve('resources')],
    command: 'build',
    outputPath: path.resolve('output.sb3'),
    projectAssetsPath: path.resolve('project-assets.json'),
    sourceDirectory: path.resolve('source'),
    yes: true,
  });
  expect(() =>
    parseCliArguments(['build', 'source', '--output', 'output.sb3', '--allow-asset-root', '.']),
  ).toThrow(/requires --project-assets/u);
});

test('applies optional strict locks and rejects unsafe or ambiguous additions', async () => {
  await withTemporaryDirectory(async (directory) => {
    const configurationDirectory = path.join(directory, 'configuration');
    const inputsDirectory = path.join(directory, 'inputs');
    const manifestPath = path.join(configurationDirectory, 'project-assets.json');
    const princessPath = path.join(inputsDirectory, 'Princess.png');
    const soundPath = path.join(inputsDirectory, 'Princess.wav');
    const princess = Buffer.from('princess');
    const voice = createWave();
    await mkdir(inputsDirectory, {recursive: true});
    await Promise.all([writeFile(princessPath, princess), writeFile(soundPath, voice)]);

    const valid = manifest();
    await writeJson(manifestPath, valid);
    await expect(
      createDeterministicSb3(fixtureSourceDirectory, {projectAssetsPath: manifestPath}),
    ).rejects.toThrow(/outside the allowed project asset roots/u);

    const options = {allowedAssetRoots: [directory], projectAssetsPath: manifestPath};
    const invalidHash = structuredClone(valid);
    invalidHash.assets.Princess.sha256 = '0'.repeat(64);
    await writeJson(manifestPath, invalidHash);
    await expect(createDeterministicSb3(fixtureSourceDirectory, options)).rejects.toThrow(
      /sha256 differs/u,
    );

    const invalidSize = structuredClone(valid);
    invalidSize.assets.Princess.size = princess.length + 1;
    await writeJson(manifestPath, invalidSize);
    await expect(createDeterministicSb3(fixtureSourceDirectory, options)).rejects.toThrow(
      /size differs/u,
    );

    const invalidRate = structuredClone(valid);
    invalidRate.assets.PrincessSound.rate = 44_100;
    await writeJson(manifestPath, invalidRate);
    await expect(createDeterministicSb3(fixtureSourceDirectory, options)).rejects.toThrow(
      /rate differs/u,
    );

    const duplicateTarget = structuredClone(valid);
    duplicateTarget.sprites.Stage = duplicateTarget.sprites.Princess;
    delete duplicateTarget.sprites.Princess;
    duplicateTarget.assets.Princess.target = 'Stage';
    await writeJson(manifestPath, duplicateTarget);
    await expect(createDeterministicSb3(fixtureSourceDirectory, options)).rejects.toThrow(
      /already exists in the project/u,
    );

    const duplicateCostume = structuredClone(valid);
    duplicateCostume.assets.PrincessAgain = {
      ...duplicateCostume.assets.Princess,
      name: 'Princess',
    };
    await writeJson(manifestPath, duplicateCostume);
    await expect(createDeterministicSb3(fixtureSourceDirectory, options)).rejects.toThrow(
      /name already exists/u,
    );

    const linkedPath = path.join(inputsDirectory, 'Linked.png');
    await symlink(princessPath, linkedPath);
    const symbolicLink = structuredClone(valid);
    symbolicLink.assets.Princess.file = '../inputs/Linked.png';
    await writeJson(manifestPath, symbolicLink);
    await expect(createDeterministicSb3(fixtureSourceDirectory, options)).rejects.toThrow(
      /must not traverse a symbolic link/u,
    );
  });
});

test('rejects YAML composition features and duplicate JSON or YAML keys', async () => {
  await withTemporaryDirectory(async (directory) => {
    const aliasesPath = path.join(directory, 'aliases.yml');
    const duplicateYamlPath = path.join(directory, 'duplicate.yml');
    const duplicateJsonPath = path.join(directory, 'duplicate.json');
    await Promise.all([
      writeFile(aliasesPath, 'formatVersion: 1\nsprites: &sprites {}\nassets: *sprites\n'),
      writeFile(duplicateYamlPath, 'formatVersion: 1\nassets: {}\nassets: {}\n'),
      writeFile(duplicateJsonPath, '{"formatVersion":1,"assets":{},"assets":{}}\n'),
    ]);
    for (const manifestPath of [aliasesPath, duplicateYamlPath, duplicateJsonPath]) {
      await expect(
        createDeterministicSb3(fixtureSourceDirectory, {projectAssetsPath: manifestPath}),
      ).rejects.toThrow(/aliases and anchors|Map keys must be unique/u);
    }
  });
});
