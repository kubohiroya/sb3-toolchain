// SPDX-License-Identifier: MPL-2.0

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {strFromU8, unzipSync} from 'fflate';

import {parseCliArguments, runCli} from '../src/cli.js';
import {buildSb3, createDeterministicSb3} from '../src/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureSourceDirectory = path.join(projectRoot, 'test/fixtures/minimal-source');

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function md5(contents) {
  return createHash('md5').update(contents).digest('hex');
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

function costume(name, file, contents) {
  return {
    name,
    file,
    size: contents.length,
    sha256: sha256(contents),
    dataFormat: 'png',
    bitmapResolution: 2,
    rotationCenterX: 507,
    rotationCenterY: 507,
  };
}

function sound(name, file, contents) {
  return {
    name,
    file,
    size: contents.length,
    sha256: sha256(contents),
    dataFormat: 'mp3',
    rate: 44_100,
    sampleCount: 12_345,
  };
}

function manifest(costumes, sounds = []) {
  return {
    formatVersion: 1,
    sprites: [
      {
        name: 'Princess',
        layerOrder: 6,
        visible: false,
        x: 4,
        y: -16,
        size: 70,
        direction: 90,
        draggable: false,
        rotationStyle: 'all around',
        volume: 100,
        costumes,
        sounds,
      },
    ],
  };
}

test('adds locked sprite assets from JSON without modifying the expanded source', async () => {
  await withTemporaryDirectory(async (directory) => {
    const configurationDirectory = path.join(directory, 'configuration');
    const assetsDirectory = path.join(directory, 'inputs');
    const manifestPath = path.join(configurationDirectory, 'project-assets.json');
    const outputPath = path.join(directory, 'project.sb3');
    const princess = Buffer.from('not-a-real-png-but-content-addressed');
    const voice = Buffer.from('not-a-real-mp3-but-content-addressed');
    const princessCostume = {
      ...costume('Princess', '../inputs/Princess.png', princess),
      license: 'CC-BY-SA-4.0: LICENSES.md',
    };
    await mkdir(assetsDirectory, {recursive: true});
    await Promise.all([
      writeFile(path.join(assetsDirectory, 'Princess.png'), princess),
      writeFile(path.join(assetsDirectory, 'Princess.mp3'), voice),
      writeJson(
        manifestPath,
        manifest([princessCostume], [sound('Princess', '../inputs/Princess.mp3', voice)]),
      ),
    ]);
    const sourceBefore = await readFile(
      path.join(fixtureSourceDirectory, 'project.source.json'),
      'utf8',
    );
    const options = {
      allowedAssetRoots: [directory],
      projectAssetsPath: manifestPath,
    };
    const [first, second] = await Promise.all([
      createDeterministicSb3(fixtureSourceDirectory, options),
      createDeterministicSb3(fixtureSourceDirectory, options),
    ]);
    assert.deepEqual(Buffer.from(first.archive), Buffer.from(second.archive));
    assert.deepEqual(first.projectAssetAdditions, {
      assetFileCount: 2,
      costumeCount: 1,
      soundCount: 1,
      spriteCount: 1,
    });
    assert.equal(first.assetCount, 3);
    assert.equal(first.assetReferenceCount, 3);
    assert.equal(first.entryCount, 4);

    const archive = unzipSync(first.archive);
    const project = JSON.parse(strFromU8(archive['project.json']));
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
          dataFormat: 'mp3',
          format: '',
          md5ext: `${md5(voice)}.mp3`,
          rate: 44_100,
          sampleCount: 12_345,
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
    assert.deepEqual(Buffer.from(archive[`${md5(voice)}.mp3`]), voice);
    assert.equal(
      await readFile(path.join(fixtureSourceDirectory, 'project.source.json'), 'utf8'),
      sourceBefore,
    );

    const built = await buildSb3({
      ...options,
      outputPath,
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
        manifestPath,
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
      'project-assets.json',
      '--allow-asset-root',
      'resources',
    ]),
    {
      allowedAssetRoots: [path.resolve('resources')],
      command: 'check',
      projectAssetsPath: path.resolve('project-assets.json'),
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

test('rejects unlocked, escaping, duplicate, and symbolic-link project assets', async () => {
  await withTemporaryDirectory(async (directory) => {
    const configurationDirectory = path.join(directory, 'configuration');
    const inputsDirectory = path.join(directory, 'inputs');
    const manifestPath = path.join(configurationDirectory, 'project-assets.json');
    const princessPath = path.join(inputsDirectory, 'Princess.png');
    const princess = Buffer.from('princess');
    await mkdir(inputsDirectory, {recursive: true});
    await writeFile(princessPath, princess);

    const validCostume = costume('Princess', '../inputs/Princess.png', princess);
    await writeJson(manifestPath, manifest([validCostume]));
    await assert.rejects(
      createDeterministicSb3(fixtureSourceDirectory, {projectAssetsPath: manifestPath}),
      /outside the allowed project asset roots/u,
    );

    const options = {allowedAssetRoots: [directory], projectAssetsPath: manifestPath};
    const invalidHash = structuredClone(validCostume);
    invalidHash.sha256 = '0'.repeat(64);
    await writeJson(manifestPath, manifest([invalidHash]));
    await assert.rejects(
      createDeterministicSb3(fixtureSourceDirectory, options),
      /sha256 differs/u,
    );

    const duplicateTarget = manifest([validCostume]);
    duplicateTarget.sprites[0].name = 'Stage';
    await writeJson(manifestPath, duplicateTarget);
    await assert.rejects(
      createDeterministicSb3(fixtureSourceDirectory, options),
      /already exists in the project/u,
    );

    await writeJson(manifestPath, manifest([validCostume, validCostume]));
    await assert.rejects(
      createDeterministicSb3(fixtureSourceDirectory, options),
      /name is duplicated/u,
    );

    const linkedPath = path.join(inputsDirectory, 'Linked.png');
    await symlink(princessPath, linkedPath);
    await writeJson(
      manifestPath,
      manifest([costume('Princess', '../inputs/Linked.png', princess)]),
    );
    await assert.rejects(
      createDeterministicSb3(fixtureSourceDirectory, options),
      /must not traverse a symbolic link/u,
    );
  });
});
