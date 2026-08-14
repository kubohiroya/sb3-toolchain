// SPDX-License-Identifier: MPL-2.0

import {cp, lstat, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {
  buildExtensionBundles,
  validateBundleId,
  validateBundleName,
  validateExtensionBundleConfigurations,
} from './extension-bundle.js';
import {
  assertNoInterruptedRollback,
  compareDirectories,
  pathExists,
  replaceDirectoryTransactionally,
} from './output-safety.js';
import {createDeterministicSb3, inspectSb3SourceForExtensionSync} from './source.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function inspectConfigurationSource(sourceDirectory, willReplace) {
  const resolvedSourceDirectory = path.resolve(sourceDirectory);
  if (willReplace) {
    assert(
      resolvedSourceDirectory !== path.parse(resolvedSourceDirectory).root,
      'Refusing to replace a filesystem root while configuring extension bundles.',
    );
    assert(
      !(await pathExists(path.join(resolvedSourceDirectory, '.git'))),
      'Refusing to replace a Git repository root while configuring extension bundles.',
    );
  }
  const stats = await lstat(resolvedSourceDirectory);
  assert(
    stats.isDirectory() && !stats.isSymbolicLink(),
    `SB3 source must be a directory, not a file or symbolic link: ${resolvedSourceDirectory}`,
  );
  if (willReplace) await assertNoInterruptedRollback(resolvedSourceDirectory);
  return inspectSb3SourceForExtensionSync(resolvedSourceDirectory);
}

async function readExtensionManifest(source) {
  const manifestPath = path.join(
    source.resolvedSourceDirectory,
    source.sourceManifest.embeddedExtensions,
  );
  return JSON.parse(await readFile(manifestPath, 'utf8'));
}

async function configurationContext({
  bundleId,
  bundleName,
  extensionIds,
  recoveryCapsule,
  sourceDirectory,
  willReplace,
}) {
  validateBundleId(bundleId);
  validateBundleName(bundleName);
  assert(typeof recoveryCapsule === 'boolean', 'recoveryCapsule must be a boolean.');
  const source = await inspectConfigurationSource(sourceDirectory, willReplace);
  const extensionManifest = await readExtensionManifest(source);
  const existingBundles = validateExtensionBundleConfigurations(
    extensionManifest.extensionBundles,
    extensionManifest.extensions,
  );
  assert(
    !existingBundles.some((bundle) => bundle.id === bundleId),
    `Extension bundle already exists: ${bundleId}`,
  );
  const alreadyBundled = new Set(existingBundles.flatMap((bundle) => bundle.members));
  const members =
    extensionIds && extensionIds.length > 0
      ? [...extensionIds]
      : source.extensions
          .map((extension) => extension.id)
          .filter((extensionId) => !alreadyBundled.has(extensionId));
  const candidateManifest = structuredClone(extensionManifest);
  candidateManifest.extensionBundles = [
    ...existingBundles,
    {
      id: bundleId,
      members,
      name: bundleName,
      ...(recoveryCapsule === false ? {recoveryCapsule: false} : {}),
    },
  ];
  const extensionBundles = validateExtensionBundleConfigurations(
    candidateManifest.extensionBundles,
    candidateManifest.extensions,
  );
  const buildPlan = buildExtensionBundles({
    extensionBundles,
    extensionContents: source.extensionContents,
    extensions: source.extensions,
    project: source.project,
  });
  const configuredBundle = buildPlan.bundlePlans.find((plan) => plan.bundle.id === bundleId);
  return {buildPlan, candidateManifest, configuredBundle, extensionManifest, source};
}

export async function planExtensionBundle({
  bundleId,
  bundleName,
  extensionIds,
  recoveryCapsule = true,
  sourceDirectory,
}) {
  const context = await configurationContext({
    bundleId,
    bundleName,
    extensionIds,
    recoveryCapsule,
    sourceDirectory,
    willReplace: false,
  });
  return {
    applied: false,
    bundleId,
    bundleName,
    changed: true,
    components: context.configuredBundle.components.map((component) => component.metadata),
    counts: context.configuredBundle.counts,
    members: [...context.configuredBundle.bundle.members],
    recoveryCapsule: context.configuredBundle.bundle.recoveryCapsule !== false,
    sourceDirectory: context.source.resolvedSourceDirectory,
  };
}

async function installManifestConfiguration(context, operation) {
  const initialComparison = await compareDirectories(
    context.source.resolvedSourceDirectory,
    context.source.resolvedSourceDirectory,
  );
  assert(
    initialComparison.identical &&
      initialComparison.existingFingerprint === initialComparison.candidateFingerprint,
    `SB3 source changed while its initial ${operation} state was inspected.`,
  );
  const parentDirectory = path.dirname(context.source.resolvedSourceDirectory);
  const candidateDirectory = await mkdtemp(
    path.join(parentDirectory, `.${path.basename(context.source.resolvedSourceDirectory)}.bundle-`),
  );
  let installed = false;
  try {
    await cp(context.source.resolvedSourceDirectory, candidateDirectory, {
      preserveTimestamps: true,
      recursive: true,
      verbatimSymlinks: true,
    });
    await writeFile(
      path.join(candidateDirectory, context.source.sourceManifest.embeddedExtensions),
      `${JSON.stringify(context.candidateManifest, null, 2)}\n`,
    );
    await createDeterministicSb3(candidateDirectory);
    const comparison = await compareDirectories(
      context.source.resolvedSourceDirectory,
      candidateDirectory,
    );
    assert(
      comparison.existingFingerprint === initialComparison.existingFingerprint,
      `SB3 source changed while the ${operation} candidate was prepared; refusing to replace it.`,
    );
    assert(!comparison.identical, `Extension bundle ${operation} produced no source changes.`);
    const latestComparison = await compareDirectories(
      context.source.resolvedSourceDirectory,
      candidateDirectory,
    );
    assert(
      latestComparison.existingFingerprint === comparison.existingFingerprint &&
        latestComparison.candidateFingerprint === comparison.candidateFingerprint,
      `SB3 source or ${operation} candidate changed during the operation; refusing to replace it.`,
    );
    const replacement = await replaceDirectoryTransactionally(
      candidateDirectory,
      context.source.resolvedSourceDirectory,
    );
    installed = true;
    return {comparison, ...replacement};
  } finally {
    if (!installed) await rm(candidateDirectory, {recursive: true, force: true});
  }
}

export async function bundleExtensions({
  bundleId,
  bundleName,
  extensionIds,
  recoveryCapsule = true,
  sourceDirectory,
  yes = false,
}) {
  const context = await configurationContext({
    bundleId,
    bundleName,
    extensionIds,
    recoveryCapsule,
    sourceDirectory,
    willReplace: yes,
  });
  const plan = {
    bundleId,
    bundleName,
    components: context.configuredBundle.components.map((component) => component.metadata),
    counts: context.configuredBundle.counts,
    members: [...context.configuredBundle.bundle.members],
    recoveryCapsule: context.configuredBundle.bundle.recoveryCapsule !== false,
    sourceDirectory: context.source.resolvedSourceDirectory,
  };
  if (!yes) {
    return {applied: false, changed: true, ...plan, rollbackCleanupWarning: null};
  }
  const installation = await installManifestConfiguration(context, 'configuration');
  return {applied: true, changed: true, ...installation, ...plan};
}

async function unbundleContext({bundleId, sourceDirectory, willReplace}) {
  validateBundleId(bundleId);
  const source = await inspectConfigurationSource(sourceDirectory, willReplace);
  const extensionManifest = await readExtensionManifest(source);
  const extensionBundles = validateExtensionBundleConfigurations(
    extensionManifest.extensionBundles,
    extensionManifest.extensions,
  );
  const removedBundle = extensionBundles.find((bundle) => bundle.id === bundleId);
  assert(removedBundle, `Extension bundle was not found: ${bundleId}`);
  const candidateManifest = structuredClone(extensionManifest);
  const remainingBundles = extensionBundles.filter((bundle) => bundle.id !== bundleId);
  if (remainingBundles.length === 0) {
    delete candidateManifest.extensionBundles;
  } else {
    candidateManifest.extensionBundles = remainingBundles;
  }
  return {candidateManifest, extensionManifest, removedBundle, source};
}

export async function planExtensionUnbundle({bundleId, sourceDirectory}) {
  const context = await unbundleContext({bundleId, sourceDirectory, willReplace: false});
  return {
    applied: false,
    bundleId,
    changed: true,
    members: [...context.removedBundle.members],
    sourceDirectory: context.source.resolvedSourceDirectory,
  };
}

export async function unbundleExtensions({bundleId, sourceDirectory, yes = false}) {
  const context = await unbundleContext({bundleId, sourceDirectory, willReplace: yes});
  const plan = {
    bundleId,
    members: [...context.removedBundle.members],
    sourceDirectory: context.source.resolvedSourceDirectory,
  };
  if (!yes) {
    return {applied: false, changed: true, ...plan, rollbackCleanupWarning: null};
  }
  const installation = await installManifestConfiguration(context, 'removal');
  return {applied: true, changed: true, ...installation, ...plan};
}
