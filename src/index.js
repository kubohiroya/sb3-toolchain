// SPDX-License-Identifier: MPL-2.0

export {validateArchiveEntryName} from './archive.js';
export {buildSb3} from './build.js';
export {packageName, packageVersion} from './constants.js';
export {
  extensionHeaderId,
  extensionHeaderMetadata,
  extensionIntegrity,
  validateExtensionSourceMetadata,
  validateManagedExtensionContents,
} from './extension-dependencies.js';
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
} from './extension-api-manifest.js';
export {
  bundleExtensions,
  planExtensionBundle,
  planExtensionUnbundle,
  unbundleExtensions,
} from './extension-bundle-configuration.js';
export {planBundledSb3Unbundle, unbundleSb3} from './extension-bundle-archive.js';
export {
  buildExtensionBundles,
  createStaticExtensionBundle,
  extensionBundleRecoveryMarker,
  validateExtensionBundleConfigurations,
} from './extension-bundle.js';
export {
  migrateExtensionId,
  planExtensionIdMigration,
  validateNewExtensionId,
} from './extension-id-migration.js';
export {
  defaultExtensionArtifactSizeLimit,
  extensionStatus,
  syncExtensions,
  updateExtensions,
} from './extension-sync.js';
export {decodeExtensionDataUrl, importSb3} from './import.js';
export {
  compareDirectories,
  inspectGitOutputState,
  validateOutputDirectoryPath,
} from './output-safety.js';
export {
  createDeterministicSb3,
  fixedZipTimestamp,
  sourceFormatVersion,
  validateSb3Source,
} from './source.js';
