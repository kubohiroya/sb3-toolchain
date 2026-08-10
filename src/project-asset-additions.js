// SPDX-License-Identifier: MPL-2.0

import {createHash} from 'node:crypto';
import {lstat, readFile, realpath} from 'node:fs/promises';
import path from 'node:path';

export const projectAssetAdditionsFormatVersion = 1;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value, allowed, description) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  assert(unknown.length === 0, `${description} has unknown properties: ${unknown.join(', ')}`);
}

function nonEmptyString(value, description) {
  assert(
    typeof value === 'string' && value.length > 0 && !/[\r\n]/u.test(value),
    `${description} must be a non-empty single-line string.`,
  );
  return value;
}

function finiteNumber(value, description) {
  assert(typeof value === 'number' && Number.isFinite(value), `${description} must be finite.`);
  return value;
}

function safeInteger(value, description, minimum = 0) {
  assert(
    Number.isSafeInteger(value) && value >= minimum,
    `${description} must be a safe integer greater than or equal to ${minimum}.`,
  );
  return value;
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function md5(contents) {
  return createHash('md5').update(contents).digest('hex');
}

async function readJsonFile(filePath, description) {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    throw new Error(`${description} is not readable: ${filePath} (${error.message})`, {
      cause: error,
    });
  }
  assert(
    stats.isFile() && !stats.isSymbolicLink(),
    `${description} must be a regular file, not a symbolic link: ${filePath}`,
  );
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${description} is not valid JSON: ${filePath} (${error.message})`, {
      cause: error,
    });
  }
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
}

async function validateAllowedRoots(manifestDirectory, allowedAssetRoots) {
  assert(Array.isArray(allowedAssetRoots), 'allowedAssetRoots must be an array.');
  const roots = [manifestDirectory, ...allowedAssetRoots].map((root) => path.resolve(root));
  const uniqueRoots = [...new Set(roots)];
  return Promise.all(
    uniqueRoots.map(async (root) => {
      const stats = await lstat(root);
      assert(
        stats.isDirectory() && !stats.isSymbolicLink(),
        `Allowed project asset root must be a directory, not a symbolic link: ${root}`,
      );
      return {lexical: root, real: await realpath(root)};
    }),
  );
}

async function assertNoSymlinkPath(root, candidate, description) {
  const relative = path.relative(root, candidate);
  assert(isContained(root, candidate), `${description} escapes its allowed root: ${candidate}`);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stats = await lstat(current);
    assert(!stats.isSymbolicLink(), `${description} must not traverse a symbolic link: ${current}`);
  }
}

async function readLockedAsset(manifestDirectory, allowedRoots, specification, description) {
  exactKeys(
    specification,
    new Set([
      'name',
      'file',
      'size',
      'sha256',
      'dataFormat',
      'bitmapResolution',
      'rotationCenterX',
      'rotationCenterY',
      'rate',
      'sampleCount',
      'license',
    ]),
    description,
  );
  const file = nonEmptyString(specification.file, `${description}.file`);
  assert(!path.isAbsolute(file) && !file.includes('\\'), `${description}.file must be relative.`);
  const resolved = path.resolve(manifestDirectory, file);
  const lexicalRoot = allowedRoots.find(({lexical}) => isContained(lexical, resolved));
  assert(lexicalRoot, `${description}.file is outside the allowed project asset roots: ${file}`);
  await assertNoSymlinkPath(lexicalRoot.lexical, resolved, `${description}.file`);
  const stats = await lstat(resolved);
  assert(stats.isFile(), `${description}.file must be a regular file: ${resolved}`);
  const resolvedRealPath = await realpath(resolved);
  assert(
    allowedRoots.some(({real}) => isContained(real, resolvedRealPath)),
    `${description}.file resolves outside the allowed project asset roots: ${file}`,
  );
  const contents = await readFile(resolved);
  const size = safeInteger(specification.size, `${description}.size`);
  assert(
    contents.length === size,
    `${description}.size differs: expected ${size}, got ${contents.length}`,
  );
  assert(
    typeof specification.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(specification.sha256),
    `${description}.sha256 must be a lowercase SHA-256 hex digest.`,
  );
  const actualSha256 = sha256(contents);
  assert(
    actualSha256 === specification.sha256,
    `${description}.sha256 differs: expected ${specification.sha256}, got ${actualSha256}`,
  );
  const dataFormat = nonEmptyString(specification.dataFormat, `${description}.dataFormat`);
  assert(/^[a-z0-9]+$/u.test(dataFormat), `${description}.dataFormat is invalid: ${dataFormat}`);
  assert(
    path.extname(file).slice(1).toLowerCase() === dataFormat.toLowerCase(),
    `${description}.file extension must match dataFormat ${dataFormat}: ${file}`,
  );
  if (specification.license !== undefined) {
    nonEmptyString(specification.license, `${description}.license`);
  }
  return {
    contents,
    dataFormat,
    file,
    name: nonEmptyString(specification.name, `${description}.name`),
  };
}

function validateSprite(specification, index) {
  const description = `Project asset sprite ${index}`;
  assert(isRecord(specification), `${description} must be an object.`);
  exactKeys(
    specification,
    new Set([
      'name',
      'layerOrder',
      'visible',
      'x',
      'y',
      'size',
      'direction',
      'draggable',
      'rotationStyle',
      'volume',
      'costumes',
      'sounds',
    ]),
    description,
  );
  const name = nonEmptyString(specification.name, `${description}.name`);
  safeInteger(specification.layerOrder, `${description}.layerOrder`);
  assert(typeof specification.visible === 'boolean', `${description}.visible must be boolean.`);
  finiteNumber(specification.x, `${description}.x`);
  finiteNumber(specification.y, `${description}.y`);
  const size = finiteNumber(specification.size, `${description}.size`);
  assert(size > 0, `${description}.size must be greater than zero.`);
  finiteNumber(specification.direction, `${description}.direction`);
  assert(typeof specification.draggable === 'boolean', `${description}.draggable must be boolean.`);
  assert(
    ['all around', 'left-right', "don't rotate"].includes(specification.rotationStyle),
    `${description}.rotationStyle is invalid: ${specification.rotationStyle}`,
  );
  const volume = finiteNumber(specification.volume, `${description}.volume`);
  assert(volume >= 0 && volume <= 100, `${description}.volume must be between 0 and 100.`);
  assert(
    Array.isArray(specification.costumes) && specification.costumes.length > 0,
    `${description}.costumes must be a non-empty array.`,
  );
  assert(
    specification.sounds === undefined || Array.isArray(specification.sounds),
    `${description}.sounds must be an array when present.`,
  );
  return {description, name};
}

function addAssetContents(assetContents, archiveEntries, contents, filename, description) {
  const existing = assetContents.get(filename);
  if (existing) {
    assert(
      Buffer.from(existing).equals(contents),
      `${description} collides with different contents: ${filename}`,
    );
    return false;
  }
  assetContents.set(filename, contents);
  archiveEntries.push(filename);
  return true;
}

/**
 * Validate a JSON project-assets manifest and compose its sprites into one in-memory build.
 * The expanded source and all manifest inputs remain unchanged.
 */
export async function applyProjectAssetAdditions({
  allowedAssetRoots = [],
  assetContents,
  archiveEntries,
  manifestPath,
  project,
}) {
  assert(typeof manifestPath === 'string', 'projectAssetsPath must be a string.');
  assert(isRecord(project), 'Project asset additions require a project object.');
  assert(assetContents instanceof Map, 'Project asset additions require an asset contents Map.');
  assert(Array.isArray(archiveEntries), 'Project asset additions require archive entries.');
  const resolvedManifestPath = path.resolve(manifestPath);
  const manifestDirectory = path.dirname(resolvedManifestPath);
  const [manifest, allowedRoots] = await Promise.all([
    readJsonFile(resolvedManifestPath, 'Project asset additions manifest'),
    validateAllowedRoots(manifestDirectory, allowedAssetRoots),
  ]);
  assert(isRecord(manifest), 'Project asset additions manifest must be an object.');
  exactKeys(manifest, new Set(['formatVersion', 'sprites']), 'Project asset additions manifest');
  assert(
    manifest.formatVersion === projectAssetAdditionsFormatVersion,
    `Unsupported project asset additions formatVersion: ${manifest.formatVersion}`,
  );
  assert(
    Array.isArray(manifest.sprites) && manifest.sprites.length > 0,
    'Project asset additions sprites must be a non-empty array.',
  );
  assert(Array.isArray(project.targets), 'Project asset additions require project.targets.');

  const composedProject = structuredClone(project);
  const composedAssetContents = new Map(assetContents);
  const composedArchiveEntries = [...archiveEntries];
  const targetNames = new Set(composedProject.targets.map(({name}) => name));
  let costumeCount = 0;
  let soundCount = 0;
  let assetFileCount = 0;

  for (const [spriteIndex, specification] of manifest.sprites.entries()) {
    const {description, name} = validateSprite(specification, spriteIndex);
    assert(!targetNames.has(name), `${description}.name already exists in the project: ${name}`);
    targetNames.add(name);
    const costumes = [];
    const sounds = [];
    const costumeNames = new Set();
    const soundNames = new Set();

    for (const [costumeIndex, costume] of specification.costumes.entries()) {
      const assetDescription = `${description}.costumes[${costumeIndex}]`;
      assert(isRecord(costume), `${assetDescription} must be an object.`);
      const asset = await readLockedAsset(
        manifestDirectory,
        allowedRoots,
        costume,
        assetDescription,
      );
      exactKeys(
        costume,
        new Set([
          'name',
          'file',
          'size',
          'sha256',
          'dataFormat',
          'bitmapResolution',
          'rotationCenterX',
          'rotationCenterY',
          'license',
        ]),
        assetDescription,
      );
      assert(
        !costumeNames.has(asset.name),
        `${assetDescription}.name is duplicated: ${asset.name}`,
      );
      costumeNames.add(asset.name);
      const bitmapResolution = safeInteger(
        costume.bitmapResolution,
        `${assetDescription}.bitmapResolution`,
        1,
      );
      const assetId = md5(asset.contents);
      const filename = `${assetId}.${asset.dataFormat}`;
      if (
        addAssetContents(
          composedAssetContents,
          composedArchiveEntries,
          asset.contents,
          filename,
          assetDescription,
        )
      ) {
        assetFileCount += 1;
      }
      costumes.push({
        name: asset.name,
        bitmapResolution,
        dataFormat: asset.dataFormat,
        assetId,
        md5ext: filename,
        rotationCenterX: finiteNumber(
          costume.rotationCenterX,
          `${assetDescription}.rotationCenterX`,
        ),
        rotationCenterY: finiteNumber(
          costume.rotationCenterY,
          `${assetDescription}.rotationCenterY`,
        ),
      });
      costumeCount += 1;
    }

    for (const [soundIndex, sound] of (specification.sounds ?? []).entries()) {
      const assetDescription = `${description}.sounds[${soundIndex}]`;
      assert(isRecord(sound), `${assetDescription} must be an object.`);
      const asset = await readLockedAsset(manifestDirectory, allowedRoots, sound, assetDescription);
      exactKeys(
        sound,
        new Set(['name', 'file', 'size', 'sha256', 'dataFormat', 'rate', 'sampleCount', 'license']),
        assetDescription,
      );
      assert(!soundNames.has(asset.name), `${assetDescription}.name is duplicated: ${asset.name}`);
      soundNames.add(asset.name);
      const assetId = md5(asset.contents);
      const filename = `${assetId}.${asset.dataFormat}`;
      if (
        addAssetContents(
          composedAssetContents,
          composedArchiveEntries,
          asset.contents,
          filename,
          assetDescription,
        )
      ) {
        assetFileCount += 1;
      }
      sounds.push({
        name: asset.name,
        assetId,
        dataFormat: asset.dataFormat,
        format: '',
        md5ext: filename,
        rate: safeInteger(sound.rate, `${assetDescription}.rate`, 1),
        sampleCount: safeInteger(sound.sampleCount, `${assetDescription}.sampleCount`),
      });
      soundCount += 1;
    }

    composedProject.targets.push({
      isStage: false,
      name,
      variables: {},
      lists: {},
      broadcasts: {},
      blocks: {},
      comments: {},
      currentCostume: 0,
      costumes,
      sounds,
      volume: specification.volume,
      layerOrder: specification.layerOrder,
      visible: specification.visible,
      x: specification.x,
      y: specification.y,
      size: specification.size,
      direction: specification.direction,
      draggable: specification.draggable,
      rotationStyle: specification.rotationStyle,
    });
  }

  return {
    archiveEntries: composedArchiveEntries,
    assetContents: composedAssetContents,
    assetReferenceCount: costumeCount + soundCount,
    manifestPath: resolvedManifestPath,
    project: composedProject,
    summary: Object.freeze({
      assetFileCount,
      costumeCount,
      soundCount,
      spriteCount: manifest.sprites.length,
    }),
  };
}
