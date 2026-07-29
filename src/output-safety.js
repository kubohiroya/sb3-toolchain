// SPDX-License-Identifier: MPL-2.0

import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {access, lstat, realpath, readdir, readFile, readlink, rename, rm} from 'node:fs/promises';
import path from 'node:path';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function isSamePathOrAncestor(candidatePath, targetPath) {
  const relativePath = path.relative(candidatePath, targetPath);
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

export function validateOutputDirectoryPath(outputDirectory, protectedRoot) {
  const resolvedOutputDirectory = path.resolve(outputDirectory);
  const resolvedProtectedRoot = path.resolve(protectedRoot);
  assert(
    resolvedOutputDirectory !== path.parse(resolvedOutputDirectory).root,
    'Refusing to replace a filesystem root with imported SB3 sources.',
  );
  assert(
    !isSamePathOrAncestor(resolvedOutputDirectory, resolvedProtectedRoot),
    'Refusing to replace the repository root or one of its ancestors.',
  );
  assert(
    !resolvedOutputDirectory.split(path.sep).includes('.git'),
    'Refusing to write imported SB3 sources into a .git directory.',
  );
  return resolvedOutputDirectory;
}

export async function assertRecognizedOutputDirectory(outputDirectory, sourceFormatVersion) {
  const stats = await lstat(outputDirectory);
  assert(
    stats.isDirectory() && !stats.isSymbolicLink(),
    `Refusing to replace a non-directory or symbolic link: ${outputDirectory}`,
  );

  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(outputDirectory, 'sb3-source.json'), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      throw error;
    }
    throw new Error(
      `Refusing to replace an unrecognized directory without a valid sb3-source.json: ${outputDirectory}`,
      {cause: error},
    );
  }

  assert(
    manifest?.formatVersion === sourceFormatVersion &&
      manifest.project === 'project.source.json' &&
      manifest.embeddedExtensions === 'embedded-extensions.json' &&
      manifest.assetsDirectory === 'assets' &&
      Array.isArray(manifest.archiveEntries),
    `Refusing to replace an unrecognized directory without a valid sb3-source.json: ${outputDirectory}`,
  );
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function snapshotDirectory(rootDirectory) {
  const snapshot = new Map();

  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, {withFileTypes: true});
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? path.posix.join(relativeDirectory, entry.name)
        : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot.set(relativePath, {type: 'directory'});
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        const contents = await readFile(absolutePath);
        snapshot.set(relativePath, {
          type: 'file',
          size: contents.length,
          digest: digest(contents),
        });
      } else if (entry.isSymbolicLink()) {
        snapshot.set(relativePath, {
          type: 'symbolic-link',
          target: await readlink(absolutePath),
        });
      } else {
        snapshot.set(relativePath, {type: 'other'});
      }
    }
  }

  await visit(rootDirectory, '');
  return snapshot;
}

function snapshotFingerprint(snapshot) {
  return digest(JSON.stringify([...snapshot.entries()]));
}

function entriesMatch(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function compareDirectories(existingDirectory, candidateDirectory) {
  const [existingSnapshot, candidateSnapshot] = await Promise.all([
    snapshotDirectory(existingDirectory),
    snapshotDirectory(candidateDirectory),
  ]);
  const paths = [...new Set([...existingSnapshot.keys(), ...candidateSnapshot.keys()])].sort();
  const differences = {added: [], modified: [], removed: []};

  for (const relativePath of paths) {
    const existingEntry = existingSnapshot.get(relativePath);
    const candidateEntry = candidateSnapshot.get(relativePath);
    if (!existingEntry) {
      differences.added.push(relativePath);
    } else if (!candidateEntry) {
      differences.removed.push(relativePath);
    } else if (!entriesMatch(existingEntry, candidateEntry)) {
      differences.modified.push(relativePath);
    }
  }

  return {
    candidateFingerprint: snapshotFingerprint(candidateSnapshot),
    differences,
    existingFilePaths: [...existingSnapshot.entries()]
      .filter(([, entry]) => entry.type !== 'directory')
      .map(([relativePath]) => relativePath),
    existingFingerprint: snapshotFingerprint(existingSnapshot),
    identical: Object.values(differences).every((entries) => entries.length === 0),
  };
}

function executeGit(arguments_, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      arguments_,
      {cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024},
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

export async function inspectGitOutputState(outputDirectory, existingFilePaths) {
  let repositoryRoot;
  try {
    repositoryRoot = (await executeGit(['rev-parse', '--show-toplevel'], outputDirectory)).trim();
  } catch (error) {
    if (error?.code === 128) {
      return {
        clean: false,
        fingerprint: 'not-git-managed',
        managed: false,
        repositoryRoot: null,
        statusEntries: [],
        untrackedContent: [...existingFilePaths],
      };
    }
    throw error;
  }

  const [canonicalOutputDirectory, canonicalRepositoryRoot] = await Promise.all([
    realpath(outputDirectory),
    realpath(repositoryRoot),
  ]);
  repositoryRoot = canonicalRepositoryRoot;
  const relativeOutputDirectory = path.relative(repositoryRoot, canonicalOutputDirectory);
  assert(
    relativeOutputDirectory !== '..' &&
      !relativeOutputDirectory.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeOutputDirectory),
    `Output directory is outside its detected Git worktree: ${outputDirectory}`,
  );
  const pathspec = relativeOutputDirectory || '.';
  const [statusOutput, trackedOutput] = await Promise.all([
    executeGit(
      ['status', '--porcelain=v1', '--untracked-files=all', '--', pathspec],
      repositoryRoot,
    ),
    executeGit(['ls-files', '-z', '--', pathspec], repositoryRoot),
  ]);
  const statusEntries = statusOutput.split('\n').filter(Boolean);
  const trackedPaths = new Set(
    trackedOutput
      .split('\0')
      .filter(Boolean)
      .map((trackedPath) =>
        toPosixPath(
          path.relative(canonicalOutputDirectory, path.join(repositoryRoot, trackedPath)),
        ),
      ),
  );
  const untrackedContent = existingFilePaths.filter((filePath) => !trackedPaths.has(filePath));
  const managed = trackedPaths.size > 0;
  const clean = managed && statusEntries.length === 0 && untrackedContent.length === 0;
  const fingerprint = digest(
    JSON.stringify({
      clean,
      managed,
      repositoryRoot,
      statusEntries,
      trackedPaths: [...trackedPaths].sort(),
      untrackedContent: [...untrackedContent].sort(),
    }),
  );

  return {
    clean,
    fingerprint,
    managed,
    repositoryRoot,
    statusEntries,
    untrackedContent,
  };
}

export async function assertNoInterruptedRollback(outputDirectory) {
  const parentDirectory = path.dirname(outputDirectory);
  const outputName = path.basename(outputDirectory);
  const rollbackPrefixes = [`.${outputName}.rollback-`, `.${outputName}.backup-`];
  const leftovers = (await readdir(parentDirectory))
    .filter((entryName) => rollbackPrefixes.some((prefix) => entryName.startsWith(prefix)))
    .map((entryName) => path.join(parentDirectory, entryName));
  assert(
    leftovers.length === 0,
    `Found an interrupted SB3 import rollback directory. ` +
      `Inspect or restore it before retrying: ${leftovers.join(', ')}`,
  );
}

export async function replaceDirectoryTransactionally(temporaryDirectory, outputDirectory) {
  const parentDirectory = path.dirname(outputDirectory);
  await assertNoInterruptedRollback(outputDirectory);
  const rollbackDirectory = path.join(
    parentDirectory,
    `.${path.basename(outputDirectory)}.rollback-${randomUUID()}`,
  );
  assert(
    !(await pathExists(rollbackDirectory)),
    `Refusing to overwrite an existing rollback directory: ${rollbackDirectory}`,
  );
  const outputExists = await pathExists(outputDirectory);

  if (outputExists) {
    await rename(outputDirectory, rollbackDirectory);
  }

  try {
    await rename(temporaryDirectory, outputDirectory);
  } catch (installError) {
    if (outputExists) {
      try {
        await rename(rollbackDirectory, outputDirectory);
      } catch (restoreError) {
        throw new AggregateError(
          [installError, restoreError],
          `SB3 import failed and automatic restoration also failed. ` +
            `Original output remains at: ${rollbackDirectory}`,
        );
      }
    }
    throw installError;
  }

  if (!outputExists) {
    return {rollbackCleanupWarning: null};
  }

  try {
    await rm(rollbackDirectory, {recursive: true});
    return {rollbackCleanupWarning: null};
  } catch (error) {
    return {
      rollbackCleanupWarning:
        `Imported output was installed, but its temporary rollback ` +
        `directory could not be removed: ${rollbackDirectory} (${error.message})`,
    };
  }
}
