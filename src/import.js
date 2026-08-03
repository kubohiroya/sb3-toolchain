// SPDX-License-Identifier: MPL-2.0

import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {strFromU8, unzipSync} from 'fflate';

import {validateArchiveEntryName} from './archive.js';
import {validateManagedExtensionApiManifest} from './extension-api-manifest.js';
import {validateManagedExtensionContents} from './extension-dependencies.js';
import {
  assertNoInterruptedRollback,
  assertRecognizedOutputDirectory,
  compareDirectories,
  inspectGitOutputState,
  pathExists,
  replaceDirectoryTransactionally,
  validateOutputDirectoryPath,
} from './output-safety.js';
import {sourceFormatVersion} from './source.js';

export {validateOutputDirectoryPath} from './output-safety.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function summarizeGitChanges(gitState) {
  const entries = [
    ...gitState.statusEntries,
    ...gitState.untrackedContent.map((entry) => `not tracked: ${entry}`),
  ];
  const visibleEntries = entries.slice(0, 8).join(', ');
  const remainder = entries.length > 8 ? `, and ${entries.length - 8} more` : '';
  return `${visibleEntries}${remainder}`;
}

async function authorizeOutputReplacement({
  candidateDirectory,
  confirmReplace,
  discardLocalChanges,
  outputDirectory,
  yes,
}) {
  await assertNoInterruptedRollback(outputDirectory);
  if (!(await pathExists(outputDirectory))) {
    return {action: 'create', comparison: null, gitState: null};
  }

  await assertRecognizedOutputDirectory(outputDirectory, sourceFormatVersion);
  const comparison = await compareDirectories(outputDirectory, candidateDirectory);
  if (comparison.identical) {
    return {action: 'unchanged', comparison, gitState: null};
  }

  const gitState = await inspectGitOutputState(outputDirectory, comparison.existingFilePaths);
  assert(
    gitState.managed,
    `Existing output differs from the SB3 candidate but is not tracked by Git: ${outputDirectory}. ` +
      'Import to a new output directory instead of replacing unrecoverable content.',
  );
  assert(
    gitState.clean || discardLocalChanges,
    `Existing output differs from the SB3 candidate and has uncommitted Git changes: ` +
      `${summarizeGitChanges(gitState)}. Commit or stash them first, or explicitly use ` +
      '--discard-local-changes.',
  );

  const context = {
    comparison,
    discardLocalChanges,
    gitState,
    outputDirectory,
  };
  if (yes) {
    return {action: 'replace', ...context};
  }
  assert(
    typeof confirmReplace === 'function',
    `Output directory already exists: ${outputDirectory}. ` +
      'Refusing to replace differing content without interactive confirmation or --yes.',
  );
  assert(
    await confirmReplace(context),
    'SB3 import cancelled; the existing output was not changed.',
  );
  return {action: 'replace', ...context};
}

async function revalidateOutputReplacement({
  candidateDirectory,
  decision,
  discardLocalChanges,
  outputDirectory,
}) {
  const latestComparison = await compareDirectories(outputDirectory, candidateDirectory);
  assert(
    latestComparison.existingFingerprint === decision.comparison.existingFingerprint &&
      latestComparison.candidateFingerprint === decision.comparison.candidateFingerprint,
    'Output or candidate content changed during SB3 import; refusing to replace it.',
  );
  const latestGitState = await inspectGitOutputState(
    outputDirectory,
    latestComparison.existingFilePaths,
  );
  assert(
    latestGitState.managed,
    'Output stopped being Git-managed during SB3 import; refusing to replace it.',
  );
  assert(
    latestGitState.fingerprint === decision.gitState.fingerprint,
    'Git state changed during SB3 import; refusing to replace the output.',
  );
  assert(
    latestGitState.clean || discardLocalChanges,
    'Output gained uncommitted Git changes during SB3 import; refusing to replace it.',
  );
}

function extensionSourcePath(extensionId) {
  assert(
    /^[A-Za-z0-9._-]+$/u.test(extensionId),
    `Embedded extension ID cannot be used as a filename: ${JSON.stringify(extensionId)}`,
  );
  return `extensions/${extensionId}.js`;
}

async function readExistingExtensionSources(outputDirectory) {
  if (!(await pathExists(outputDirectory))) {
    return new Map();
  }

  const manifestPath = path.join(outputDirectory, 'embedded-extensions.json');
  if (!(await pathExists(manifestPath))) {
    return new Map();
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Existing embedded extension manifest is not valid JSON: ${manifestPath}`, {
      cause: error,
    });
  }
  assert(
    manifest &&
      typeof manifest === 'object' &&
      !Array.isArray(manifest) &&
      Array.isArray(manifest.extensions),
    `Existing embedded extension manifest is invalid: ${manifestPath}`,
  );

  const sources = new Map();
  for (const extension of manifest.extensions) {
    if (
      !extension ||
      typeof extension !== 'object' ||
      typeof extension.id !== 'string' ||
      typeof extension.path !== 'string' ||
      extension.source === undefined
    ) {
      continue;
    }
    sources.set(`${extension.id}\u0000${extension.path}`, extension.source);
  }
  return sources;
}

export function decodeExtensionDataUrl(dataUrl) {
  assert(
    typeof dataUrl === 'string' && dataUrl.startsWith('data:'),
    'Embedded extension URL must be a data URL.',
  );
  const commaIndex = dataUrl.indexOf(',');
  assert(commaIndex >= 0, 'Embedded extension data URL has no payload separator.');

  const metadata = dataUrl.slice('data:'.length, commaIndex).split(';');
  const mediaType = metadata.shift() || 'text/plain';
  const base64Index = metadata.indexOf('base64');
  const encoding = base64Index >= 0 ? 'base64' : 'percent';
  if (base64Index >= 0) {
    metadata.splice(base64Index, 1);
  }

  const payload = dataUrl.slice(commaIndex + 1);
  let source;
  if (encoding === 'base64') {
    assert(
      /^[A-Za-z0-9+/]*={0,2}$/u.test(payload),
      'Embedded extension data URL contains invalid base64.',
    );
    const unpaddedPayload = payload.replace(/=+$/u, '');
    assert(
      unpaddedPayload.length % 4 !== 1,
      'Embedded extension data URL contains invalid base64.',
    );
    source = Buffer.from(
      unpaddedPayload.padEnd(Math.ceil(unpaddedPayload.length / 4) * 4, '='),
      'base64',
    );
  } else {
    try {
      source = Buffer.from(decodeURIComponent(payload), 'utf8');
    } catch {
      throw new Error('Embedded extension data URL contains invalid percent encoding.');
    }
  }

  return {
    encoding,
    mediaType,
    parameters: metadata,
    source,
  };
}

export async function importSb3({
  inputPath,
  outputDirectory,
  protectedRoot = process.cwd(),
  discardLocalChanges = false,
  yes = false,
  confirmReplace,
}) {
  assert(typeof inputPath === 'string', 'Input SB3 path is required.');
  assert(typeof outputDirectory === 'string', 'SB3 source output directory is required.');
  const resolvedInputPath = path.resolve(inputPath);
  const resolvedOutputDirectory = validateOutputDirectoryPath(outputDirectory, protectedRoot);

  const archive = unzipSync(new Uint8Array(await readFile(resolvedInputPath)));
  const archiveEntries = Object.entries(archive);
  assert(archiveEntries.length > 0, 'SB3 archive is empty.');
  for (const [entryName] of archiveEntries) {
    validateArchiveEntryName(entryName);
  }

  const projectEntry = archive['project.json'];
  assert(projectEntry, 'SB3 archive does not contain project.json.');

  let project;
  let decision;
  let rollbackCleanupWarning = null;
  try {
    project = JSON.parse(strFromU8(projectEntry));
  } catch (error) {
    throw new Error(`SB3 project.json is invalid JSON: ${error.message}`, {cause: error});
  }
  assert(
    project && typeof project === 'object' && !Array.isArray(project),
    'SB3 project.json must contain a JSON object.',
  );

  const extensionUrls = project.extensionURLs ?? {};
  assert(
    extensionUrls && typeof extensionUrls === 'object' && !Array.isArray(extensionUrls),
    'SB3 project.json extensionURLs must be an object when present.',
  );

  const existingExtensionSources = await readExistingExtensionSources(resolvedOutputDirectory);
  const embeddedExtensions = [];
  const decodedExtensionSources = [];
  for (const [extensionId, extensionUrl] of Object.entries(extensionUrls)) {
    if (typeof extensionUrl !== 'string' || !extensionUrl.startsWith('data:')) {
      continue;
    }
    const sourcePath = extensionSourcePath(extensionId);
    const decoded = decodeExtensionDataUrl(extensionUrl);
    extensionUrls[extensionId] = `embedded-extension:${sourcePath}`;
    const extension = {
      id: extensionId,
      path: sourcePath,
      mediaType: decoded.mediaType,
      parameters: decoded.parameters,
      encoding: decoded.encoding,
    };
    const existingSource = existingExtensionSources.get(`${extensionId}\u0000${sourcePath}`);
    let existingApiManifestContents = null;
    if (existingSource !== undefined) {
      extension.source = structuredClone(existingSource);
      validateManagedExtensionContents(extension, decoded.source);
      if (extension.source.apiManifest) {
        existingApiManifestContents = await readFile(
          path.join(resolvedOutputDirectory, extension.source.apiManifest.path),
        );
        validateManagedExtensionApiManifest(extension, existingApiManifestContents);
      }
    }
    embeddedExtensions.push(extension);
    decodedExtensionSources.push({path: sourcePath, source: decoded.source});
    if (existingApiManifestContents) {
      decodedExtensionSources.push({
        path: extension.source.apiManifest.path,
        source: existingApiManifestContents,
      });
    }
  }

  const outputParent = path.dirname(resolvedOutputDirectory);
  await mkdir(outputParent, {recursive: true});
  const temporaryDirectory = await mkdtemp(
    path.join(outputParent, `.${path.basename(resolvedOutputDirectory)}.import-`),
  );

  try {
    const assetsDirectory = path.join(temporaryDirectory, 'assets');
    await mkdir(assetsDirectory, {recursive: true});
    await mkdir(path.join(temporaryDirectory, 'extensions'), {recursive: true});

    for (const [entryName, contents] of archiveEntries) {
      if (entryName === 'project.json' || entryName.endsWith('/')) {
        continue;
      }
      const assetPath = path.resolve(assetsDirectory, entryName);
      assert(
        assetPath.startsWith(`${assetsDirectory}${path.sep}`),
        `SB3 archive entry escapes the assets directory: ${JSON.stringify(entryName)}`,
      );
      await mkdir(path.dirname(assetPath), {recursive: true});
      await writeFile(assetPath, contents);
    }

    for (const extension of decodedExtensionSources) {
      await writeFile(path.join(temporaryDirectory, extension.path), extension.source);
    }

    const sourceManifest = {
      formatVersion: sourceFormatVersion,
      project: 'project.source.json',
      embeddedExtensions: 'embedded-extensions.json',
      assetsDirectory: 'assets',
      archiveEntries: archiveEntries.map(([entryName]) => entryName),
    };
    await Promise.all([
      writeFile(
        path.join(temporaryDirectory, 'project.source.json'),
        `${JSON.stringify(project, null, 2)}\n`,
      ),
      writeFile(
        path.join(temporaryDirectory, 'embedded-extensions.json'),
        `${JSON.stringify({formatVersion: sourceFormatVersion, extensions: embeddedExtensions}, null, 2)}\n`,
      ),
      writeFile(
        path.join(temporaryDirectory, 'sb3-source.json'),
        `${JSON.stringify(sourceManifest, null, 2)}\n`,
      ),
    ]);
    decision = await authorizeOutputReplacement({
      candidateDirectory: temporaryDirectory,
      confirmReplace,
      discardLocalChanges,
      outputDirectory: resolvedOutputDirectory,
      yes,
    });
    if (decision.action === 'unchanged') {
      await rm(temporaryDirectory, {recursive: true, force: true});
    } else {
      if (decision.action === 'replace') {
        await revalidateOutputReplacement({
          candidateDirectory: temporaryDirectory,
          decision,
          discardLocalChanges,
          outputDirectory: resolvedOutputDirectory,
        });
      }
      ({rollbackCleanupWarning} = await replaceDirectoryTransactionally(
        temporaryDirectory,
        resolvedOutputDirectory,
      ));
    }
  } catch (error) {
    await rm(temporaryDirectory, {recursive: true, force: true});
    throw error;
  }

  return {
    archiveEntryCount: archiveEntries.length,
    assetCount: archiveEntries.filter(
      ([entryName]) => entryName !== 'project.json' && !entryName.endsWith('/'),
    ).length,
    embeddedExtensionCount: embeddedExtensions.length,
    changed: decision.action !== 'unchanged',
    differenceCounts: decision.comparison
      ? {
          added: decision.comparison.differences.added.length,
          modified: decision.comparison.differences.modified.length,
          removed: decision.comparison.differences.removed.length,
        }
      : null,
    inputPath: resolvedInputPath,
    outputDirectory: resolvedOutputDirectory,
    rollbackCleanupWarning,
  };
}
