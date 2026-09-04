// SPDX-License-Identifier: MPL-2.0

import {randomUUID} from 'node:crypto';
import {lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {pathExists} from './output-safety.js';
import {createDeterministicSb3} from './source.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function assertNoInterruptedRollback(outputPath) {
  const parentDirectory = path.dirname(outputPath);
  if (!(await pathExists(parentDirectory))) {
    return;
  }
  const rollbackPrefix = `.${path.basename(outputPath)}.rollback-`;
  const leftovers = (await readdir(parentDirectory))
    .filter((entryName) => entryName.startsWith(rollbackPrefix))
    .map((entryName) => path.join(parentDirectory, entryName));
  assert(
    leftovers.length === 0,
    `Found an interrupted SB3 build rollback file. Inspect or restore it before retrying: ` +
      leftovers.join(', '),
  );
}

async function inspectOutput(outputPath) {
  if (!(await pathExists(outputPath))) {
    return {contents: null, exists: false};
  }
  const stats = await lstat(outputPath);
  assert(
    stats.isFile() && !stats.isSymbolicLink(),
    `Refusing to replace a non-file or symbolic link: ${outputPath}`,
  );
  return {contents: await readFile(outputPath), exists: true};
}

async function assertOutputUnchanged(outputPath, expectedOutput) {
  const currentOutput = await inspectOutput(outputPath);
  assert(
    currentOutput.exists === expectedOutput.exists &&
      (!currentOutput.exists ||
        Buffer.compare(currentOutput.contents, expectedOutput.contents) === 0),
    `SB3 output changed while the build was running; refusing to replace it: ${outputPath}`,
  );
}

async function installArchiveTransactionally(archive, outputPath, expectedOutput) {
  const parentDirectory = path.dirname(outputPath);
  await assertNoInterruptedRollback(outputPath);
  const temporaryDirectory = await mkdtemp(
    path.join(parentDirectory, `.${path.basename(outputPath)}.build-`),
  );
  const temporaryPath = path.join(temporaryDirectory, path.basename(outputPath));
  const rollbackPath = path.join(
    parentDirectory,
    `.${path.basename(outputPath)}.rollback-${randomUUID()}`,
  );
  await writeFile(temporaryPath, archive);

  try {
    await assertOutputUnchanged(outputPath, expectedOutput);
    if (expectedOutput.exists) {
      await rename(outputPath, rollbackPath);
    }
    try {
      await rename(temporaryPath, outputPath);
    } catch (installError) {
      if (expectedOutput.exists) {
        try {
          await rename(rollbackPath, outputPath);
        } catch (restoreError) {
          throw new AggregateError(
            [installError, restoreError],
            `SB3 build failed and automatic restoration also failed. ` +
              `Original output remains at: ${rollbackPath}`,
          );
        }
      }
      throw installError;
    }
  } finally {
    await rm(temporaryDirectory, {recursive: true, force: true});
  }

  if (!expectedOutput.exists) {
    return null;
  }
  try {
    await rm(rollbackPath);
    return null;
  } catch (error) {
    return (
      `Built SB3 was installed, but its temporary rollback file could not be removed: ` +
      `${rollbackPath} (${error.message})`
    );
  }
}

export async function writeSb3Archive({
  archive,
  confirmReplace = undefined,
  outputPath,
  yes = false,
}) {
  assert(archive instanceof Uint8Array, 'SB3 archive contents are required.');
  assert(typeof outputPath === 'string', 'SB3 output path is required.');
  const resolvedOutputPath = path.resolve(outputPath);
  assert(
    path.extname(resolvedOutputPath).toLowerCase() === '.sb3',
    `SB3 output path must use the .sb3 extension: ${resolvedOutputPath}`,
  );
  await assertNoInterruptedRollback(resolvedOutputPath);
  const existingOutput = await inspectOutput(resolvedOutputPath);
  if (existingOutput.exists) {
    if (Buffer.compare(existingOutput.contents, Buffer.from(archive)) === 0) {
      return {
        changed: false,
        outputPath: resolvedOutputPath,
        rollbackCleanupWarning: null,
      };
    }
    if (!yes) {
      assert(
        typeof confirmReplace === 'function',
        `Existing SB3 output differs: ${resolvedOutputPath}. ` +
          'Non-interactive replacement requires --yes.',
      );
      assert(
        await confirmReplace(resolvedOutputPath),
        'SB3 build cancelled; the existing output was not changed.',
      );
    }
  }

  await mkdir(path.dirname(resolvedOutputPath), {recursive: true});
  const rollbackCleanupWarning = await installArchiveTransactionally(
    archive,
    resolvedOutputPath,
    existingOutput,
  );
  return {
    changed: true,
    outputPath: resolvedOutputPath,
    rollbackCleanupWarning,
  };
}

/**
 * @param {{
 *   allowedAssetRoots?: string[],
 *   cleanUpBlocks?: boolean,
 *   confirmReplace?: (outputPath: string) => Promise<boolean>,
 *   outputPath: string,
 *   projectAssetsPath?: string,
 *   sourceDirectory: string,
 *   yes?: boolean,
 * }} options
 */
export async function buildSb3({
  allowedAssetRoots = [],
  cleanUpBlocks = false,
  confirmReplace,
  outputPath,
  projectAssetsPath,
  sourceDirectory,
  yes = false,
}) {
  assert(typeof sourceDirectory === 'string', 'SB3 source directory is required.');
  const built = await createDeterministicSb3(sourceDirectory, {
    allowedAssetRoots,
    cleanUpBlocks,
    projectAssetsPath,
  });
  const written = await writeSb3Archive({
    archive: built.archive,
    confirmReplace,
    outputPath,
    yes,
  });
  return {...built, ...written};
}
