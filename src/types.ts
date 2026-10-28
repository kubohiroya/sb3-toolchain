// SPDX-License-Identifier: MPL-2.0

/** Shapes shared across the expanded source format, the CLI, and the SB3 builders. */

export interface ExtensionApiManifestSource {
  artifact: string;
  path: string;
  formatVersion: number;
  integrity: string;
}

export interface GitHubExtensionSource {
  provider: 'github';
  repository: string;
  ref: string;
  resolvedCommit: string;
  artifact: string;
  integrity: string;
  apiManifest?: ExtensionApiManifestSource;
}

export interface NpmExtensionSource {
  provider: 'npm';
  package: string;
  version: string;
  artifact: string;
  integrity: string;
  apiManifest?: ExtensionApiManifestSource;
  module?: ExtensionModuleSource;
}

export interface ExtensionModuleSource {
  artifact: string;
  formatVersion: 1;
  integrity: string;
  unsandboxed: 'required' | 'optional' | 'not-needed';
}

export type ExtensionSource = GitHubExtensionSource | NpmExtensionSource;

export type ExtensionEncoding = 'base64' | 'percent';

export interface EmbeddedExtension {
  id: string;
  path: string;
  mediaType: string;
  parameters: string[];
  encoding: ExtensionEncoding;
  source?: ExtensionSource;
}

/** Explicit presentation of the bundle itself, independent of its member packages. */
export interface ExtensionBundleMetadata {
  description?: string;
  descriptions?: Record<string, string>;
  author?: string;
  authorURL?: string;
  version?: string;
  updatedAt?: string;
  repository?: string;
  docsURL?: string;
  banner?: string;
  package?: string;
}

export interface ExtensionBundleConfiguration {
  id: string;
  name: string;
  members: string[];
  metadata?: ExtensionBundleMetadata;
  recoveryCapsule?: boolean;
  sandboxedNotice?: Record<string, string>;
  blockEditorRegistrations?: boolean;
  buildMode?: 'classic' | 'module';
  sharedDependencies?: Record<string, string>;
}

export interface EmbeddedExtensionManifest {
  formatVersion: number;
  extensions: EmbeddedExtension[];
  extensionBundles?: ExtensionBundleConfiguration[];
}

export interface Sb3SourceManifest {
  formatVersion: number;
  project: string;
  embeddedExtensions: string;
  assetsDirectory: string;
  archiveEntries: string[];
}

/**
 * `project.json` is treated as an opaque record whose known members are narrowed on demand.
 * Unknown members are preserved verbatim so builds stay byte-for-byte reproducible.
 */
export interface ProjectJson {
  targets?: unknown;
  extensions?: unknown;
  extensionURLs?: Record<string, unknown>;
  monitors?: unknown;
  [key: string]: unknown;
}

export interface ProjectAssetReference {
  assetId?: unknown;
  dataFormat?: unknown;
  md5ext?: unknown;
  name?: unknown;
  [key: string]: unknown;
}

export interface ProjectTarget {
  isStage?: unknown;
  name?: unknown;
  costumes?: unknown;
  sounds?: unknown;
  blocks?: unknown;
  comments?: unknown;
  [key: string]: unknown;
}

export type UnknownRecord = Record<string, unknown>;
