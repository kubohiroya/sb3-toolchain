// SPDX-License-Identifier: MPL-2.0

import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {strFromU8, strToU8, unzipSync} from 'fflate';
import {expect, test} from 'vitest';

import {parseCliArguments, runCli} from '../src/cli';
import {
  buildSb3,
  compareDirectories,
  createDeterministicSb3,
  importSb3,
  packageVersion,
  validateSb3Source,
} from '../src/index';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureSourceDirectory = path.join(projectRoot, 'test/fixtures/minimal-source');

async function withTemporaryDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sb3-toolchain-build-test-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeMinimalSource(sourceDirectory: string): Promise<{assetFilename: string}> {
  const assetsDirectory = path.join(sourceDirectory, 'assets');
  const extensionsDirectory = path.join(sourceDirectory, 'extensions');
  await mkdir(assetsDirectory, {recursive: true});
  await mkdir(extensionsDirectory, {recursive: true});
  const assetContents = strToU8('<svg>asset</svg>');
  const assetId = createHash('md5').update(assetContents).digest('hex');
  const assetFilename = `${assetId}.svg`;
  await writeFile(path.join(assetsDirectory, assetFilename), assetContents);
  await writeFile(
    path.join(extensionsDirectory, 'custom.js'),
    'Scratch.extensions.register(new Custom());\n',
  );
  await writeJson(path.join(sourceDirectory, 'project.source.json'), {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        costumes: [
          {
            name: 'asset',
            assetId,
            dataFormat: 'svg',
            md5ext: assetFilename,
          },
        ],
        sounds: [],
      },
    ],
    extensionURLs: {
      custom: 'embedded-extension:extensions/custom.js',
      external: 'https://extensions.turbowarp.org/text.js',
    },
    meta: {semver: '3.0.0'},
  });
  await writeJson(path.join(sourceDirectory, 'embedded-extensions.json'), {
    formatVersion: 1,
    extensions: [
      {
        id: 'custom',
        path: 'extensions/custom.js',
        mediaType: 'text/javascript',
        parameters: [],
        encoding: 'base64',
      },
    ],
  });
  await writeJson(path.join(sourceDirectory, 'sb3-source.json'), {
    formatVersion: 1,
    project: 'project.source.json',
    embeddedExtensions: 'embedded-extensions.json',
    assetsDirectory: 'assets',
    archiveEntries: ['project.json', assetFilename],
  });
  return {assetFilename};
}

function readCentralDirectory(archive: Uint8Array) {
  const bytes = Buffer.from(archive);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  expect(endOffset, 'ZIP end-of-central-directory record is missing').not.toBe(-1);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  let offset = bytes.readUInt32LE(endOffset + 16);
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    expect(bytes.readUInt32LE(offset)).toBe(0x02014b50);
    const fileNameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    entries.push({
      date: bytes.readUInt16LE(offset + 14),
      name: bytes.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8'),
      time: bytes.readUInt16LE(offset + 12),
    });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

test('validates the fixture source and builds bit-for-bit deterministic SB3 archives', async () => {
  const validated = await validateSb3Source(fixtureSourceDirectory);
  expect(validated.assetContents.size).toBe(1);
  expect(validated.assetReferenceCount).toBe(1);
  expect(validated.extensions.length).toBe(1);

  const [first, second] = await Promise.all([
    createDeterministicSb3(fixtureSourceDirectory),
    createDeterministicSb3(fixtureSourceDirectory),
  ]);
  expect(Buffer.from(first.archive)).toStrictEqual(Buffer.from(second.archive));
  const centralEntries = readCentralDirectory(first.archive);
  expect(centralEntries.map((entry) => entry.name)).toStrictEqual(
    validated.sourceManifest.archiveEntries,
  );
  expect(centralEntries.every((entry) => entry.time === 0 && entry.date === 33)).toBe(true);

  const archive = unzipSync(first.archive);
  const project = JSON.parse(strFromU8(archive['project.json']));
  expect(project.extensionURLs.example).toMatch(/^data:text\/javascript;base64,/u);
  expect(project.extensionURLs.external).toBe('https://extensions.turbowarp.org/text.js');
});

test('build leaves identical output untouched and round-trips without source differences', async () => {
  await withTemporaryDirectory(async (directory) => {
    const outputPath = path.join(directory, 'kamishibai.sb3');
    const roundTripDirectory = path.join(directory, 'round-trip');
    const first = await buildSb3({sourceDirectory: fixtureSourceDirectory, outputPath});
    const second = await buildSb3({sourceDirectory: fixtureSourceDirectory, outputPath});
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);

    await importSb3({inputPath: outputPath, outputDirectory: roundTripDirectory});
    const comparison = await compareDirectories(fixtureSourceDirectory, roundTripDirectory);
    expect(comparison.identical).toBe(true);
    expect(comparison.differences).toStrictEqual({added: [], modified: [], removed: []});
  });
});

test('build preserves differing output unless replacement is explicitly authorized', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    const outputPath = path.join(directory, 'kamishibai.sb3');
    await writeMinimalSource(sourceDirectory);
    await writeFile(outputPath, 'existing output');

    await expect(buildSb3({sourceDirectory, outputPath})).rejects.toThrow(
      /Non-interactive replacement requires --yes/u,
    );
    expect(await readFile(outputPath, 'utf8')).toBe('existing output');

    await expect(
      buildSb3({
        sourceDirectory,
        outputPath,
        confirmReplace: async () => {
          await writeFile(outputPath, 'changed during confirmation');
          return true;
        },
      }),
    ).rejects.toThrow(/changed while the build was running/u);
    expect(await readFile(outputPath, 'utf8')).toBe('changed during confirmation');

    const result = await buildSb3({sourceDirectory, outputPath, yes: true});
    expect(result.changed).toBe(true);
    expect(unzipSync(await readFile(outputPath))['project.json']).toBeTruthy();
  });
});

test('build stops when an interrupted rollback file exists', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    const outputPath = path.join(directory, 'kamishibai.sb3');
    const rollbackPath = path.join(directory, '.kamishibai.sb3.rollback-interrupted');
    await writeMinimalSource(sourceDirectory);
    await buildSb3({sourceDirectory, outputPath});
    await writeFile(rollbackPath, 'previous output');

    await expect(buildSb3({sourceDirectory, outputPath})).rejects.toThrow(
      /interrupted SB3 build rollback file/u,
    );
  });
});

test('rejects duplicate archive entries and extra asset files', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    const {assetFilename} = await writeMinimalSource(sourceDirectory);
    const manifestPath = path.join(sourceDirectory, 'sb3-source.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.archiveEntries.push(assetFilename);
    await writeJson(manifestPath, manifest);
    await expect(validateSb3Source(sourceDirectory)).rejects.toThrow(/Duplicate archive entry/u);

    manifest.archiveEntries.pop();
    await writeJson(manifestPath, manifest);
    await writeFile(path.join(sourceDirectory, 'assets/extra.svg'), '<svg/>');
    await expect(validateSb3Source(sourceDirectory)).rejects.toThrow(/Extra: extra.svg/u);
  });
});

test('rejects asset content hash and embedded extension mapping mismatches', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    const {assetFilename} = await writeMinimalSource(sourceDirectory);
    await writeFile(path.join(sourceDirectory, 'assets', assetFilename), '<svg>changed</svg>');
    await expect(validateSb3Source(sourceDirectory)).rejects.toThrow(
      /Asset content hash mismatch/u,
    );

    await writeMinimalSource(sourceDirectory);
    const projectPath = path.join(sourceDirectory, 'project.source.json');
    const project = JSON.parse(await readFile(projectPath, 'utf8'));
    project.extensionURLs.custom = 'embedded-extension:extensions/other.js';
    await writeJson(projectPath, project);
    await expect(validateSb3Source(sourceDirectory)).rejects.toThrow(/mapping does not match/u);
  });
});

test('parses build and check CLI options', () => {
  expect(parseCliArguments(['--help'])).toStrictEqual({command: 'help'});
  expect(
    parseCliArguments(['build', 'custom-source', '--output', 'project.sb3', '--yes']),
  ).toStrictEqual({
    command: 'build',
    outputPath: path.resolve('project.sb3'),
    sourceDirectory: path.resolve('custom-source'),
    yes: true,
  });
  expect(parseCliArguments(['check', 'custom-source'])).toStrictEqual({
    command: 'check',
    sourceDirectory: path.resolve('custom-source'),
  });
  expect(parseCliArguments(['extensions', 'status', 'custom-source'])).toStrictEqual({
    action: 'status',
    command: 'extensions',
    sourceDirectory: path.resolve('custom-source'),
  });
  expect(parseCliArguments(['extensions', 'sync', 'custom-source', '--yes'])).toStrictEqual({
    action: 'sync',
    command: 'extensions',
    extensionId: undefined,
    migrateToId: undefined,
    sourceArtifact: undefined,
    sourceDirectory: path.resolve('custom-source'),
    yes: true,
  });
  expect(
    parseCliArguments(['extensions', 'update', 'custom-source', 'example', '--yes']),
  ).toStrictEqual({
    action: 'update',
    command: 'extensions',
    extensionId: 'example',
    migrateToId: undefined,
    sourceArtifact: undefined,
    sourceDirectory: path.resolve('custom-source'),
    yes: true,
  });
  expect(
    parseCliArguments([
      'extensions',
      'update',
      'custom-source',
      'example',
      '--allow-breaking-api',
      '--yes',
    ]),
  ).toStrictEqual({
    action: 'update',
    allowBreakingApi: true,
    command: 'extensions',
    extensionId: 'example',
    migrateToId: undefined,
    sourceArtifact: undefined,
    sourceDirectory: path.resolve('custom-source'),
    yes: true,
  });
  expect(
    parseCliArguments([
      'extensions',
      'update',
      'custom-source',
      'oldId',
      '--migrate-id',
      'newid',
      '--artifact',
      'dist/newid.js',
      '--api-manifest-artifact',
      'dist/newid.manifest.json',
      '--yes',
    ]),
  ).toStrictEqual({
    action: 'update',
    apiManifestArtifact: 'dist/newid.manifest.json',
    command: 'extensions',
    extensionId: 'oldId',
    migrateToId: 'newid',
    sourceArtifact: 'dist/newid.js',
    sourceDirectory: path.resolve('custom-source'),
    yes: true,
  });
  expect(
    parseCliArguments([
      'extensions',
      'migrate-id',
      'custom-source',
      '--from',
      'oldId',
      '--to',
      'newid',
      '--yes',
    ]),
  ).toStrictEqual({
    action: 'migrate-id',
    command: 'extensions',
    fromId: 'oldId',
    sourceDirectory: path.resolve('custom-source'),
    toId: 'newid',
    yes: true,
  });
  expect(() => parseCliArguments(['build', 'custom-source', '--output'])).toThrow(
    /requires a value/u,
  );
  expect(() => parseCliArguments(['extensions', 'sync', 'custom-source', 'extra'])).toThrow(
    /accepts only SOURCE_DIR/u,
  );
  expect(() =>
    parseCliArguments(['extensions', 'update', 'custom-source', '--allow-breaking-api']),
  ).toThrow(/requires --yes/u);
  expect(() =>
    parseCliArguments([
      'extensions',
      'update',
      'custom-source',
      '--api-manifest-artifact',
      'dist/newid.manifest.json',
    ]),
  ).toThrow(/requires --migrate-id/u);
});

test('keeps package metadata and the public CLI/API version aligned', async () => {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const messages: string[] = [];

  await runCli(['--version'], {log: (message) => messages.push(message)});

  expect(packageVersion).toBe(packageJson.version);
  expect(messages).toStrictEqual([packageJson.version]);
});
