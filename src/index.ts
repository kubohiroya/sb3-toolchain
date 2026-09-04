// SPDX-License-Identifier: MPL-2.0

export type {
  EmbeddedExtension,
  EmbeddedExtensionManifest,
  ExtensionApiManifestSource,
  ExtensionBundleConfiguration,
  ExtensionEncoding,
  ExtensionSource,
  GitHubExtensionSource,
  NpmExtensionSource,
  ProjectAssetReference,
  ProjectJson,
  ProjectTarget,
  Sb3SourceManifest,
} from './types';
export {assert} from './assert';
export {validateArchiveEntryName} from './archive';
export {buildSb3} from './build';
export {packageName, packageVersion} from './constants';
export {
  extensionHeaderId,
  extensionHeaderMetadata,
  extensionIntegrity,
  validateExtensionSourceMetadata,
  validateManagedExtensionContents,
} from './extension-dependencies';
export {
  compareExtensionApiManifests,
  defaultExtensionApiManifestSizeLimit,
  extensionApiManifestFormatVersion,
  extensionApiManifestIntegrity,
  extensionApiManifestLocalPath,
  formatExtensionApiCompatibilityChanges,
  parseExtensionApiManifest,
  validateExtensionApiManifestSourceMetadata,
  validateManagedExtensionApiManifest,
} from './extension-api-manifest';
export {
  bundleExtensions,
  planExtensionBundle,
  planExtensionUnbundle,
  unbundleExtensions,
} from './extension-bundle-configuration';
export {planBundledSb3Unbundle, unbundleSb3} from './extension-bundle-archive';
export {
  buildExtensionBundles,
  createStaticExtensionBundle,
  extensionBundleRecoveryMarker,
  validateExtensionBundleConfigurations,
} from './extension-bundle';
export {
  migrateExtensionId,
  planExtensionIdMigration,
  validateNewExtensionId,
} from './extension-id-migration';
export {
  defaultExtensionArtifactSizeLimit,
  extensionStatus,
  syncExtensions,
  updateExtensions,
} from './extension-sync';
export {decodeExtensionDataUrl, importSb3} from './import';
export {
  compareDirectories,
  inspectGitOutputState,
  validateOutputDirectoryPath,
} from './output-safety';
export {
  createDeterministicSb3,
  fixedZipTimestamp,
  sourceFormatVersion,
  validateSb3Source,
} from './source';
export {
  applyProjectAssetAdditions,
  projectAssetAdditionsFormatVersion,
} from './project-asset-additions';
export {
  assertSb3ReleaseSnapshotMetadata,
  computeReleaseSourceIdentity,
  createSb3ReleaseSnapshot,
  createSb3ReleaseSnapshotMetadata,
  freezeSb3ReleaseSnapshot,
  readSb3ReleaseSnapshotMetadata,
  recordPublishedSb3ReleaseSnapshot,
  verifySb3ReleaseSnapshot,
  writeSb3ReleaseCandidate,
} from './release-snapshot';
export {cleanUpTurboWarpBlocks, turboWarpCleanUpLayout} from './turbowarp-clean-up';
export type {BuildSb3Options, WriteSb3ArchiveOptions, WriteSb3ArchiveResult} from './build';
export type {CliOptions} from './cli';
export type {
  ExtensionApiCompatibilityChange,
  ExtensionApiManifest,
  ExtensionApiManifestArgument,
  ExtensionApiManifestBlock,
  ExtensionApiManifestMenu,
} from './extension-api-manifest';
export type {
  BuildExtensionBundlesResult,
  ExtensionBundleComponent,
  ExtensionBundleCounts,
  ExtensionBundlePlan,
} from './extension-bundle';
export type {BundledSb3UnbundlePlan} from './extension-bundle-archive';
export type {
  ExtensionIdMigrationCounts,
  ExtensionIdReference,
  RewriteExtensionIdDocumentsResult,
} from './extension-id-migration';
export type {
  ExtensionSyncConfirmContext,
  SyncExtensionsOptions,
  UpdateExtensionsOptions,
} from './extension-sync';
export type {
  DecodedExtensionDataUrl,
  ImportSb3Options,
  ImportSb3Result,
  OutputReplacementContext,
} from './import';
export type {DirectoryComparison, DirectoryDifferences, GitOutputState} from './output-safety';
export type {ProjectAssetAdditionsSummary} from './project-asset-additions';
export type {Sb3ReleaseSnapshotMetadata} from './release-snapshot';
export type {DeterministicSb3, InspectedSb3Source} from './source';
export type {TurboWarpCleanUpResult} from './turbowarp-clean-up';
