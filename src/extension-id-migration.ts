// SPDX-License-Identifier: MPL-2.0

import {cp, lstat, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {assert} from './assert';
import {extensionApiManifestIntegrity, parseExtensionApiManifest} from './extension-api-manifest';
import {extensionHeaderId, extensionIntegrity} from './extension-dependencies';
import {
  assertNoInterruptedRollback,
  compareDirectories,
  pathExists,
  replaceDirectoryTransactionally,
} from './output-safety';
import {createDeterministicSb3, inspectSb3SourceForExtensionSync} from './source';
import type {InspectedSb3Source} from './source';
import type {
  EmbeddedExtension,
  EmbeddedExtensionManifest,
  ProjectJson,
  UnknownRecord,
} from './types';

export interface ExtensionIdReference {
  file: string;
  kind: 'key' | 'value';
  path: string;
  value: string;
}

export interface ExtensionIdMigrationCounts {
  apiManifestArtifacts: number;
  blockOpcodes: number;
  extensionFiles: number;
  extensionUrlKeys: number;
  extensionUrlValues: number;
  manifestIds: number;
  manifestPaths: number;
  monitorOpcodes: number;
  projectExtensions: number;
  sourceArtifacts: number;
}

export interface RewriteExtensionIdDocumentsInput {
  apiManifestArtifact?: string;
  extensionManifest: EmbeddedExtensionManifest;
  newId: string;
  oldId: string;
  project: ProjectJson;
  sourceArtifact?: string;
}

export interface RewriteExtensionIdDocumentsResult {
  counts: ExtensionIdMigrationCounts;
  extensionIndex: number;
  extensionManifest: EmbeddedExtensionManifest;
  newApiManifestPath: string | null;
  newPath: string;
  oldApiManifestPath: string | null;
  oldPath: string;
  project: ProjectJson;
  totalChanges: number;
  unclassifiedReferences: ExtensionIdReference[];
}

interface MigrationContext {
  apiManifestContents: Uint8Array | null;
  artifactReady: boolean;
  contents: Uint8Array;
  extension: EmbeddedExtension;
  rewrite: RewriteExtensionIdDocumentsResult;
  source: InspectedSb3Source;
}

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function referenceKey(file: string, kind: string, pointer: string): string {
  return `${file}\u0000${kind}\u0000${pointer}`;
}

function collectUnclassifiedReferences(
  value: unknown,
  oldId: string,
  file: string,
  classified: Set<string>,
): ExtensionIdReference[] {
  const references: ExtensionIdReference[] = [];

  function visit(current: unknown, pointer: string): void {
    if (typeof current === 'string') {
      if (current.includes(oldId) && !classified.has(referenceKey(file, 'value', pointer))) {
        references.push({file, kind: 'value', path: pointer || '/', value: current});
      }
      return;
    }
    if (!current || typeof current !== 'object') return;

    if (Array.isArray(current)) {
      for (const [index, entry] of (current as unknown[]).entries()) {
        visit(entry, `${pointer}/${index}`);
      }
      return;
    }

    for (const [key, entry] of Object.entries(current as UnknownRecord)) {
      const entryPointer = `${pointer}/${escapeJsonPointer(key)}`;
      if (key.includes(oldId) && !classified.has(referenceKey(file, 'key', entryPointer))) {
        references.push({file, kind: 'key', path: entryPointer, value: key});
      }
      visit(entry, entryPointer);
    }
  }

  visit(value, '');
  return references;
}

function replaceObjectKeyAtSamePosition(
  object: UnknownRecord,
  oldKey: string,
  newKey: string,
): UnknownRecord {
  const replacement: UnknownRecord = {};
  for (const [key, value] of Object.entries(object)) {
    replacement[key === oldKey ? newKey : key] = value;
  }
  return replacement;
}

export function validateNewExtensionId(newId: unknown): string {
  assert(
    typeof newId === 'string' && /^[a-z0-9]+$/u.test(newId),
    `New extension ID must use TurboWarp's [a-z0-9]+ format: ${JSON.stringify(newId)}`,
  );
  return newId;
}

export function rewriteExtensionIdDocuments({
  apiManifestArtifact = undefined,
  extensionManifest,
  newId,
  oldId,
  project,
  sourceArtifact = undefined,
}: RewriteExtensionIdDocumentsInput): RewriteExtensionIdDocumentsResult {
  assert(
    typeof oldId === 'string' && /^[A-Za-z0-9._-]+$/u.test(oldId),
    `Invalid existing extension ID: ${JSON.stringify(oldId)}`,
  );
  validateNewExtensionId(newId);
  assert(oldId !== newId, 'The existing and new extension IDs must differ.');

  const originalProject = structuredClone(project);
  const originalManifest = structuredClone(extensionManifest);
  const migratedProject = structuredClone(project);
  const migratedManifest = structuredClone(extensionManifest);
  const extensions = migratedManifest.extensions;
  assert(Array.isArray(extensions), 'Embedded extension manifest requires extensions.');
  const extensionIndex = extensions.findIndex(
    (extension: EmbeddedExtension | undefined) => extension?.id === oldId,
  );
  assert(extensionIndex !== -1, `Embedded extension was not found: ${oldId}`);
  assert(
    !extensions.some((extension: EmbeddedExtension | undefined) => extension?.id === newId),
    `Embedded extension ID already exists: ${newId}`,
  );

  const extensionUrls: unknown = migratedProject.extensionURLs;
  assert(isObject(extensionUrls), 'project.source.json extensionURLs must be an object.');
  assert(
    Object.hasOwn(extensionUrls, oldId),
    `project.source.json has no extensionURLs entry for ${oldId}.`,
  );
  assert(
    !Object.hasOwn(extensionUrls, newId),
    `project.source.json extensionURLs already contains ${newId}.`,
  );
  assert(
    migratedProject.extensions === undefined || Array.isArray(migratedProject.extensions),
    'project.source.json extensions must be an array when present.',
  );
  assert(
    migratedProject.monitors === undefined || Array.isArray(migratedProject.monitors),
    'project.source.json monitors must be an array when present.',
  );
  const projectExtensions = migratedProject.extensions as unknown[] | undefined;
  if (projectExtensions) {
    assert(
      !projectExtensions.includes(newId),
      `project.source.json extensions already contains ${newId}.`,
    );
  }

  const counts: ExtensionIdMigrationCounts = {
    apiManifestArtifacts: 0,
    blockOpcodes: 0,
    extensionFiles: 1,
    extensionUrlKeys: 0,
    extensionUrlValues: 0,
    manifestIds: 0,
    manifestPaths: 0,
    monitorOpcodes: 0,
    projectExtensions: 0,
    sourceArtifacts: 0,
  };
  const projectClassified = new Set<string>();
  const manifestClassified = new Set<string>();

  if (projectExtensions) {
    for (const [index, extensionId] of projectExtensions.entries()) {
      if (extensionId === oldId) {
        projectExtensions[index] = newId;
        counts.projectExtensions += 1;
        projectClassified.add(referenceKey('project.source.json', 'value', `/extensions/${index}`));
      }
    }
  }

  const oldExtensionUrl = extensionUrls[oldId];
  const oldExtensionUrlPointer = `/extensionURLs/${escapeJsonPointer(oldId)}`;
  projectClassified.add(referenceKey('project.source.json', 'key', oldExtensionUrlPointer));
  counts.extensionUrlKeys += 1;
  const expectedOldUrl = `embedded-extension:extensions/${oldId}.js`;
  assert(
    oldExtensionUrl === expectedOldUrl,
    `Embedded extension URL mismatch for ${oldId}: ${oldExtensionUrl}`,
  );
  extensionUrls[oldId] = `embedded-extension:extensions/${newId}.js`;
  projectClassified.add(referenceKey('project.source.json', 'value', oldExtensionUrlPointer));
  counts.extensionUrlValues += 1;
  migratedProject.extensionURLs = replaceObjectKeyAtSamePosition(extensionUrls, oldId, newId);

  const migratedTargets = (migratedProject.targets as unknown[] | undefined) ?? [];
  for (const [targetIndex, target] of migratedTargets.entries()) {
    if (!isObject(target) || !isObject(target.blocks)) continue;
    for (const [blockId, block] of Object.entries(target.blocks)) {
      if (!isObject(block)) continue;
      if (typeof block.opcode === 'string' && block.opcode.startsWith(`${oldId}_`)) {
        block.opcode = `${newId}_${block.opcode.slice(oldId.length + 1)}`;
        counts.blockOpcodes += 1;
        projectClassified.add(
          referenceKey(
            'project.source.json',
            'value',
            `/targets/${targetIndex}/blocks/${escapeJsonPointer(blockId)}/opcode`,
          ),
        );
      }
    }
  }

  const migratedMonitors = (migratedProject.monitors as unknown[] | undefined) ?? [];
  for (const [monitorIndex, monitor] of migratedMonitors.entries()) {
    if (
      isObject(monitor) &&
      typeof monitor.opcode === 'string' &&
      monitor.opcode.startsWith(`${oldId}_`)
    ) {
      monitor.opcode = `${newId}_${monitor.opcode.slice(oldId.length + 1)}`;
      counts.monitorOpcodes += 1;
      projectClassified.add(
        referenceKey('project.source.json', 'value', `/monitors/${monitorIndex}/opcode`),
      );
    }
  }

  const extension = extensions[extensionIndex];
  extension.id = newId;
  counts.manifestIds += 1;
  manifestClassified.add(
    referenceKey('embedded-extensions.json', 'value', `/extensions/${extensionIndex}/id`),
  );
  const oldPath = `extensions/${oldId}.js`;
  assert(
    extension.path === oldPath,
    `Embedded extension path mismatch for ${oldId}: ${extension.path}`,
  );
  extension.path = `extensions/${newId}.js`;
  counts.manifestPaths += 1;
  manifestClassified.add(
    referenceKey('embedded-extensions.json', 'value', `/extensions/${extensionIndex}/path`),
  );
  let oldApiManifestPath = null;
  let newApiManifestPath = null;
  if (apiManifestArtifact !== undefined) {
    assert(
      extension.source?.apiManifest,
      `Extension ${oldId} has no managed API manifest metadata.`,
    );
  }
  if (extension.source?.apiManifest) {
    oldApiManifestPath = `extensions/${oldId}.manifest.json`;
    newApiManifestPath = `extensions/${newId}.manifest.json`;
    assert(
      extension.source.apiManifest.path === oldApiManifestPath,
      `Extension API manifest path mismatch for ${oldId}: ${extension.source.apiManifest.path}`,
    );
    extension.source.apiManifest.path = newApiManifestPath;
    counts.manifestPaths += 1;
    manifestClassified.add(
      referenceKey(
        'embedded-extensions.json',
        'value',
        `/extensions/${extensionIndex}/source/apiManifest/path`,
      ),
    );
    if (
      apiManifestArtifact !== undefined &&
      extension.source.apiManifest.artifact !== apiManifestArtifact
    ) {
      extension.source.apiManifest.artifact = apiManifestArtifact;
      counts.apiManifestArtifacts += 1;
      manifestClassified.add(
        referenceKey(
          'embedded-extensions.json',
          'value',
          `/extensions/${extensionIndex}/source/apiManifest/artifact`,
        ),
      );
    }
  }
  if (sourceArtifact !== undefined) {
    assert(extension.source, `Extension ${oldId} has no managed source metadata.`);
    if (extension.source.artifact !== sourceArtifact) {
      extension.source.artifact = sourceArtifact;
      counts.sourceArtifacts += 1;
      manifestClassified.add(
        referenceKey(
          'embedded-extensions.json',
          'value',
          `/extensions/${extensionIndex}/source/artifact`,
        ),
      );
    }
  }

  const unclassifiedReferences = [
    ...collectUnclassifiedReferences(
      originalProject,
      oldId,
      'project.source.json',
      projectClassified,
    ),
    ...collectUnclassifiedReferences(
      originalManifest,
      oldId,
      'embedded-extensions.json',
      manifestClassified,
    ),
  ];
  const totalChanges = Object.values(counts).reduce((total, count) => total + count, 0);
  return {
    counts,
    extensionIndex,
    extensionManifest: migratedManifest,
    newApiManifestPath,
    newPath: `extensions/${newId}.js`,
    oldApiManifestPath,
    oldPath,
    project: migratedProject,
    totalChanges,
    unclassifiedReferences,
  };
}

async function inspectMigrationSource(
  sourceDirectory: string,
  willReplace: boolean,
): Promise<InspectedSb3Source> {
  const resolvedSourceDirectory = path.resolve(sourceDirectory);
  if (willReplace) {
    assert(
      resolvedSourceDirectory !== path.parse(resolvedSourceDirectory).root,
      'Refusing to replace a filesystem root during extension ID migration.',
    );
    assert(
      !(await pathExists(path.join(resolvedSourceDirectory, '.git'))),
      'Refusing to replace a Git repository root during extension ID migration.',
    );
  }
  const stats = await lstat(resolvedSourceDirectory);
  assert(
    stats.isDirectory() && !stats.isSymbolicLink(),
    `SB3 source must be a directory, not a file or symbolic link: ${resolvedSourceDirectory}`,
  );
  if (willReplace) {
    await assertNoInterruptedRollback(resolvedSourceDirectory);
  }
  return inspectSb3SourceForExtensionSync(resolvedSourceDirectory);
}

async function migrationContext(
  sourceDirectory: string,
  oldId: string,
  newId: string,
  willReplace: boolean,
): Promise<MigrationContext> {
  const source = await inspectMigrationSource(sourceDirectory, willReplace);
  const extensionManifestPath = path.join(
    source.resolvedSourceDirectory,
    source.sourceManifest.embeddedExtensions,
  );
  const extensionManifest = JSON.parse(
    await readFile(extensionManifestPath, 'utf8'),
  ) as EmbeddedExtensionManifest;
  const rewrite = rewriteExtensionIdDocuments({
    extensionManifest,
    newId,
    oldId,
    project: source.project,
  });
  const extension = source.extensions[rewrite.extensionIndex];
  const contents = source.extensionContents.get(oldId);
  assert(contents, `Embedded extension has no contents: ${oldId}`);
  const apiManifestContents = source.extensionApiManifestContents.get(oldId) ?? null;
  let apiManifestReady = true;
  if (extension.source?.apiManifest) {
    apiManifestReady =
      apiManifestContents !== null &&
      extensionApiManifestIntegrity(apiManifestContents) === extension.source.apiManifest.integrity;
    if (apiManifestReady && apiManifestContents !== null) {
      try {
        parseExtensionApiManifest(apiManifestContents, {expectedId: newId});
      } catch {
        apiManifestReady = false;
      }
    }
  }
  return {
    apiManifestContents,
    artifactReady: extensionHeaderId(contents) === newId && apiManifestReady,
    contents,
    extension,
    rewrite,
    source,
  };
}

export async function planExtensionIdMigration({
  fromId,
  sourceDirectory,
  toId,
}: {
  fromId: string;
  sourceDirectory: string;
  toId: string;
}) {
  const context = await migrationContext(sourceDirectory, fromId, toId, false);
  return {
    artifactReady: context.artifactReady,
    counts: context.rewrite.counts,
    fromId,
    sourceDirectory: context.source.resolvedSourceDirectory,
    toId,
    totalChanges: context.rewrite.totalChanges,
    unclassifiedReferences: context.rewrite.unclassifiedReferences,
  };
}

export async function migrateExtensionId({
  fromId,
  sourceDirectory,
  toId,
  yes = false,
}: {
  fromId: string;
  sourceDirectory: string;
  toId: string;
  yes?: boolean;
}) {
  const context = await migrationContext(sourceDirectory, fromId, toId, yes);
  const plan = {
    artifactReady: context.artifactReady,
    counts: context.rewrite.counts,
    fromId,
    sourceDirectory: context.source.resolvedSourceDirectory,
    toId,
    totalChanges: context.rewrite.totalChanges,
    unclassifiedReferences: context.rewrite.unclassifiedReferences,
  };
  if (!yes) {
    return {
      applied: false,
      changed: false,
      ...plan,
      rollbackCleanupWarning: null,
    };
  }

  assert(
    context.artifactReady,
    `Extension artifact must declare // ID: ${toId} before migration. ` +
      `For managed extensions, use extensions update ${fromId} --migrate-id ${toId}.`,
  );
  if (context.extension.source) {
    assert(
      extensionIntegrity(context.contents) === context.extension.source.integrity,
      `Managed extension ${fromId} does not match its source integrity. ` +
        'Use extensions update with --migrate-id so provenance is updated atomically.',
    );
  }
  const initialComparison = await compareDirectories(
    context.source.resolvedSourceDirectory,
    context.source.resolvedSourceDirectory,
  );
  assert(
    initialComparison.identical &&
      initialComparison.existingFingerprint === initialComparison.candidateFingerprint,
    'SB3 source changed while its initial migration state was being inspected.',
  );

  const parentDirectory = path.dirname(context.source.resolvedSourceDirectory);
  const candidateDirectory = await mkdtemp(
    path.join(parentDirectory, `.${path.basename(context.source.resolvedSourceDirectory)}.id-`),
  );
  let installed = false;
  try {
    await cp(context.source.resolvedSourceDirectory, candidateDirectory, {
      preserveTimestamps: true,
      recursive: true,
      verbatimSymlinks: true,
    });
    const replacements = [
      writeFile(
        path.join(candidateDirectory, context.source.sourceManifest.project),
        `${JSON.stringify(context.rewrite.project, null, 2)}\n`,
      ),
      writeFile(
        path.join(candidateDirectory, context.source.sourceManifest.embeddedExtensions),
        `${JSON.stringify(context.rewrite.extensionManifest, null, 2)}\n`,
      ),
      rename(
        path.join(candidateDirectory, context.rewrite.oldPath),
        path.join(candidateDirectory, context.rewrite.newPath),
      ),
    ];
    if (context.rewrite.oldApiManifestPath && context.rewrite.newApiManifestPath) {
      replacements.push(
        rename(
          path.join(candidateDirectory, context.rewrite.oldApiManifestPath),
          path.join(candidateDirectory, context.rewrite.newApiManifestPath),
        ),
      );
    }
    await Promise.all(replacements);
    await createDeterministicSb3(candidateDirectory);
    const comparison = await compareDirectories(
      context.source.resolvedSourceDirectory,
      candidateDirectory,
    );
    assert(
      comparison.existingFingerprint === initialComparison.existingFingerprint,
      'SB3 source changed while the ID migration candidate was prepared; refusing to replace it.',
    );
    assert(!comparison.identical, 'Extension ID migration produced no source changes.');
    const latestComparison = await compareDirectories(
      context.source.resolvedSourceDirectory,
      candidateDirectory,
    );
    assert(
      latestComparison.existingFingerprint === comparison.existingFingerprint &&
        latestComparison.candidateFingerprint === comparison.candidateFingerprint,
      'SB3 source or ID migration candidate changed during migration; refusing to replace it.',
    );
    const replacement = await replaceDirectoryTransactionally(
      candidateDirectory,
      context.source.resolvedSourceDirectory,
    );
    installed = true;
    return {
      applied: true,
      changed: true,
      comparison,
      ...plan,
      ...replacement,
    };
  } finally {
    if (!installed) {
      await rm(candidateDirectory, {recursive: true, force: true});
    }
  }
}
