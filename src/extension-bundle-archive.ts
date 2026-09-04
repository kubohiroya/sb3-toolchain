// SPDX-License-Identifier: MPL-2.0

import {lstat, readFile} from 'node:fs/promises';
import path from 'node:path';

import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';

import {validateArchiveEntryName} from './archive.js';
import {writeSb3Archive} from './build.js';
import {extensionBundleRecoveryMarker} from './extension-bundle.js';
import {extensionHeaderMetadata} from './extension-dependencies.js';
import {decodeExtensionDataUrl} from './import.js';
import {fixedZipTimestamp} from './source.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function arraysEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateId(id, description) {
  assert(
    typeof id === 'string' && /^[a-z0-9]+$/u.test(id),
    `${description} must use TurboWarp's [a-z0-9]+ format: ${JSON.stringify(id)}`,
  );
  return id;
}

function decodeBase64Json(payload, description) {
  assert(
    typeof payload === 'string' && /^[A-Za-z0-9+/]*={0,2}$/u.test(payload),
    `${description} contains invalid base64.`,
  );
  const unpadded = payload.replace(/=+$/u, '');
  assert(unpadded.length % 4 !== 1, `${description} contains invalid base64.`);
  try {
    return JSON.parse(
      Buffer.from(unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, '='), 'base64').toString(
        'utf8',
      ),
    );
  } catch (error) {
    throw new Error(`${description} contains invalid JSON: ${error.message}`, {cause: error});
  }
}

function recoveryPayloadFromSource(source, requiredBundleId = undefined) {
  const prefix = `// ${extensionBundleRecoveryMarker}: `;
  const payloads = source
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
  if (payloads.length === 0) {
    assert(
      requiredBundleId === undefined,
      `Extension ${requiredBundleId} has no ${extensionBundleRecoveryMarker} recovery capsule.`,
    );
    return null;
  }
  assert(payloads.length === 1, 'Bundled extension contains more than one recovery capsule.');
  return payloads[0];
}

function validateOriginalOrder(value, description, nullable = false) {
  if (nullable && value === null) return null;
  assert(
    Array.isArray(value) && value.every((id) => typeof id === 'string' && id.length > 0),
    `Recovery capsule ${description} must be an array of IDs${nullable ? ' or null' : ''}.`,
  );
  assert(
    new Set(value).size === value.length,
    `Recovery capsule ${description} contains duplicate IDs.`,
  );
  return [...value];
}

function readRecoveryCapsule(extensionId, dataUrl, required = false) {
  assert(typeof dataUrl === 'string', `Extension URL for ${extensionId} must be a string.`);
  if (!dataUrl.startsWith('data:')) {
    assert(!required, `Extension ${extensionId} is not embedded as a data URL.`);
    return null;
  }
  const decodedBundle = decodeExtensionDataUrl(dataUrl);
  const payload = recoveryPayloadFromSource(
    Buffer.from(decodedBundle.source).toString('utf8'),
    required ? extensionId : undefined,
  );
  if (payload === null) return null;
  const capsule = decodeBase64Json(payload, `Extension ${extensionId} recovery capsule`);
  assert(isObject(capsule), `Extension ${extensionId} recovery capsule must be an object.`);
  assert(
    capsule.formatVersion === 1,
    `Unsupported extension bundle recovery format: ${capsule.formatVersion}`,
  );
  assert(isObject(capsule.bundle), `Extension ${extensionId} recovery capsule has no bundle.`);
  validateId(capsule.bundle.id, 'Recovery capsule bundle ID');
  assert(
    capsule.bundle.id === extensionId,
    `Recovery capsule bundle ID mismatch: expected ${extensionId}, got ${capsule.bundle.id}.`,
  );
  assert(
    typeof capsule.bundle.name === 'string' && capsule.bundle.name.length > 0,
    `Recovery capsule for ${extensionId} has no bundle name.`,
  );
  assert(
    Array.isArray(capsule.components) && capsule.components.length >= 2,
    `Recovery capsule for ${extensionId} must contain at least two components.`,
  );

  const seenIds = new Set();
  const components = capsule.components.map((component, index) => {
    assert(
      isObject(component),
      `Recovery component ${index} for ${extensionId} must be an object.`,
    );
    validateId(component.id, `Recovery component ${index} ID`);
    assert(!seenIds.has(component.id), `Recovery capsule repeats component: ${component.id}`);
    seenIds.add(component.id);
    const decoded = decodeExtensionDataUrl(component.dataUrl);
    assert(
      decoded.mediaType === 'text/javascript' || decoded.mediaType === 'application/javascript',
      `Recovery component ${component.id} must contain JavaScript.`,
    );
    const metadata = extensionHeaderMetadata(decoded.source);
    assert(
      metadata.id === component.id,
      `Recovery component header ID mismatch: expected ${component.id}, got ${metadata.id ?? '(missing)'}.`,
    );
    return {dataUrl: component.dataUrl, id: component.id};
  });

  return {
    bundle: {id: capsule.bundle.id, name: capsule.bundle.name},
    components,
    members: components.map((component) => component.id),
    originalExtensionIds: validateOriginalOrder(
      capsule.originalExtensionIds,
      'originalExtensionIds',
      true,
    ),
    originalExtensionUrlIds: validateOriginalOrder(
      capsule.originalExtensionUrlIds,
      'originalExtensionUrlIds',
    ),
  };
}

function collapseOrder(originalIds, bundles) {
  const bundlesByMember = new Map();
  for (const bundle of bundles) {
    for (const memberId of bundle.members) {
      assert(
        !bundlesByMember.has(memberId),
        `Active extension bundles overlap at member: ${memberId}`,
      );
      bundlesByMember.set(memberId, bundle.bundle.id);
    }
  }
  const emittedBundles = new Set();
  const output = [];
  for (const id of originalIds) {
    const bundleId = bundlesByMember.get(id);
    if (!bundleId) {
      output.push(id);
    } else if (!emittedBundles.has(bundleId)) {
      emittedBundles.add(bundleId);
      output.push(bundleId);
    }
  }
  return output;
}

function replaceBundledStorage(storage, target, counts) {
  if (!isObject(storage) || !Object.hasOwn(storage, target.bundle.id)) return storage;
  const bundleStorage = storage[target.bundle.id];
  assert(
    isObject(bundleStorage) &&
      bundleStorage.formatVersion === 1 &&
      isObject(bundleStorage.components),
    `Extension storage for ${target.bundle.id} is not a reversible format 1 bundle.`,
  );
  assert(
    Object.keys(bundleStorage).every((key) => key === 'formatVersion' || key === 'components'),
    `Extension storage for ${target.bundle.id} has unsupported bundle-level fields.`,
  );
  const memberIds = new Set(target.members);
  for (const componentId of Object.keys(bundleStorage.components)) {
    assert(
      memberIds.has(componentId),
      `Extension storage for ${target.bundle.id} contains unknown component: ${componentId}`,
    );
    assert(
      !Object.hasOwn(storage, componentId),
      `Cannot restore extension storage because member ID already exists: ${componentId}`,
    );
  }
  const replacement = {};
  for (const [id, value] of Object.entries(storage)) {
    if (id !== target.bundle.id) {
      replacement[id] = value;
      continue;
    }
    for (const memberId of target.members) {
      if (Object.hasOwn(bundleStorage.components, memberId)) {
        replacement[memberId] = bundleStorage.components[memberId];
      }
    }
  }
  counts.extensionStorage += 1;
  return replacement;
}

function restoreOpcodeValues(value, target, counts) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) restoreOpcodeValues(entry, target, counts);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'opcode' && typeof entry === 'string') {
      const bundlePrefix = `${target.bundle.id}_`;
      if (!entry.startsWith(bundlePrefix)) continue;
      const localOpcode = entry.slice(bundlePrefix.length);
      const memberId = target.members.find((id) => localOpcode.startsWith(`${id}__`));
      assert(memberId, `Bundle opcode cannot be assigned to a recovery component: ${entry}`);
      value[key] = `${memberId}_${localOpcode.slice(memberId.length + 2)}`;
      counts.opcodes += 1;
    } else {
      restoreOpcodeValues(entry, target, counts);
    }
  }
}

function collectRemainingBundleReferences(value, bundleId) {
  const references = [];
  const prefix = `${bundleId}_`;
  function visit(current, pointer) {
    if (typeof current === 'string') {
      if (current.startsWith(prefix)) references.push(pointer || '/');
      return;
    }
    if (!current || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${pointer}/${index}`));
      return;
    }
    for (const [key, entry] of Object.entries(current)) visit(entry, `${pointer}/${key}`);
  }
  visit(value, '');
  return references;
}

function restoreProject(project, target, activeBundles) {
  const restored = structuredClone(project);
  const counts = {extensionStorage: 0, extensionUrls: 0, opcodes: 0, projectExtensions: 0};
  const remainingBundles = activeBundles.filter((bundle) => bundle.bundle.id !== target.bundle.id);

  assert(isObject(restored.extensionURLs), 'SB3 project.json extensionURLs must be an object.');
  const currentUrlIds = Object.keys(restored.extensionURLs);
  const expectedUrlIds = collapseOrder(target.originalExtensionUrlIds, activeBundles);
  assert(
    arraysEqual(currentUrlIds, expectedUrlIds),
    `Cannot safely restore extension URL order. Expected ${JSON.stringify(expectedUrlIds)}, ` +
      `got ${JSON.stringify(currentUrlIds)}.`,
  );
  const restoredUrlIds = collapseOrder(target.originalExtensionUrlIds, remainingBundles);
  const componentUrls = new Map(
    target.components.map((component) => [component.id, component.dataUrl]),
  );
  restored.extensionURLs = Object.fromEntries(
    restoredUrlIds.map((id) => [
      id,
      componentUrls.has(id) ? componentUrls.get(id) : restored.extensionURLs[id],
    ]),
  );
  counts.extensionUrls = target.members.length + 1;

  if (target.originalExtensionIds === null) {
    assert(
      restored.extensions === undefined,
      'Cannot safely restore project.extensions because it was added after bundling.',
    );
  } else {
    assert(Array.isArray(restored.extensions), 'SB3 project.json extensions must be an array.');
    const expectedIds = collapseOrder(target.originalExtensionIds, activeBundles);
    assert(
      arraysEqual(restored.extensions, expectedIds),
      `Cannot safely restore project.extensions order. Expected ${JSON.stringify(expectedIds)}, ` +
        `got ${JSON.stringify(restored.extensions)}.`,
    );
    restored.extensions = collapseOrder(target.originalExtensionIds, remainingBundles);
    counts.projectExtensions = target.members.length + 1;
  }

  restored.extensionStorage = replaceBundledStorage(restored.extensionStorage, target, counts);
  for (const targetEntry of restored.targets ?? []) {
    if (targetEntry) {
      targetEntry.extensionStorage = replaceBundledStorage(
        targetEntry.extensionStorage,
        target,
        counts,
      );
    }
  }

  restoreOpcodeValues(restored.targets, target, counts);
  restoreOpcodeValues(restored.monitors, target, counts);
  const remainingReferences = collectRemainingBundleReferences(restored, target.bundle.id);
  assert(
    remainingReferences.length === 0,
    `Bundle ${target.bundle.id} has unsupported references at: ` +
      remainingReferences.slice(0, 8).join(', '),
  );
  return {counts, project: restored};
}

function parseProject(projectEntry) {
  try {
    const project = JSON.parse(strFromU8(projectEntry));
    assert(isObject(project), 'SB3 project.json must contain an object.');
    return project;
  } catch (error) {
    if (error.message === 'SB3 project.json must contain an object.') throw error;
    throw new Error(`SB3 project.json is invalid JSON: ${error.message}`, {cause: error});
  }
}

async function createArchiveUnbundlePlan({bundleId, inputPath, outputPath}) {
  validateId(bundleId, 'Extension bundle ID');
  assert(typeof inputPath === 'string', 'Input SB3 path is required.');
  assert(typeof outputPath === 'string', 'Unbundled SB3 output path is required.');
  const resolvedInputPath = path.resolve(inputPath);
  const resolvedOutputPath = path.resolve(outputPath);
  assert(
    path.extname(resolvedInputPath).toLowerCase() === '.sb3',
    `Input path must use the .sb3 extension: ${resolvedInputPath}`,
  );
  assert(
    path.extname(resolvedOutputPath).toLowerCase() === '.sb3',
    `Output path must use the .sb3 extension: ${resolvedOutputPath}`,
  );
  const stats = await lstat(resolvedInputPath);
  assert(
    stats.isFile() && !stats.isSymbolicLink(),
    `Input SB3 must be a regular file, not a symbolic link: ${resolvedInputPath}`,
  );
  const archiveEntries = unzipSync(new Uint8Array(await readFile(resolvedInputPath)));
  const entries = Object.entries(archiveEntries);
  assert(entries.length > 0, 'SB3 archive is empty.');
  for (const [entryName] of entries) {
    validateArchiveEntryName(entryName);
    assert(
      !/^(?:0|[1-9][0-9]*)$/u.test(entryName),
      `Integer-like ZIP entry names cannot preserve archive order: ${entryName}`,
    );
  }
  assert(archiveEntries['project.json'], 'SB3 archive does not contain project.json.');
  const project = parseProject(archiveEntries['project.json']);
  assert(isObject(project.extensionURLs), 'SB3 project.json extensionURLs must be an object.');

  const activeBundles = [];
  for (const [extensionId, dataUrl] of Object.entries(project.extensionURLs)) {
    const recovery = readRecoveryCapsule(extensionId, dataUrl, extensionId === bundleId);
    if (recovery) activeBundles.push(recovery);
  }
  const target = activeBundles.find((bundle) => bundle.bundle.id === bundleId);
  assert(target, `Reversible extension bundle was not found: ${bundleId}`);
  const restored = restoreProject(project, target, activeBundles);
  const outputEntries = Object.fromEntries(
    entries.map(([entryName, contents]) => [
      entryName,
      entryName === 'project.json' ? strToU8(`${JSON.stringify(restored.project)}\n`) : contents,
    ]),
  );
  const archive = zipSync(outputEntries, {level: 6, mtime: fixedZipTimestamp});
  return {
    archive,
    bundleId,
    counts: restored.counts,
    entryCount: entries.length,
    inputPath: resolvedInputPath,
    members: [...target.members],
    outputPath: resolvedOutputPath,
  };
}

function publicArchivePlan(plan) {
  return {
    bundleId: plan.bundleId,
    counts: plan.counts,
    entryCount: plan.entryCount,
    inputPath: plan.inputPath,
    members: plan.members,
    outputPath: plan.outputPath,
  };
}

export async function planBundledSb3Unbundle(options) {
  const plan = await createArchiveUnbundlePlan(options);
  return {applied: false, changed: true, ...publicArchivePlan(plan)};
}

export async function unbundleSb3({bundleId, inputPath, outputPath, yes = false}) {
  const plan = await createArchiveUnbundlePlan({bundleId, inputPath, outputPath});
  const publicPlan = publicArchivePlan(plan);
  if (!yes) {
    return {
      applied: false,
      changed: true,
      ...publicPlan,
      rollbackCleanupWarning: null,
    };
  }
  const written = await writeSb3Archive({archive: plan.archive, outputPath: plan.outputPath, yes});
  return {applied: true, ...publicPlan, ...written};
}
