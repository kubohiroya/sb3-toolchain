// SPDX-License-Identifier: MPL-2.0

import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {assert} from './assert';
import {decodeExtensionBytes, expandArchive, formatSourceFiles} from './expand-archive';
import {validateManagedExtensionApiManifest} from './extension-api-manifest';
import {validateManagedExtensionContents} from './extension-dependencies';
import {
  assertNoInterruptedRollback,
  assertRecognizedOutputDirectory,
  compareDirectories,
  inspectGitOutputState,
  pathExists,
  replaceDirectoryTransactionally,
  validateOutputDirectoryPath,
} from './output-safety';
import type {DirectoryComparison, GitOutputState} from './output-safety';
import {isObject, sourceFormatVersion} from './source-format';
import type {ExtensionEncoding, ExtensionSource} from './types';

export {validateOutputDirectoryPath} from './output-safety';

export interface DecodedExtensionDataUrl {
  encoding: ExtensionEncoding;
  mediaType: string;
  parameters: string[];
  source: Buffer;
}

export interface OutputReplacementContext {
  comparison: DirectoryComparison;
  discardLocalChanges: boolean;
  gitState: GitOutputState;
  outputDirectory: string;
}

interface OutputReplacementDecision {
  action: 'create' | 'unchanged' | 'replace';
  comparison: DirectoryComparison | null;
  discardLocalChanges?: boolean;
  gitState: GitOutputState | null;
  outputDirectory?: string;
}

export interface ImportSb3Options {
  confirmReplace?: (context: OutputReplacementContext) => boolean | Promise<boolean>;
  discardLocalChanges?: boolean;
  inputPath: string;
  outputDirectory: string;
  protectedRoot?: string;
  yes?: boolean;
}

export interface ImportSb3Result {
  archiveEntryCount: number;
  assetCount: number;
  changed: boolean;
  differenceCounts: {added: number; modified: number; removed: number} | null;
  embeddedExtensionCount: number;
  inputPath: string;
  outputDirectory: string;
  rollbackCleanupWarning: string | null;
}

function summarizeGitChanges(gitState: GitOutputState): string {
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
}: {
  candidateDirectory: string;
  confirmReplace?: (context: OutputReplacementContext) => boolean | Promise<boolean>;
  discardLocalChanges: boolean;
  outputDirectory: string;
  yes: boolean;
}): Promise<OutputReplacementDecision> {
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
}: {
  candidateDirectory: string;
  decision: OutputReplacementContext;
  discardLocalChanges: boolean;
  outputDirectory: string;
}): Promise<void> {
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

async function readExistingExtensionSources(
  outputDirectory: string,
): Promise<Map<string, ExtensionSource>> {
  if (!(await pathExists(outputDirectory))) {
    return new Map();
  }

  const manifestPath = path.join(outputDirectory, 'embedded-extensions.json');
  if (!(await pathExists(manifestPath))) {
    return new Map();
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Existing embedded extension manifest is not valid JSON: ${manifestPath}`, {
      cause: error,
    });
  }
  assert(
    isObject(manifest) && Array.isArray(manifest.extensions),
    `Existing embedded extension manifest is invalid: ${manifestPath}`,
  );

  const sources = new Map<string, ExtensionSource>();
  for (const extension of manifest.extensions as unknown[]) {
    if (
      !isObject(extension) ||
      typeof extension.id !== 'string' ||
      typeof extension.path !== 'string' ||
      extension.source === undefined
    ) {
      continue;
    }
    sources.set(`${extension.id}\u0000${extension.path}`, extension.source as ExtensionSource);
  }
  return sources;
}

export function decodeExtensionDataUrl(dataUrl: unknown): DecodedExtensionDataUrl {
  const decoded = decodeExtensionBytes(dataUrl);
  return {...decoded, source: Buffer.from(decoded.source)};
}

export async function importSb3({
  inputPath,
  outputDirectory,
  protectedRoot = process.cwd(),
  discardLocalChanges = false,
  yes = false,
  confirmReplace,
}: ImportSb3Options): Promise<ImportSb3Result> {
  assert(typeof inputPath === 'string', 'Input SB3 path is required.');
  assert(typeof outputDirectory === 'string', 'SB3 source output directory is required.');
  const resolvedInputPath = path.resolve(inputPath);
  const resolvedOutputDirectory = validateOutputDirectoryPath(outputDirectory, protectedRoot);

  const expanded = expandArchive(await readFile(resolvedInputPath));
  const existingSources = await readExistingExtensionSources(resolvedOutputDirectory);
  for (const extension of expanded.embeddedExtensions) {
    const source = existingSources.get(`${extension.id}\u0000${extension.path}`);
    if (source === undefined) continue;
    extension.source = structuredClone(source);
    validateManagedExtensionContents(extension, expanded.extensionFiles.get(extension.path)!);
    if (extension.source.apiManifest) {
      const contents = await readFile(
        path.join(resolvedOutputDirectory, extension.source.apiManifest.path),
      );
      validateManagedExtensionApiManifest(extension, contents);
      expanded.extensionFiles.set(extension.source.apiManifest.path, contents);
    }
  }
  let decision: OutputReplacementDecision | undefined;
  let rollbackCleanupWarning: string | null = null;

  const outputParent = path.dirname(resolvedOutputDirectory);
  await mkdir(outputParent, {recursive: true});
  const temporaryDirectory = await mkdtemp(
    path.join(outputParent, `.${path.basename(resolvedOutputDirectory)}.import-`),
  );

  try {
    await mkdir(path.join(temporaryDirectory, 'assets'), {recursive: true});
    await mkdir(path.join(temporaryDirectory, 'extensions'), {recursive: true});
    for (const [name, contents] of formatSourceFiles(expanded)) {
      const outputPath = path.resolve(temporaryDirectory, name);
      assert(
        outputPath.startsWith(`${temporaryDirectory}${path.sep}`),
        `SB3 archive entry escapes the source directory: ${JSON.stringify(name)}`,
      );
      await mkdir(path.dirname(outputPath), {recursive: true});
      await writeFile(outputPath, contents);
    }
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
          decision: decision as OutputReplacementContext,
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
    archiveEntryCount: expanded.archiveEntries.length,
    assetCount: expanded.assets.size,
    embeddedExtensionCount: expanded.embeddedExtensions.length,
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
