// SPDX-License-Identifier: MPL-2.0

import path from 'node:path';
import process from 'node:process';
import {createInterface} from 'node:readline/promises';

import {buildSb3} from './build.js';
import {packageVersion} from './constants.js';
import {bundleExtensions, unbundleExtensions} from './extension-bundle-configuration.js';
import {unbundleSb3} from './extension-bundle-archive.js';
import {migrateExtensionId} from './extension-id-migration.js';
import {extensionStatus, syncExtensions, updateExtensions} from './extension-sync.js';
import {importSb3} from './import.js';
import {createDeterministicSb3, validateSb3Source} from './source.js';

/**
 * @param {unknown} condition
 * @param {string} message
 * @returns {asserts condition}
 */
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function usage() {
  return `Usage:
  sb3-toolchain import INPUT.sb3 --output SOURCE_DIR [--yes] [--discard-local-changes]
  sb3-toolchain check SOURCE_DIR [--project-assets MANIFEST.json] [--allow-asset-root DIR ...]
  sb3-toolchain build SOURCE_DIR --output OUTPUT.sb3 [--project-assets MANIFEST.json] [--allow-asset-root DIR ...] [--clean-up-blocks] [--yes]
  sb3-toolchain extensions status SOURCE_DIR
  sb3-toolchain extensions sync SOURCE_DIR [--yes]
  sb3-toolchain extensions update SOURCE_DIR [EXTENSION_ID] [--migrate-id NEW_ID] [--artifact PATH] [--api-manifest-artifact PATH] [--allow-breaking-api --yes]
  sb3-toolchain extensions migrate-id SOURCE_DIR --from OLD_ID --to NEW_ID [--yes]
  sb3-toolchain extensions bundle SOURCE_DIR --id BUNDLE_ID --name NAME [EXTENSION_ID ...] [--yes]
  sb3-toolchain extensions unbundle SOURCE_DIR BUNDLE_ID [--yes]
  sb3-toolchain extensions unbundle INPUT.sb3 BUNDLE_ID --output OUTPUT.sb3 [--yes]

Commands:
  import      Expand an SB3 into Git-friendly source files.
  check       Validate an expanded SB3 source directory.
  build       Build a deterministic SB3 from expanded sources.
  extensions  Inspect, restore, or update managed embedded extensions.

Build layout cleanup:
  --clean-up-blocks applies a deterministic TurboWarp-style "Clean up Blocks"
  layout to every target in the generated SB3. It never deletes blocks,
  variables, lists, or comments. The expanded source is unchanged, but the
  generated SB3 might not be able to undo the coordinate changes.

Project asset additions:
  --project-assets validates a JSON or YAML manifest and adds its sprites,
  backdrops, costumes, and sounds only to the generated SB3. Input files are confined to the
  manifest directory unless --allow-asset-root explicitly permits another root.

Replacement safety:
  Differing outputs require interactive confirmation or --yes.
  Import refuses to discard uncommitted Git changes unless
  --discard-local-changes is also specified. --force is not supported.`;
}

function takeValue(arguments_, index, option) {
  const value = arguments_[index + 1];
  assert(value && !value.startsWith('-'), `${option} requires a value.`);
  return value;
}

function parseImportArguments(arguments_) {
  let inputPath;
  let outputDirectory;
  let discardLocalChanges = false;
  let yes = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--output') {
      outputDirectory = path.resolve(takeValue(arguments_, index, '--output'));
      index += 1;
    } else if (argument === '--yes') {
      yes = true;
    } else if (argument === '--discard-local-changes') {
      discardLocalChanges = true;
    } else {
      assert(
        argument !== '--force',
        '--force is intentionally unsupported. Use --yes and, only when necessary, ' +
          '--discard-local-changes.',
      );
      assert(!argument.startsWith('-'), `Unknown option: ${argument}`);
      assert(!inputPath, 'Only one input SB3 may be specified.');
      inputPath = path.resolve(argument);
    }
  }

  assert(inputPath, 'The import command requires INPUT.sb3.');
  assert(outputDirectory, 'The import command requires --output SOURCE_DIR.');
  return {command: 'import', discardLocalChanges, inputPath, outputDirectory, yes};
}

/**
 * @param {string[]} arguments_
 * @returns {{allowedAssetRoots?: string[], command: 'check', projectAssetsPath?: string, sourceDirectory: string}}
 */
function parseCheckArguments(arguments_) {
  const allowedAssetRoots = [];
  let projectAssetsPath;
  let sourceDirectory;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--project-assets') {
      projectAssetsPath = path.resolve(takeValue(arguments_, index, '--project-assets'));
      index += 1;
    } else if (argument === '--allow-asset-root') {
      allowedAssetRoots.push(path.resolve(takeValue(arguments_, index, '--allow-asset-root')));
      index += 1;
    } else {
      assert(!argument.startsWith('-'), `Unknown option: ${argument}`);
      assert(!sourceDirectory, 'Only one SB3 source directory may be specified.');
      sourceDirectory = path.resolve(argument);
    }
  }
  assert(sourceDirectory, 'The check command requires SOURCE_DIR.');
  assert(
    allowedAssetRoots.length === 0 || projectAssetsPath,
    '--allow-asset-root requires --project-assets.',
  );
  return {
    ...(allowedAssetRoots.length > 0 ? {allowedAssetRoots} : {}),
    command: 'check',
    ...(projectAssetsPath ? {projectAssetsPath} : {}),
    sourceDirectory,
  };
}

/**
 * @param {string[]} arguments_
 * @returns {{allowedAssetRoots?: string[], cleanUpBlocks?: boolean, command: 'build', outputPath: string, projectAssetsPath?: string, sourceDirectory: string, yes: boolean}}
 */
function parseBuildArguments(arguments_) {
  const allowedAssetRoots = [];
  let cleanUpBlocks = false;
  let sourceDirectory;
  let outputPath;
  let projectAssetsPath;
  let yes = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--clean-up-blocks') {
      cleanUpBlocks = true;
    } else if (argument === '--project-assets') {
      projectAssetsPath = path.resolve(takeValue(arguments_, index, '--project-assets'));
      index += 1;
    } else if (argument === '--allow-asset-root') {
      allowedAssetRoots.push(path.resolve(takeValue(arguments_, index, '--allow-asset-root')));
      index += 1;
    } else if (argument === '--output') {
      outputPath = path.resolve(takeValue(arguments_, index, '--output'));
      index += 1;
    } else if (argument === '--yes') {
      yes = true;
    } else {
      assert(!argument.startsWith('-'), `Unknown option: ${argument}`);
      assert(!sourceDirectory, 'Only one SB3 source directory may be specified.');
      sourceDirectory = path.resolve(argument);
    }
  }

  assert(sourceDirectory, 'The build command requires SOURCE_DIR.');
  assert(outputPath, 'The build command requires --output OUTPUT.sb3.');
  assert(
    allowedAssetRoots.length === 0 || projectAssetsPath,
    '--allow-asset-root requires --project-assets.',
  );
  return {
    ...(allowedAssetRoots.length > 0 ? {allowedAssetRoots} : {}),
    ...(cleanUpBlocks ? {cleanUpBlocks} : {}),
    command: 'build',
    outputPath,
    ...(projectAssetsPath ? {projectAssetsPath} : {}),
    sourceDirectory,
    yes,
  };
}

function parseExtensionMutationArguments(action, arguments_) {
  let allowBreakingApi = false;
  let apiManifestArtifact;
  let sourceDirectory;
  let extensionId;
  let migrateToId;
  let sourceArtifact;
  let yes = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--yes') {
      yes = true;
    } else if (argument === '--allow-breaking-api') {
      assert(action === 'update', '--allow-breaking-api is only valid for extensions update.');
      allowBreakingApi = true;
    } else if (argument === '--migrate-id') {
      assert(action === 'update', '--migrate-id is only valid for extensions update.');
      migrateToId = takeValue(arguments_, index, '--migrate-id');
      index += 1;
    } else if (argument === '--artifact') {
      assert(action === 'update', '--artifact is only valid for extensions update.');
      sourceArtifact = takeValue(arguments_, index, '--artifact');
      index += 1;
    } else if (argument === '--api-manifest-artifact') {
      assert(action === 'update', '--api-manifest-artifact is only valid for extensions update.');
      apiManifestArtifact = takeValue(arguments_, index, '--api-manifest-artifact');
      index += 1;
    } else {
      assert(!argument.startsWith('-'), `Unknown option: ${argument}`);
      if (!sourceDirectory) {
        sourceDirectory = path.resolve(argument);
      } else {
        assert(action === 'update', `The extensions ${action} command accepts only SOURCE_DIR.`);
        assert(!extensionId, 'Only one EXTENSION_ID may be specified.');
        assert(
          /^[A-Za-z0-9._-]+$/u.test(argument),
          `Invalid embedded extension ID: ${JSON.stringify(argument)}`,
        );
        extensionId = argument;
      }
    }
  }

  assert(sourceDirectory, `The extensions ${action} command requires SOURCE_DIR.`);
  assert(
    migrateToId === undefined || extensionId !== undefined,
    '--migrate-id requires an explicit existing EXTENSION_ID.',
  );
  assert(
    sourceArtifact === undefined || migrateToId !== undefined,
    '--artifact requires --migrate-id.',
  );
  assert(
    apiManifestArtifact === undefined || migrateToId !== undefined,
    '--api-manifest-artifact requires --migrate-id.',
  );
  assert(!allowBreakingApi || yes, '--allow-breaking-api requires --yes.');
  return {
    action,
    ...(allowBreakingApi ? {allowBreakingApi} : {}),
    ...(apiManifestArtifact ? {apiManifestArtifact} : {}),
    command: 'extensions',
    extensionId,
    migrateToId,
    sourceArtifact,
    sourceDirectory,
    yes,
  };
}

function parseExtensionIdMigrationArguments(arguments_) {
  let fromId;
  let sourceDirectory;
  let toId;
  let yes = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--from') {
      fromId = takeValue(arguments_, index, '--from');
      index += 1;
    } else if (argument === '--to') {
      toId = takeValue(arguments_, index, '--to');
      index += 1;
    } else if (argument === '--yes') {
      yes = true;
    } else {
      assert(!argument.startsWith('-'), `Unknown option: ${argument}`);
      assert(!sourceDirectory, 'Only one SB3 source directory may be specified.');
      sourceDirectory = path.resolve(argument);
    }
  }
  assert(sourceDirectory, 'The extensions migrate-id command requires SOURCE_DIR.');
  assert(fromId, 'The extensions migrate-id command requires --from OLD_ID.');
  assert(toId, 'The extensions migrate-id command requires --to NEW_ID.');
  return {
    action: 'migrate-id',
    command: 'extensions',
    fromId,
    sourceDirectory,
    toId,
    yes,
  };
}

function parseExtensionBundleArguments(arguments_) {
  let bundleId;
  let bundleName;
  let sourceDirectory;
  const extensionIds = [];
  let yes = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--id') {
      bundleId = takeValue(arguments_, index, '--id');
      index += 1;
    } else if (argument === '--name') {
      bundleName = takeValue(arguments_, index, '--name');
      index += 1;
    } else if (argument === '--yes') {
      yes = true;
    } else {
      assert(!argument.startsWith('-'), `Unknown option: ${argument}`);
      if (!sourceDirectory) {
        sourceDirectory = path.resolve(argument);
      } else {
        assert(
          /^[a-z0-9]+$/u.test(argument),
          `Bundle member ID must use TurboWarp's [a-z0-9]+ format: ${JSON.stringify(argument)}`,
        );
        extensionIds.push(argument);
      }
    }
  }
  assert(sourceDirectory, 'The extensions bundle command requires SOURCE_DIR.');
  assert(bundleId, 'The extensions bundle command requires --id BUNDLE_ID.');
  assert(bundleName, 'The extensions bundle command requires --name NAME.');
  return {
    action: 'bundle',
    bundleId,
    bundleName,
    command: 'extensions',
    extensionIds,
    sourceDirectory,
    yes,
  };
}

function parseExtensionUnbundleArguments(arguments_) {
  let bundleId;
  let input;
  let outputPath;
  let yes = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--yes') {
      yes = true;
    } else if (argument === '--output') {
      outputPath = path.resolve(takeValue(arguments_, index, '--output'));
      index += 1;
    } else {
      assert(!argument.startsWith('-'), `Unknown option: ${argument}`);
      if (!input) {
        input = path.resolve(argument);
      } else {
        assert(!bundleId, 'Only one BUNDLE_ID may be specified.');
        bundleId = argument;
      }
    }
  }
  assert(input, 'The extensions unbundle command requires SOURCE_DIR or INPUT.sb3.');
  assert(bundleId, 'The extensions unbundle command requires BUNDLE_ID.');
  if (path.extname(input).toLowerCase() === '.sb3') {
    assert(outputPath, 'SB3 unbundle requires --output OUTPUT.sb3.');
    return {
      action: 'unbundle',
      bundleId,
      command: 'extensions',
      inputPath: input,
      outputPath,
      yes,
    };
  }
  assert(!outputPath, '--output is only valid when unbundling an SB3 file.');
  return {
    action: 'unbundle',
    bundleId,
    command: 'extensions',
    sourceDirectory: input,
    yes,
  };
}

function parseExtensionsArguments(arguments_) {
  const [action, ...actionArguments] = arguments_;
  assert(
    action === 'bundle' ||
      action === 'migrate-id' ||
      action === 'status' ||
      action === 'sync' ||
      action === 'unbundle' ||
      action === 'update',
    'The extensions command requires status, sync, update, migrate-id, bundle, or unbundle.',
  );
  if (action === 'status') {
    assert(
      actionArguments.length === 1 && !actionArguments[0].startsWith('-'),
      'The extensions status command requires exactly one SOURCE_DIR.',
    );
    return {
      action,
      command: 'extensions',
      sourceDirectory: path.resolve(actionArguments[0]),
    };
  }
  if (action === 'migrate-id') {
    return parseExtensionIdMigrationArguments(actionArguments);
  }
  if (action === 'bundle') {
    return parseExtensionBundleArguments(actionArguments);
  }
  if (action === 'unbundle') {
    return parseExtensionUnbundleArguments(actionArguments);
  }
  return parseExtensionMutationArguments(action, actionArguments);
}

export function parseCliArguments(arguments_) {
  const normalized = arguments_.filter((argument) => argument !== '--');
  if (normalized.length === 0 || normalized[0] === '--help' || normalized[0] === '-h') {
    return {command: 'help'};
  }
  if (normalized[0] === '--version' || normalized[0] === '-v') {
    return {command: 'version'};
  }

  const [command, ...commandArguments] = normalized;
  if (commandArguments.includes('--help') || commandArguments.includes('-h')) {
    return {command: 'help'};
  }
  if (command === 'import') return parseImportArguments(commandArguments);
  if (command === 'check') return parseCheckArguments(commandArguments);
  if (command === 'build') return parseBuildArguments(commandArguments);
  if (command === 'extensions') return parseExtensionsArguments(commandArguments);
  throw new Error(`Unknown command: ${command}`);
}

function formatDifferenceLines(differences) {
  const labels = {added: '+', modified: '~', removed: '-'};
  const lines = Object.entries(differences).flatMap(([kind, paths]) =>
    paths.map((relativePath) => `${labels[kind]} ${relativePath}`),
  );
  const visibleLines = lines.slice(0, 12);
  if (lines.length > visibleLines.length) {
    visibleLines.push(`... and ${lines.length - visibleLines.length} more`);
  }
  return visibleLines.join('\n');
}

async function confirmImportReplacement(context) {
  const {comparison, discardLocalChanges, gitState, outputDirectory} = context;
  assert(
    process.stdin.isTTY && process.stdout.isTTY,
    `Output directory already exists: ${outputDirectory}. ` +
      'Non-interactive replacement requires --yes.',
  );
  const readline = createInterface({input: process.stdin, output: process.stdout});
  try {
    const gitMessage = gitState.clean
      ? 'Git state: clean'
      : 'Git state: uncommitted changes will be discarded';
    const answer = await readline.question(
      `Existing SB3 source differs from the import candidate:\n` +
        `  ${outputDirectory}\n` +
        `${formatDifferenceLines(comparison.differences)}\n` +
        `${gitMessage}\n` +
        `${discardLocalChanges ? 'WARNING: --discard-local-changes is active.\n' : ''}` +
        'Replace the existing source directory? [y/N] ',
    );
    return /^(?:y|yes)$/iu.test(answer.trim());
  } finally {
    readline.close();
  }
}

async function confirmBuildReplacement(outputPath) {
  assert(
    process.stdin.isTTY && process.stdout.isTTY,
    `Existing SB3 output differs: ${outputPath}. Non-interactive replacement requires --yes.`,
  );
  const readline = createInterface({input: process.stdin, output: process.stdout});
  try {
    const answer = await readline.question(
      `Existing generated SB3 will be replaced:\n  ${outputPath}\nContinue? [y/N] `,
    );
    return /^(?:y|yes)$/iu.test(answer.trim());
  } finally {
    readline.close();
  }
}

async function confirmExtensionReplacement({comparison, sourceDirectory}) {
  assert(
    process.stdin.isTTY && process.stdout.isTTY,
    `Managed extension files differ in ${sourceDirectory}. ` +
      'Non-interactive replacement requires --yes.',
  );
  const readline = createInterface({input: process.stdin, output: process.stdout});
  try {
    const answer = await readline.question(
      `Managed extension changes will be installed:\n` +
        `  ${sourceDirectory}\n` +
        `${formatDifferenceLines(comparison.differences)}\n` +
        'Replace these files? [y/N] ',
    );
    return /^(?:y|yes)$/iu.test(answer.trim());
  } finally {
    readline.close();
  }
}

function logMigrationResult(result, log) {
  const counts = Object.entries(result.counts)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind}=${count}`)
    .join(', ');
  const action = result.applied ? 'Migrated' : 'Dry run';
  log(
    `${action}: ${result.fromId} -> ${result.toId}; ` +
      `${result.totalChanges} classified changes (${counts || 'none'}); ` +
      `artifact=${result.artifactReady ? 'ready' : 'requires-new-ID'}.`,
  );
  for (const reference of result.unclassifiedReferences) {
    log(
      `Unclassified ${reference.kind}: ${reference.file}${reference.path} = ` +
        JSON.stringify(reference.value),
    );
  }
}

export async function runCli(
  arguments_,
  {fetch: fetchImplementation = globalThis.fetch, log = console.log} = {},
) {
  const options = parseCliArguments(arguments_);
  if (options.command === 'help') {
    log(usage());
    return;
  }
  if (options.command === 'version') {
    log(packageVersion);
    return;
  }
  if (options.command === 'check') {
    assert(
      'sourceDirectory' in options && !('action' in options),
      'Internal CLI check command routing error.',
    );
    if (options.projectAssetsPath) {
      const result = await createDeterministicSb3(options.sourceDirectory, {
        allowedAssetRoots: options.allowedAssetRoots,
        projectAssetsPath: options.projectAssetsPath,
      });
      log(
        `Valid SB3 source with project assets: ${result.source.resolvedSourceDirectory} ` +
          `(${result.entryCount} entries, ${result.assetCount} assets, ` +
          `${result.assetReferenceCount} references, ${result.embeddedExtensionCount} embedded extensions).`,
      );
      return;
    }
    const result = await validateSb3Source(options.sourceDirectory);
    log(
      `Valid SB3 source: ${result.resolvedSourceDirectory} ` +
        `(${result.sourceManifest.archiveEntries.length} entries, ` +
        `${result.assetContents.size} assets, ${result.assetReferenceCount} references, ` +
        `${result.extensions.length} embedded extensions).`,
    );
    return;
  }
  if (
    options.command === 'build' &&
    'outputPath' in options &&
    'sourceDirectory' in options &&
    !('action' in options)
  ) {
    const result = await buildSb3({
      allowedAssetRoots: options.allowedAssetRoots,
      cleanUpBlocks: options.cleanUpBlocks,
      confirmReplace: confirmBuildReplacement,
      outputPath: options.outputPath,
      projectAssetsPath: options.projectAssetsPath,
      sourceDirectory: options.sourceDirectory,
      yes: options.yes,
    });
    const action = result.changed ? 'Built' : 'Already up to date';
    const cleanUpMessage = result.blockCleanUp
      ? `, ${result.blockCleanUp.movedScriptCount}/${result.blockCleanUp.scriptCount} scripts laid out`
      : '';
    log(
      `${action}: ${result.outputPath} (${result.entryCount} entries, ` +
        `${result.assetCount} assets, ${result.embeddedExtensionCount} embedded extensions` +
        `${cleanUpMessage}).`,
    );
    if (result.rollbackCleanupWarning) log(result.rollbackCleanupWarning);
    return;
  }
  if (options.command === 'extensions') {
    if (options.action === 'bundle') {
      const result = await bundleExtensions({
        bundleId: options.bundleId,
        bundleName: options.bundleName,
        extensionIds: options.extensionIds,
        sourceDirectory: options.sourceDirectory,
        yes: options.yes,
      });
      log(
        `${result.applied ? 'Configured' : 'Dry run'} extension bundle: ${result.bundleId} ` +
          `(${result.members.join(', ')}).`,
      );
      if (result.rollbackCleanupWarning) log(result.rollbackCleanupWarning);
      return;
    }
    if (options.action === 'unbundle') {
      if ('inputPath' in options) {
        const result = await unbundleSb3({
          bundleId: options.bundleId,
          inputPath: options.inputPath,
          outputPath: options.outputPath,
          yes: options.yes,
        });
        log(
          `${result.applied ? 'Wrote' : 'Dry run'} unbundled SB3: ${result.bundleId} ` +
            `(${result.members.join(', ')}) -> ${result.outputPath}.`,
        );
        if (result.rollbackCleanupWarning) log(result.rollbackCleanupWarning);
        return;
      }
      const result = await unbundleExtensions({
        bundleId: options.bundleId,
        sourceDirectory: options.sourceDirectory,
        yes: options.yes,
      });
      log(
        `${result.applied ? 'Removed' : 'Dry run'} extension bundle: ${result.bundleId} ` +
          `(${result.members.join(', ')}).`,
      );
      if (result.rollbackCleanupWarning) log(result.rollbackCleanupWarning);
      return;
    }
    if (options.action === 'migrate-id') {
      const result = await migrateExtensionId({
        fromId: options.fromId,
        sourceDirectory: options.sourceDirectory,
        toId: options.toId,
        yes: options.yes,
      });
      logMigrationResult(result, log);
      if (result.rollbackCleanupWarning) log(result.rollbackCleanupWarning);
      return;
    }
    if (options.action === 'status') {
      const statuses = await extensionStatus(options.sourceDirectory, {
        fetch: fetchImplementation,
      });
      if (statuses.length === 0) {
        log(`No managed embedded extensions: ${options.sourceDirectory}`);
        return;
      }
      for (const status of statuses) {
        if (status.package) {
          log(
            `${status.id}: ${status.state}; local=${status.local}; ` +
              `${status.package}@${status.version} (installed ${status.installedVersion})`,
          );
          continue;
        }
        log(
          `${status.id}: ${status.state}; local=${status.local}; ` +
            `${status.ref} -> ${status.remoteCommit} ` +
            `(installed ${status.resolvedCommit})`,
        );
      }
      return;
    }

    const operationOptions = {
      confirmReplace: confirmExtensionReplacement,
      fetch: fetchImplementation,
      sourceDirectory: options.sourceDirectory,
      yes: options.yes,
    };
    const result =
      options.action === 'sync'
        ? await syncExtensions(operationOptions)
        : await updateExtensions({
            ...operationOptions,
            allowBreakingApi: options.allowBreakingApi,
            apiManifestArtifact: options.apiManifestArtifact,
            extensionId: options.extensionId,
            migrateToId: options.migrateToId,
            sourceArtifact: options.sourceArtifact,
          });
    const action = result.changed ? 'Updated' : 'Already up to date';
    log(
      `${action}: ${result.sourceDirectory} ` +
        `(${result.extensions.map((extension) => extension.id).join(', ')}).`,
    );
    if (result.migration) {
      logMigrationResult(
        {
          applied: result.changed,
          artifactReady: true,
          ...result.migration,
        },
        log,
      );
    }
    for (const compatibility of result.apiCompatibility) {
      for (const change of compatibility.changes) {
        log(
          `API ${compatibility.id}: ${change.breaking ? 'breaking' : 'compatible'} ` +
            `${change.kind} ${change.path}`,
        );
      }
    }
    if (result.rollbackCleanupWarning) log(result.rollbackCleanupWarning);
    return;
  }

  assert(
    options.command === 'import' && 'inputPath' in options,
    'Internal CLI command routing error.',
  );
  const result = await importSb3({
    confirmReplace: confirmImportReplacement,
    discardLocalChanges: options.discardLocalChanges,
    inputPath: options.inputPath,
    outputDirectory: options.outputDirectory,
    yes: options.yes,
  });
  if (result.changed) {
    const differenceMessage = result.differenceCounts
      ? ` Changes: +${result.differenceCounts.added} ` +
        `~${result.differenceCounts.modified} -${result.differenceCounts.removed}.`
      : '';
    log(
      `Imported ${result.archiveEntryCount} SB3 entries into ${result.outputDirectory} ` +
        `(${result.assetCount} assets, ${result.embeddedExtensionCount} embedded extensions).` +
        differenceMessage,
    );
  } else {
    log(`Already up to date; no files changed: ${result.outputDirectory}`);
  }
  if (result.rollbackCleanupWarning) log(result.rollbackCleanupWarning);
}
