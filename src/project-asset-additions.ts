// SPDX-License-Identifier: MPL-2.0

import {createHash} from 'node:crypto';
import {lstat, readFile, realpath} from 'node:fs/promises';
import path from 'node:path';

import {parseBuffer} from 'music-metadata';
import {isAlias, isPair, parseAllDocuments, visit} from 'yaml';

export const projectAssetAdditionsFormatVersion = 1;

const maximumManifestBytes = 1024 * 1024;
const forbiddenMappingKeys = new Set(['__proto__', 'constructor', 'prototype']);
const lockedAssetKeys = new Set(['name', 'file', 'size', 'sha256', 'dataFormat', 'license']);
const imageAssetKeys = new Set([
  ...lockedAssetKeys,
  'kind',
  'target',
  'bitmapResolution',
  'rotationCenterX',
  'rotationCenterY',
]);
const soundAssetKeys = new Set([...lockedAssetKeys, 'kind', 'target', 'rate', 'sampleCount']);
const imageFormats = new Set(['svg', 'png', 'jpg', 'jpeg', 'gif']);
const soundFormats = new Map([
  ['wav', 'audio/wav'],
  ['mp3', 'audio/mpeg'],
]);

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
    typeof value === 'string' &&
      value.length > 0 &&
      value === value.normalize('NFC') &&
      !/[\u0000-\u001f\u007f]/u.test(value),
    `${description} must be a non-empty NFC string without control characters.`,
  );
  assert(!forbiddenMappingKeys.has(value), `${description} is not supported: ${value}`);
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

function parseRestrictedYaml(source, manifestPath) {
  const documents = parseAllDocuments(source, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
    version: '1.2',
  });
  const parserIssues = documents.flatMap((document) => [...document.errors, ...document.warnings]);
  assert(
    parserIssues.length === 0,
    `Project asset additions manifest is not valid YAML: ${manifestPath} ` +
      `(${parserIssues[0]?.message})`,
  );
  assert(
    documents.length === 1,
    `Project asset additions manifest must contain exactly one YAML document: ${manifestPath}`,
  );
  let restrictedFeature;
  visit(documents[0], (_key, node) => {
    if (restrictedFeature) return visit.BREAK;
    const yamlNode = /** @type {any} */ (node);
    if (isAlias(node) || yamlNode?.anchor) restrictedFeature = 'aliases and anchors';
    else if (isPair(node) && yamlNode.key?.value === '<<') restrictedFeature = 'merge keys';
    else if (yamlNode?.tag) restrictedFeature = 'custom tags';
    else if (isPair(node) && forbiddenMappingKeys.has(String(yamlNode.key?.value))) {
      restrictedFeature = `mapping key ${String(yamlNode.key.value)}`;
    }
    return undefined;
  });
  assert(
    !restrictedFeature,
    `Project asset additions YAML does not support ${restrictedFeature}: ${manifestPath}`,
  );
  return documents[0].toJS({maxAliasCount: 0});
}

async function readManifestFile(filePath) {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    throw new Error(`Project asset additions manifest is not readable: ${filePath}`, {
      cause: error,
    });
  }
  assert(
    stats.isFile() && !stats.isSymbolicLink(),
    `Project asset additions manifest must be a regular file, not a symbolic link: ${filePath}`,
  );
  assert(
    stats.size <= maximumManifestBytes,
    `Project asset additions manifest exceeds ${maximumManifestBytes} bytes: ${filePath}`,
  );
  const source = await readFile(filePath, 'utf8');
  const extension = path.extname(filePath).toLowerCase();
  assert(
    extension === '.json' || extension === '.yml' || extension === '.yaml',
    `Project asset additions manifest must use .json, .yml, or .yaml: ${filePath}`,
  );
  if (extension === '.json') {
    let value;
    try {
      value = JSON.parse(source);
    } catch (error) {
      throw new Error(`Project asset additions manifest is not valid JSON: ${filePath}`, {
        cause: error,
      });
    }
    parseRestrictedYaml(source, filePath);
    return value;
  }
  return parseRestrictedYaml(source, filePath);
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
}

async function validateAllowedRoots(manifestDirectory, allowedAssetRoots) {
  assert(Array.isArray(allowedAssetRoots), 'allowedAssetRoots must be an array.');
  const roots = [manifestDirectory, ...allowedAssetRoots].map((root) => {
    assert(typeof root === 'string', 'Every allowed project asset root must be a string.');
    return path.resolve(root);
  });
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

async function readAssetFile(manifestDirectory, allowedRoots, specification, description) {
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
  if (specification.size !== undefined) {
    const expectedSize = safeInteger(specification.size, `${description}.size`);
    assert(
      contents.length === expectedSize,
      `${description}.size differs: expected ${expectedSize}, got ${contents.length}`,
    );
  }
  if (specification.sha256 !== undefined) {
    assert(
      typeof specification.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(specification.sha256),
      `${description}.sha256 must be a lowercase SHA-256 hex digest.`,
    );
    const actualSha256 = sha256(contents);
    assert(
      actualSha256 === specification.sha256,
      `${description}.sha256 differs: expected ${specification.sha256}, got ${actualSha256}`,
    );
  }
  const inferredDataFormat = path.extname(file).slice(1).toLowerCase();
  assert(
    /^[a-z0-9]+$/u.test(inferredDataFormat),
    `${description}.file extension is invalid: ${file}`,
  );
  if (specification.dataFormat !== undefined) {
    const expectedDataFormat = nonEmptyString(
      specification.dataFormat,
      `${description}.dataFormat`,
    );
    assert(
      expectedDataFormat === inferredDataFormat,
      `${description}.dataFormat differs: expected ${expectedDataFormat}, got ${inferredDataFormat}`,
    );
  }
  if (specification.license !== undefined) {
    nonEmptyString(specification.license, `${description}.license`);
  }
  return {
    contents,
    dataFormat: inferredDataFormat,
    file,
    name: specification.name,
  };
}

async function inferSoundMetadata(contents, dataFormat, description) {
  const mimeType = soundFormats.get(dataFormat);
  assert(mimeType, `${description}.file uses unsupported sound format: ${dataFormat}`);
  let metadata;
  try {
    metadata = await parseBuffer(
      contents,
      {mimeType, size: contents.length},
      {duration: true, skipCovers: true},
    );
  } catch (error) {
    throw new Error(`${description}.file is not valid ${dataFormat} audio.`, {cause: error});
  }
  const rate = metadata.format.sampleRate;
  const sampleCount =
    metadata.format.numberOfSamples ??
    (typeof metadata.format.duration === 'number' && typeof rate === 'number'
      ? Math.round(metadata.format.duration * rate)
      : undefined);
  safeInteger(rate, `${description} inferred sample rate`, 1);
  safeInteger(sampleCount, `${description} inferred sample count`);
  return {rate, sampleCount};
}

function validateSprite(specification, name) {
  const description = `Project asset sprite ${JSON.stringify(name)}`;
  assert(isRecord(specification), `${description} must be an object.`);
  exactKeys(
    specification,
    new Set([
      'layerOrder',
      'visible',
      'x',
      'y',
      'size',
      'direction',
      'draggable',
      'rotationStyle',
      'volume',
    ]),
    description,
  );
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
}

function validateAsset(specification, assetId) {
  const description = `Project asset ${JSON.stringify(assetId)}`;
  assert(isRecord(specification), `${description} must be an object.`);
  assert(
    specification.kind === 'backdrop' ||
      specification.kind === 'costume' ||
      specification.kind === 'sound',
    `${description}.kind must be backdrop, costume, or sound.`,
  );
  exactKeys(
    specification,
    specification.kind === 'sound' ? soundAssetKeys : imageAssetKeys,
    description,
  );
  if (specification.kind === 'backdrop') {
    assert(
      specification.target === undefined,
      `${description}.target is not valid for a backdrop.`,
    );
  } else if (specification.kind === 'costume') {
    nonEmptyString(specification.target, `${description}.target`);
  } else if (specification.target !== undefined) {
    nonEmptyString(specification.target, `${description}.target`);
  }
  if (specification.name !== undefined) nonEmptyString(specification.name, `${description}.name`);
  return description;
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
 * Validate a JSON or YAML project-assets manifest and compose it into one in-memory build.
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
    readManifestFile(resolvedManifestPath),
    validateAllowedRoots(manifestDirectory, allowedAssetRoots),
  ]);
  assert(isRecord(manifest), 'Project asset additions manifest must be an object.');
  exactKeys(
    manifest,
    new Set(['formatVersion', 'sprites', 'assets']),
    'Project asset additions manifest',
  );
  assert(
    manifest.formatVersion === projectAssetAdditionsFormatVersion,
    `Unsupported project asset additions formatVersion: ${manifest.formatVersion}`,
  );
  assert(
    manifest.sprites === undefined || isRecord(manifest.sprites),
    'Project asset additions sprites must be an object when present.',
  );
  assert(
    isRecord(manifest.assets) && Object.keys(manifest.assets).length > 0,
    'Project asset additions assets must be a non-empty object.',
  );
  assert(Array.isArray(project.targets), 'Project asset additions require project.targets.');

  const composedProject = structuredClone(project);
  const composedAssetContents = new Map(assetContents);
  const composedArchiveEntries = [...archiveEntries];
  const targetByName = new Map();
  for (const target of composedProject.targets) {
    const targetName = nonEmptyString(target.name, 'Existing project target name');
    assert(!targetByName.has(targetName), `Project has duplicate target name: ${targetName}`);
    assert(
      Array.isArray(target.costumes),
      `Project target ${targetName}.costumes must be an array.`,
    );
    assert(Array.isArray(target.sounds), `Project target ${targetName}.sounds must be an array.`);
    targetByName.set(targetName, target);
  }
  const stages = composedProject.targets.filter(({isStage}) => isStage);
  assert(stages.length === 1, 'Project asset additions require exactly one Stage target.');
  const stage = stages[0];
  const newSpriteNames = [];

  for (const [rawName, specification] of Object.entries(manifest.sprites ?? {})) {
    const name = nonEmptyString(rawName, 'Project asset sprite name');
    validateSprite(specification, name);
    assert(!targetByName.has(name), `Project asset sprite already exists in the project: ${name}`);
    const target = {
      isStage: false,
      name,
      variables: {},
      lists: {},
      broadcasts: {},
      blocks: {},
      comments: {},
      currentCostume: 0,
      costumes: [],
      sounds: [],
      volume: specification.volume,
      layerOrder: specification.layerOrder,
      visible: specification.visible,
      x: specification.x,
      y: specification.y,
      size: specification.size,
      direction: specification.direction,
      draggable: specification.draggable,
      rotationStyle: specification.rotationStyle,
    };
    composedProject.targets.push(target);
    targetByName.set(name, target);
    newSpriteNames.push(name);
  }

  let backdropCount = 0;
  let costumeCount = 0;
  let soundCount = 0;
  let assetFileCount = 0;

  for (const [rawAssetId, specification] of Object.entries(manifest.assets)) {
    const assetId = nonEmptyString(rawAssetId, 'Project asset ID');
    const description = validateAsset(specification, assetId);
    const asset = await readAssetFile(manifestDirectory, allowedRoots, specification, description);
    if (specification.kind !== 'sound') {
      assert(
        imageFormats.has(asset.dataFormat),
        `${description}.file uses unsupported image format: ${asset.dataFormat}`,
      );
    }
    const scratchName = asset.name ?? assetId;
    const owner =
      specification.kind === 'backdrop' || specification.target === undefined
        ? stage
        : targetByName.get(specification.target);
    assert(owner, `${description}.target does not exist in the project: ${specification.target}`);
    assert(
      specification.kind === 'backdrop' || !owner.isStage || specification.kind === 'sound',
      `${description}.target must name a sprite.`,
    );
    assert(
      specification.kind !== 'sound' || specification.target === undefined || !owner.isStage,
      `${description}.target must be omitted for a Stage sound.`,
    );
    const collection = specification.kind === 'sound' ? owner.sounds : owner.costumes;
    assert(
      !collection.some(({name}) => name === scratchName),
      `${description}.name already exists on target ${owner.name}: ${scratchName}`,
    );
    const contentAssetId = md5(asset.contents);
    const filename = `${contentAssetId}.${asset.dataFormat}`;
    if (
      addAssetContents(
        composedAssetContents,
        composedArchiveEntries,
        asset.contents,
        filename,
        description,
      )
    ) {
      assetFileCount += 1;
    }
    if (specification.kind === 'sound') {
      const inferred = await inferSoundMetadata(asset.contents, asset.dataFormat, description);
      if (specification.rate !== undefined) {
        const expectedRate = safeInteger(specification.rate, `${description}.rate`, 1);
        assert(
          inferred.rate === expectedRate,
          `${description}.rate differs: expected ${expectedRate}, got ${inferred.rate}`,
        );
      }
      if (specification.sampleCount !== undefined) {
        const expectedSampleCount = safeInteger(
          specification.sampleCount,
          `${description}.sampleCount`,
        );
        assert(
          inferred.sampleCount === expectedSampleCount,
          `${description}.sampleCount differs: expected ${expectedSampleCount}, got ${inferred.sampleCount}`,
        );
      }
      collection.push({
        name: scratchName,
        assetId: contentAssetId,
        dataFormat: asset.dataFormat,
        format: '',
        md5ext: filename,
        rate: inferred.rate,
        sampleCount: inferred.sampleCount,
      });
      soundCount += 1;
    } else {
      const bitmapResolution =
        specification.bitmapResolution === undefined
          ? 1
          : safeInteger(specification.bitmapResolution, `${description}.bitmapResolution`, 1);
      assert(
        bitmapResolution === 1 || bitmapResolution === 2,
        `${description}.bitmapResolution must be 1 or 2.`,
      );
      collection.push({
        name: scratchName,
        bitmapResolution,
        dataFormat: asset.dataFormat,
        assetId: contentAssetId,
        md5ext: filename,
        rotationCenterX: finiteNumber(
          specification.rotationCenterX,
          `${description}.rotationCenterX`,
        ),
        rotationCenterY: finiteNumber(
          specification.rotationCenterY,
          `${description}.rotationCenterY`,
        ),
      });
      if (specification.kind === 'backdrop') backdropCount += 1;
      else costumeCount += 1;
    }
  }

  for (const name of newSpriteNames) {
    assert(
      targetByName.get(name).costumes.length > 0,
      `Project asset sprite must receive at least one costume: ${name}`,
    );
  }

  return {
    archiveEntries: composedArchiveEntries,
    assetContents: composedAssetContents,
    assetReferenceCount: backdropCount + costumeCount + soundCount,
    manifestPath: resolvedManifestPath,
    project: composedProject,
    summary: Object.freeze({
      assetFileCount,
      backdropCount,
      costumeCount,
      soundCount,
      spriteCount: newSpriteNames.length,
    }),
  };
}
