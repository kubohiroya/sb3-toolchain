// SPDX-License-Identifier: MPL-2.0

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {strFromU8, unzipSync} from 'fflate';
import {stringify} from 'yaml';

import {parseCliArguments, runCli} from '../src/cli.js';
import {buildSb3, createDeterministicSb3} from '../src/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureSourceDirectory = path.join(projectRoot, 'test/fixtures/minimal-source');

function md5(contents) {
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

async function withTemporaryDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sb3-toolchain-project-assets-test-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

async function writeJson(filePath, value) {
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

function image(kind, file, extra = {}) {
  return {
    kind,
    file,
    bitmapResolution: 2,
    rotationCenterX: 507,
    rotationCenterY: 507,
    ...extra,
  };
}

function manifest() {
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
    assert.deepEqual(Buffer.from(first.archive), Buffer.from(second.archive));
    assert.deepEqual(Buffer.from(first.archive), Buffer.from(yaml.archive));
    assert.deepEqual(first.projectAssetAdditions, {
      assetFileCount: 2,
      backdropCount: 1,
      costumeCount: 1,
      soundCount: 1,
      spriteCount: 1,
    });
    assert.equal(first.assetCount, 3);
    assert.equal(first.assetReferenceCount, 4);
    assert.equal(first.entryCount, 4);

    const archive = unzipSync(first.archive);
    const project = JSON.parse(strFromU8(archive['project.json']));
    const stage = project.targets.find(({isStage}) => isStage);
    assert.deepEqual(
      stage.costumes.map(({name}) => name),
      ['pixel', 'Sunset'],
    );
    const princessTargets = project.targets.filter(({name}) => name === 'Princess');
    assert.equal(princessTargets.length, 1);
    assert.deepEqual(princessTargets[0], {
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
    assert.deepEqual(Buffer.from(archive[`${md5(princess)}.png`]), princess);
    assert.deepEqual(Buffer.from(archive[`${md5(voice)}.wav`]), voice);
    assert.equal(
      await readFile(path.join(fixtureSourceDirectory, 'project.source.json'), 'utf8'),
      sourceBefore,
    );

    const built = await buildSb3({
      ...options,
      outputPath,
      projectAssetsPath: yamlManifestPath,
      sourceDirectory: fixtureSourceDirectory,
    });
    assert.equal(built.changed, true);
    assert.deepEqual(await readFile(outputPath), Buffer.from(first.archive));

    const cliOutputPath = path.join(directory, 'cli-project.sb3');
    const messages = [];
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
    assert.deepEqual(await readFile(cliOutputPath), Buffer.from(first.archive));
    assert.match(messages[0], /^Built: .* \(4 entries, 3 assets,/u);
  });
});

test('parses project asset options for check and build', () => {
  assert.deepEqual(
    parseCliArguments([
      'check',
      'source',
      '--project-assets',
      'project-assets.yml',
      '--allow-asset-root',
      'resources',
    ]),
    {
      allowedAssetRoots: [path.resolve('resources')],
      command: 'check',
      projectAssetsPath: path.resolve('project-assets.yml'),
      sourceDirectory: path.resolve('source'),
    },
  );
  assert.deepEqual(
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
    {
      allowedAssetRoots: [path.resolve('resources')],
      command: 'build',
      outputPath: path.resolve('output.sb3'),
      projectAssetsPath: path.resolve('project-assets.json'),
      sourceDirectory: path.resolve('source'),
      yes: true,
    },
  );
  assert.throws(
    () =>
      parseCliArguments(['build', 'source', '--output', 'output.sb3', '--allow-asset-root', '.']),
    /requires --project-assets/u,
  );
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
    await assert.rejects(
      createDeterministicSb3(fixtureSourceDirectory, {projectAssetsPath: manifestPath}),
      /outside the allowed project asset roots/u,
    );

    const options = {allowedAssetRoots: [directory], projectAssetsPath: manifestPath};
    const invalidHash = structuredClone(valid);
    invalidHash.assets.Princess.sha256 = '0'.repeat(64);
    await writeJson(manifestPath, invalidHash);
    await assert.rejects(
      createDeterministicSb3(fixtureSourceDirectory, options),
      /sha256 differs/u,
    );

    const invalidSize = structuredClone(valid);
    invalidSize.assets.Princess.size = princess.length + 1;
    await writeJson(manifestPath, invalidSize);
    await assert.rejects(createDeterministicSb3(fixtureSourceDirectory, options), /size differs/u);

    const invalidRate = structuredClone(valid);
    invalidRate.assets.PrincessSound.rate = 44_100;
    await writeJson(manifestPath, invalidRate);
    await assert.rejects(createDeterministicSb3(fixtureSourceDirectory, options), /rate differs/u);

    const duplicateTarget = structuredClone(valid);
    duplicateTarget.sprites.Stage = duplicateTarget.sprites.Princess;
    delete duplicateTarget.sprites.Princess;
    duplicateTarget.assets.Princess.target = 'Stage';
    await writeJson(manifestPath, duplicateTarget);
    await assert.rejects(
      createDeterministicSb3(fixtureSourceDirectory, options),
      /already exists in the project/u,
    );

    const duplicateCostume = structuredClone(valid);
    duplicateCostume.assets.PrincessAgain = {
      ...duplicateCostume.assets.Princess,
      name: 'Princess',
    };
    await writeJson(manifestPath, duplicateCostume);
    await assert.rejects(
      createDeterministicSb3(fixtureSourceDirectory, options),
      /name already exists/u,
    );

    const linkedPath = path.join(inputsDirectory, 'Linked.png');
    await symlink(princessPath, linkedPath);
    const symbolicLink = structuredClone(valid);
    symbolicLink.assets.Princess.file = '../inputs/Linked.png';
    await writeJson(manifestPath, symbolicLink);
    await assert.rejects(
      createDeterministicSb3(fixtureSourceDirectory, options),
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
      await assert.rejects(
        createDeterministicSb3(fixtureSourceDirectory, {projectAssetsPath: manifestPath}),
        /aliases and anchors|Map keys must be unique/u,
      );
    }
  });
});
