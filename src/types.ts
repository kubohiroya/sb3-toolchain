// SPDX-License-Identifier: MPL-2.0

/** Shapes shared across the expanded source format, the CLI, and the SB3 builders. */
import type {ExtensionArtifactLock} from './extension-artifact-lock';

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
  artifactLock?: ExtensionArtifactLock;
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
  /**
   * How the palette of TurboWarp Plus groups the bundle's blocks: `single` (the default) keeps them in one group,
   * `members` makes each member extension a group of its own (`groups` and `paletteGroup` in `getInfo()`).
   * Other editors ignore it and show the bundle as one category either way.
   */
  paletteGroups?: 'single' | 'members';
  /**
   * Whose colours the members' blocks are drawn in: `bundle` (the default) uses the bundle's colours for every
   * block, `member` keeps each member's own `color1`–`color3`, in every editor. A block's own colour always wins.
   */
  memberColors?: 'bundle' | 'member';
  /**
   * With `paletteGroups: 'members'`, parent palette groups that hold chosen member groups. Each parent is declared
   * in `getInfo().groups` once, before its first member, and each member's group carries `parent: '<parent id>'`.
   * A parent holds no blocks of its own. Editors that do not know `parent` show the groups flat.
   */
  memberParentGroups?: ExtensionBundleMemberParentGroup[];
}

export interface ExtensionBundleMemberParentGroup {
  /** Group ID, `[A-Za-z0-9_-]+`; it must not be a member ID or start with `<member ID>-`. */
  id: string;
  /** Display name: one text, or texts by locale such as `{en: 'Libraries', ja: 'ライブラリ'}`. */
  name: string | Record<string, string>;
  menuIconURI?: string;
  color1?: string;
  color2?: string;
  color3?: string;
  /** Bundle members whose groups nest under this parent; a member belongs to at most one parent. */
  members: string[];
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
  /** Present only in source format 2. */
  blockPalette?: string;
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
