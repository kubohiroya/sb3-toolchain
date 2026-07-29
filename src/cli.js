// SPDX-License-Identifier: MPL-2.0

import path from 'node:path';
import process from 'node:process';
import {createInterface} from 'node:readline/promises';

import {buildSb3} from './build.js';
import {packageVersion} from './constants.js';
import {importSb3} from './import.js';
import {validateSb3Source} from './source.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function usage() {
  return `Usage:
  sb3-toolchain import INPUT.sb3 --output SOURCE_DIR [--yes] [--discard-local-changes]
  sb3-toolchain check SOURCE_DIR
  sb3-toolchain build SOURCE_DIR --output OUTPUT.sb3 [--yes]

Commands:
  import  Expand an SB3 into Git-friendly source files.
  check   Validate an expanded SB3 source directory.
  build   Build a deterministic SB3 from expanded sources.

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

function parseCheckArguments(arguments_) {
  assert(
    arguments_.length === 1 && !arguments_[0].startsWith('-'),
    'The check command requires exactly one SOURCE_DIR.',
  );
  return {command: 'check', sourceDirectory: path.resolve(arguments_[0])};
}

function parseBuildArguments(arguments_) {
  let sourceDirectory;
  let outputPath;
  let yes = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--output') {
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
  return {command: 'build', outputPath, sourceDirectory, yes};
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

export async function runCli(arguments_, {log = console.log} = {}) {
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
    const result = await validateSb3Source(options.sourceDirectory);
    log(
      `Valid SB3 source: ${result.resolvedSourceDirectory} ` +
        `(${result.sourceManifest.archiveEntries.length} entries, ` +
        `${result.assetContents.size} assets, ${result.assetReferenceCount} references, ` +
        `${result.extensions.length} embedded extensions).`,
    );
    return;
  }
  if (options.command === 'build' && 'outputPath' in options) {
    const result = await buildSb3({
      confirmReplace: confirmBuildReplacement,
      outputPath: options.outputPath,
      sourceDirectory: options.sourceDirectory,
      yes: options.yes,
    });
    const action = result.changed ? 'Built' : 'Already up to date';
    log(
      `${action}: ${result.outputPath} (${result.entryCount} entries, ` +
        `${result.assetCount} assets, ${result.embeddedExtensionCount} embedded extensions).`,
    );
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
