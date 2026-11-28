// SPDX-License-Identifier: MPL-2.0

import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {createInterface} from 'node:readline/promises';

import {assert} from './assert';
import {buildSb3} from './build';
import {cleanUpSb3} from './clean-up-sb3';
import {packageVersion} from './constants';
import {unbundleSb3} from './extension-bundle-archive';
import {bundleExtensions, unbundleExtensions} from './extension-bundle-configuration';
import {validateExtensionBundleMetadata} from './extension-bundle-metadata';
import {
  formatExtensionDigestInventory,
  inventoryExtensionDigests,
} from './extension-digest-inventory';
import type {ExtensionBundleMemberParentGroup, ExtensionBundleMetadata} from './types';
import {migrateExtensionId} from './extension-id-migration';
import {replaceSb3Extensions} from './extension-sb3-replacement';
import {listSb3Extensions, updateSb3Extensions} from './project-extensions-cli';
import type {
  ProjectExtension,
  ProjectExtensionPlan,
  ProjectExtensionRequest,
} from './project-extensions';
import type {ExtensionIdMigrationCounts, ExtensionIdReference} from './extension-id-migration';
import {extensionStatus, syncExtensions, updateExtensions} from './extension-sync';
import type {ExtensionSyncConfirmContext, FetchImplementation} from './extension-sync';
import {importSb3} from './import';
import type {OutputReplacementContext} from './import';
import type {DirectoryDifferences} from './output-safety';
import {createDeterministicSb3, validateSb3Source} from './source';
import {listProjectTests} from './test-list';
import {runProjectTests} from './test-run';
import {toJUnitXml} from '@kubohiroya/turbowarp-plus-editor-test/junit';

export interface HelpCliOptions {
  command: 'help';
}

export interface VersionCliOptions {
  command: 'version';
}

export interface ImportCliOptions {
  command: 'import';
  discardLocalChanges: boolean;
  inputPath: string;
  outputDirectory: string;
  yes: boolean;
}

export interface CheckCliOptions {
  allowedAssetRoots?: string[];
  command: 'check';
  projectAssetsPath?: string;
  sourceDirectory: string;
}

export interface BuildCliOptions {
  allowedAssetRoots?: string[];
  cleanUpBlocks?: boolean;
  command: 'build';
  outputPath: string;
  projectAssetsPath?: string;
  sourceDirectory: string;
  stripTests?: boolean;
  yes: boolean;
}

export interface CleanUpCliOptions {
  command: 'clean-up';
  inputPath: string;
  outputPath: string;
  yes: boolean;
}

export interface ExtensionsStatusCliOptions {
  action: 'status';
  command: 'extensions';
  sourceDirectory: string;
}

export interface ExtensionsMutationCliOptions {
  action: 'sync' | 'update';
  allowBreakingApi?: boolean;
  apiManifestArtifact?: string;
  command: 'extensions';
  extensionId?: string;
  migrateToId?: string;
  sourceArtifact?: string;
  sourceDirectory: string;
  yes: boolean;
}

export interface ExtensionsMigrateIdCliOptions {
  action: 'migrate-id';
  command: 'extensions';
  fromId: string;
  sourceDirectory: string;
  toId: string;
  yes: boolean;
}

export interface ExtensionsBundleCliOptions {
  action: 'bundle';
  bundleId: string;
  bundleName: string;
  metadata?: ExtensionBundleMetadata;
  command: 'extensions';
  extensionIds: string[];
  recoveryCapsule: boolean;
  sourceDirectory: string;
  yes: boolean;
  buildMode?: 'classic' | 'module';
  sharedDependencies?: Record<string, string>;
  paletteGroups?: 'single' | 'members';
  memberColors?: 'bundle' | 'member';
  memberParentGroups?: ExtensionBundleMemberParentGroup[];
}

export interface ExtensionsUnbundleSourceCliOptions {
  action: 'unbundle';
  bundleId: string;
  command: 'extensions';
  sourceDirectory: string;
  yes: boolean;
}

export interface ExtensionsUnbundleArchiveCliOptions {
  action: 'unbundle';
  bundleId: string;
  command: 'extensions';
  inputPath: string;
  outputPath: string;
  yes: boolean;
}

export interface ExtensionsDigestsCliOptions {
  action: 'digests';
  command: 'extensions';
  inputPaths: string[];
  json: boolean;
}

export interface ExtensionsReplaceSb3CliOptions {
  action: 'replace-sb3';
  command: 'extensions';
  fromPath?: string;
  inputPath: string;
  outputPath: string;
  yes: boolean;
}

export interface ExtensionsListSb3CliOptions {
  action: 'list-sb3';
  command: 'extensions';
  inputPath: string;
  json: boolean;
}

export interface ExtensionsUpdateSb3CliOptions {
  action: 'update-sb3';
  command: 'extensions';
  inputPath: string;
  /** Absent with --dry-run. */
  outputPath?: string;
  requests: Record<string, ProjectExtensionRequest>;
  json: boolean;
  yes: boolean;
}

export type ExtensionsCliOptions =
  | ExtensionsListSb3CliOptions
  | ExtensionsUpdateSb3CliOptions
  | ExtensionsDigestsCliOptions
  | ExtensionsReplaceSb3CliOptions
  | ExtensionsStatusCliOptions
  | ExtensionsMutationCliOptions
  | ExtensionsMigrateIdCliOptions
  | ExtensionsBundleCliOptions
  | ExtensionsUnbundleSourceCliOptions
  | ExtensionsUnbundleArchiveCliOptions;

export interface TestListCliOptions {
  command: 'test';
  action: 'list';
  inputPath: string;
  json: boolean;
}

export interface TestRunCliOptions {
  command: 'test';
  action: 'run';
  inputPath: string;
  editorDirectory: string;
  revision: string;
  only: string[];
  allowed: Map<string, string>;
  outputPath?: string;
}

function parseTestRunArguments(input: string | undefined, args: string[]): TestRunCliOptions {
  assert(input && !input.startsWith('-'), 'The test run command requires an INPUT.sb3.');
  const flags = new Map<string, string>();
  const only: string[] = [];
  const allowed = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    assert(value && !value.startsWith('--'), `Missing value: ${key}`);
    if (key === '--test') {
      only.push(value);
      continue;
    }
    if (key === '--allow-sandboxed') {
      const grant = /^([a-zA-Z0-9]+)=([0-9a-f]{64})$/.exec(value);
      assert(
        grant && grant[1] !== 'kubohiroyatest' && !allowed.has(grant[1]) && allowed.size < 32,
        'Use a unique --allow-sandboxed ID=SHA256 for each extra extension.',
      );
      allowed.set(grant[1], grant[2]);
      continue;
    }
    assert(
      ['--editor-dir', '--editor-revision', '--reporter', '--out'].includes(key) && !flags.has(key),
      `Unknown or duplicate option: ${key}`,
    );
    flags.set(key, value);
  }
  const editorDirectory = flags.get('--editor-dir');
  const revision = flags.get('--editor-revision');
  const outputPath = flags.get('--out');
  assert(
    editorDirectory && revision && /^[0-9a-f]{40}$/.test(revision),
    'Supply --editor-dir and a full --editor-revision commit SHA.',
  );
  assert(
    !flags.has('--reporter') || flags.get('--reporter') === 'junit',
    'Only the junit reporter is supported.',
  );
  return {
    command: 'test',
    action: 'run',
    inputPath: path.resolve(input),
    editorDirectory: path.resolve(editorDirectory),
    revision,
    only,
    allowed,
    ...(outputPath ? {outputPath: path.resolve(outputPath)} : {}),
  };
}

export type CliOptions =
  | TestRunCliOptions
  | TestListCliOptions
  | HelpCliOptions
  | VersionCliOptions
  | ImportCliOptions
  | CheckCliOptions
  | BuildCliOptions
  | CleanUpCliOptions
  | ExtensionsCliOptions;

export interface RunCliOptions {
  fetch?: FetchImplementation;
  log?: (message: string) => void;
}

interface MigrationLogResult {
  applied: boolean;
  artifactReady: boolean;
  counts: ExtensionIdMigrationCounts;
  fromId: string | undefined;
  toId: string | undefined;
  totalChanges: number;
  unclassifiedReferences: ExtensionIdReference[];
}

export function usage() {
  return `Usage:
  sb3-toolchain import INPUT.sb3 --output SOURCE_DIR [--yes] [--discard-local-changes]
  sb3-toolchain check SOURCE_DIR [--project-assets MANIFEST.json] [--allow-asset-root DIR ...]
  sb3-toolchain build SOURCE_DIR --output OUTPUT.sb3 [--project-assets MANIFEST.json] [--allow-asset-root DIR ...] [--clean-up-blocks] [--strip-tests] [--yes]
  sb3-toolchain clean-up INPUT.sb3 --output OUTPUT.sb3 [--yes]
  sb3-toolchain test list INPUT.sb3|SOURCE_DIR [--json]
  sb3-toolchain test run INPUT.sb3 --editor-dir DIR --editor-revision SHA [--test TARGET/BLOCK_ID ...] [--allow-sandboxed ID=SHA256 ...] [--reporter junit] [--out FILE]
  sb3-toolchain extensions digests INPUT.sb3 [INPUT.sb3 ...] [--json]
  sb3-toolchain extensions replace-sb3 INPUT.sb3 [--from DONOR.sb3] --output OUTPUT.sb3 [--yes]
  sb3-toolchain extensions list-sb3 INPUT.sb3 [--json]
  sb3-toolchain extensions update-sb3 INPUT.sb3 (--output OUTPUT.sb3 | --dry-run) [--version ID=latest|X.Y.Z ...] [--format ID=FORMAT ...] [--reference ID=REFERENCE ...] [--url ID=URL ...] [--allow-prerelease] [--allow-breaking-api] [--allow-execution-change] [--json] [--yes]
  sb3-toolchain extensions status SOURCE_DIR
  sb3-toolchain extensions sync SOURCE_DIR [--yes]
  sb3-toolchain extensions update SOURCE_DIR [EXTENSION_ID] [--migrate-id NEW_ID] [--artifact PATH] [--api-manifest-artifact PATH] [--allow-breaking-api --yes]
  sb3-toolchain extensions migrate-id SOURCE_DIR --from OLD_ID --to NEW_ID [--yes]
  sb3-toolchain extensions bundle SOURCE_DIR --id BUNDLE_ID --name NAME [EXTENSION_ID ...] [--metadata-json JSON] [--build-mode classic|module] [--palette-groups single|members] [--member-colors bundle|member] [--member-parent-groups-json JSON] [--share PACKAGE@EXACT_VERSION] [--include-recovery-capsule] [--yes]
  sb3-toolchain extensions unbundle SOURCE_DIR BUNDLE_ID [--yes]
  sb3-toolchain extensions unbundle INPUT.sb3 BUNDLE_ID --output OUTPUT.sb3 [--yes]

Commands:
  import      Expand an SB3 into Git-friendly source files.
  check       Validate an expanded SB3 source directory.
  build       Build a deterministic SB3 from expanded sources.
  clean-up    Arrange scripts in a more compact layout and write a separate SB3.
  extensions  Inspect, restore, or update managed embedded extensions.
  test list   Find project tests by target and block ID without executing them.

Build layout cleanup:
  --clean-up-blocks applies a deterministic TurboWarp-style "Clean up Blocks"
  layout to every target in the generated SB3. It never deletes blocks,
  variables, lists, or comments. The expanded source is unchanged, but the
  generated SB3 might not be able to undo the coordinate changes.

Test scripts:
  --strip-tests removes every script under a test hat (kubohiroyatest_whentest,
  kubohiroyatest_whensetup) and the comments on its blocks from the generated SB3.
  Without it the test scripts are kept; the green flag does not start them.
  The two builds differ byte for byte. The expanded source is unchanged.

Project asset additions:
  --project-assets validates a JSON or YAML manifest and adds its sprites,
  backdrops, costumes, and sounds only to the generated SB3. Input files are confined to the
  manifest directory unless --allow-asset-root explicitly permits another root.

Extension digests:
  extensions digests reads each SB3's own manifest and reports every extension's ID,
  pinned SHA-256, source form (remote-non-cacheable, remote-cacheable, embedded-file,
  embedded-data), held byte size, and the project URI that names the cache bucket. Given
  several SB3s it also reports which digests more than one project names. Nothing is
  fetched and no browser storage is read: an extension cache belongs to an origin and a
  browser profile, so only the browser can list it, and an unresolved project URI never
  means an absent project.

Project extension updates:
  extensions list-sb3 lists every extension the SB3 uses with its form, SHA-256, version and
  source. A source is known only from the SB3's own extension lock for the same bytes;
  otherwise it is reported as unknown, never guessed from an ID or a name.
  extensions update-sb3 changes the version and/or the stored form (remote-non-cacheable,
  remote-cacheable, embedded-file, embedded-data) of the named extensions only. --version
  resolves latest (the current stable release) or an exact version from the recorded source
  or from --reference (npm-package@version|tag, a GitHub Release tag URL or repository URL).
  A form change keeps the same bytes and SHA-256. Each candidate's ID, API, the blocks the
  project uses, its execution mode and the address a reference form records are checked
  first; any error blocks the whole update and nothing is written. --dry-run shows the plan.
  The --allow-* options turn the matching errors into warnings; requesting a wider execution
  mode is not permission, which the host still asks for. The input is preserved; output must
  use a different path. Use --json for machine-readable plans and diagnostics.

Kamishibai SB3 replacement:
  extensions replace-sb3 replaces the runtime bundle and Block Script in INPUT.sb3.
  Omitting --from downloads the published block SB3 from the official samples site
  and verifies its size and SHA-256. --from uses a local donor without network access.
  The input is preserved; output must use a different path. Story data is not migrated.

Replacement safety:
  Differing outputs require interactive confirmation or --yes.
  Import refuses to discard uncommitted Git changes unless
  --discard-local-changes is also specified. --force is not supported.`;
}

function takeValue(arguments_: string[], index: number, option: string): string {
  const value = arguments_[index + 1];
  assert(value && !value.startsWith('-'), `${option} requires a value.`);
  return value;
}

function parseImportArguments(arguments_: string[]): ImportCliOptions {
  let inputPath: string | undefined;
  let outputDirectory: string | undefined;
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

function parseCleanUpArguments(arguments_: string[]): CleanUpCliOptions {
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  let yes = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--output') {
      assert(!outputPath, '--output may only be specified once.');
      outputPath = path.resolve(takeValue(arguments_, index, '--output'));
      index += 1;
    } else if (argument === '--yes') {
      yes = true;
    } else {
      assert(!argument.startsWith('-'), `Unknown option: ${argument}`);
      assert(!inputPath, 'Only one input SB3 may be specified.');
      inputPath = path.resolve(argument);
    }
  }
  assert(inputPath, 'The clean-up command requires INPUT.sb3.');
  assert(outputPath, 'The clean-up command requires --output OUTPUT.sb3.');
  return {command: 'clean-up', inputPath, outputPath, yes};
}

function parseCheckArguments(arguments_: string[]): CheckCliOptions {
  const allowedAssetRoots: string[] = [];
  let projectAssetsPath: string | undefined;
  let sourceDirectory: string | undefined;
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

function parseBuildArguments(arguments_: string[]): BuildCliOptions {
  const allowedAssetRoots: string[] = [];
  let cleanUpBlocks = false;
  let stripTests = false;
  let sourceDirectory: string | undefined;
  let outputPath: string | undefined;
  let projectAssetsPath: string | undefined;
  let yes = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--clean-up-blocks') {
      cleanUpBlocks = true;
    } else if (argument === '--strip-tests') {
      stripTests = true;
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
    ...(stripTests ? {stripTests} : {}),
    yes,
  };
}

function parseExtensionMutationArguments(
  action: 'sync' | 'update',
  arguments_: string[],
): ExtensionsMutationCliOptions {
  let allowBreakingApi = false;
  let apiManifestArtifact: string | undefined;
  let sourceDirectory: string | undefined;
  let extensionId: string | undefined;
  let migrateToId: string | undefined;
  let sourceArtifact: string | undefined;
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

function parseExtensionIdMigrationArguments(arguments_: string[]): ExtensionsMigrateIdCliOptions {
  let fromId: string | undefined;
  let sourceDirectory: string | undefined;
  let toId: string | undefined;
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

function parseExtensionBundleArguments(arguments_: string[]): ExtensionsBundleCliOptions {
  let bundleId: string | undefined;
  let bundleName: string | undefined;
  let metadata: ExtensionBundleMetadata | undefined;
  let recoveryCapsule = false;
  let sourceDirectory: string | undefined;
  const extensionIds: string[] = [];
  let yes = false;
  let buildMode: 'classic' | 'module' | undefined;
  let paletteGroups: 'single' | 'members' | undefined;
  let memberColors: 'bundle' | 'member' | undefined;
  let memberParentGroups: ExtensionBundleMemberParentGroup[] | undefined;
  const sharedDependencies: Record<string, string> = {};

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--id') {
      bundleId = takeValue(arguments_, index, '--id');
      index += 1;
    } else if (argument === '--name') {
      bundleName = takeValue(arguments_, index, '--name');
      index += 1;
    } else if (argument === '--metadata-json') {
      assert(metadata === undefined, '--metadata-json may only be specified once.');
      const value = takeValue(arguments_, index, '--metadata-json');
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error('--metadata-json must contain a JSON object.');
      }
      metadata = validateExtensionBundleMetadata(parsed);
      index += 1;
    } else if (argument === '--yes') {
      yes = true;
    } else if (argument === '--include-recovery-capsule') {
      recoveryCapsule = true;
    } else if (argument === '--build-mode') {
      const value = takeValue(arguments_, index, '--build-mode');
      assert(value === 'classic' || value === 'module', '--build-mode must be classic or module.');
      buildMode = value;
      index += 1;
    } else if (argument === '--palette-groups') {
      const value = takeValue(arguments_, index, '--palette-groups');
      assert(
        value === 'single' || value === 'members',
        '--palette-groups must be single or members.',
      );
      paletteGroups = value;
      index += 1;
    } else if (argument === '--member-colors') {
      const value = takeValue(arguments_, index, '--member-colors');
      assert(value === 'bundle' || value === 'member', '--member-colors must be bundle or member.');
      memberColors = value;
      index += 1;
    } else if (argument === '--member-parent-groups-json') {
      assert(
        memberParentGroups === undefined,
        '--member-parent-groups-json may only be specified once.',
      );
      const value = takeValue(arguments_, index, '--member-parent-groups-json');
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error('--member-parent-groups-json must contain a JSON array.');
      }
      assert(Array.isArray(parsed), '--member-parent-groups-json must contain a JSON array.');
      memberParentGroups = parsed as ExtensionBundleMemberParentGroup[];
      index += 1;
    } else if (argument === '--share') {
      const value = takeValue(arguments_, index, '--share');
      const separator = value.lastIndexOf('@');
      assert(separator > 0, '--share requires PACKAGE@EXACT_VERSION.');
      const name = value.slice(0, separator);
      assert(
        /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name),
        `Invalid shared dependency name: ${name}`,
      );
      assert(
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.slice(separator + 1)),
        '--share requires an exact semantic version.',
      );
      assert(!Object.hasOwn(sharedDependencies, name), `Duplicate shared dependency: ${name}`);
      sharedDependencies[name] = value.slice(separator + 1);
      index += 1;
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
  assert(
    !Object.keys(sharedDependencies).length || buildMode === 'module',
    '--share requires --build-mode module.',
  );
  return {
    action: 'bundle',
    bundleId,
    bundleName,
    ...(metadata === undefined ? {} : {metadata}),
    command: 'extensions',
    extensionIds,
    recoveryCapsule,
    sourceDirectory,
    yes,
    ...(buildMode === undefined ? {} : {buildMode}),
    ...(Object.keys(sharedDependencies).length ? {sharedDependencies} : {}),
    ...(paletteGroups === undefined ? {} : {paletteGroups}),
    ...(memberColors === undefined ? {} : {memberColors}),
    ...(memberParentGroups === undefined ? {} : {memberParentGroups}),
  };
}

function parseExtensionUnbundleArguments(
  arguments_: string[],
): ExtensionsUnbundleSourceCliOptions | ExtensionsUnbundleArchiveCliOptions {
  let bundleId: string | undefined;
  let input: string | undefined;
  let outputPath: string | undefined;
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

function parseExtensionDigestsArguments(arguments_: string[]): ExtensionsDigestsCliOptions {
  const inputPaths: string[] = [];
  let json = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--json') {
      json = true;
    } else {
      assert(!argument.startsWith('-'), `Unknown option: ${argument}`);
      inputPaths.push(path.resolve(argument));
    }
  }
  assert(inputPaths.length > 0, 'The extensions digests command requires at least one INPUT.sb3.');
  return {action: 'digests', command: 'extensions', inputPaths, json};
}

function parseExtensionReplaceSb3Arguments(arguments_: string[]): ExtensionsReplaceSb3CliOptions {
  let fromPath: string | undefined;
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  let yes = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--from') {
      assert(!fromPath, '--from may only be specified once.');
      fromPath = path.resolve(takeValue(arguments_, index, '--from'));
      index += 1;
    } else if (argument === '--output') {
      assert(!outputPath, '--output may only be specified once.');
      outputPath = path.resolve(takeValue(arguments_, index, '--output'));
      index += 1;
    } else if (argument === '--yes') {
      yes = true;
    } else {
      assert(!argument.startsWith('-'), `Unknown option: ${argument}`);
      assert(!inputPath, 'Only one input SB3 may be specified.');
      inputPath = path.resolve(argument);
    }
  }
  assert(inputPath, 'The extensions replace-sb3 command requires INPUT.sb3.');
  assert(outputPath, 'The extensions replace-sb3 command requires --output OUTPUT.sb3.');
  return {action: 'replace-sb3', command: 'extensions', fromPath, inputPath, outputPath, yes};
}

function parseExtensionListSb3Arguments(arguments_: string[]): ExtensionsListSb3CliOptions {
  let inputPath: string | undefined;
  let json = false;
  for (const argument of arguments_) {
    if (argument === '--json') json = true;
    else {
      assert(!argument.startsWith('-'), `Unknown option: ${argument}`);
      assert(!inputPath, 'Only one input SB3 may be specified.');
      inputPath = path.resolve(argument);
    }
  }
  assert(inputPath, 'The extensions list-sb3 command requires INPUT.sb3.');
  return {action: 'list-sb3', command: 'extensions', inputPath, json};
}

const saveFormats = ['remote-non-cacheable', 'remote-cacheable', 'embedded-file', 'embedded-data'];

function parseExtensionUpdateSb3Arguments(arguments_: string[]): ExtensionsUpdateSb3CliOptions {
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  let dryRun = false;
  let json = false;
  let yes = false;
  const flags: {allowPrerelease?: true; allowBreakingApi?: true; allowExecutionChange?: true} = {};
  const requests: Record<string, Record<string, unknown>> = {};
  const fields: Record<string, 'version' | 'format' | 'reference' | 'url'> = {
    '--version': 'version',
    '--format': 'format',
    '--reference': 'reference',
    '--url': 'url',
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const field = fields[argument];
    if (field) {
      const value = takeValue(arguments_, index, argument);
      index += 1;
      const split = value.indexOf('=');
      assert(split > 0 && split < value.length - 1, `${argument} expects ID=VALUE.`);
      const id = value.slice(0, split);
      const setting = value.slice(split + 1);
      if (field === 'format')
        assert(saveFormats.includes(setting), `--format must be one of ${saveFormats.join(', ')}.`);
      const request = (requests[id] ??= {});
      assert(request[field] === undefined, `${argument} may only be given once for ${id}.`);
      request[field] = setting;
    } else if (argument === '--output') {
      assert(!outputPath, '--output may only be specified once.');
      outputPath = path.resolve(takeValue(arguments_, index, '--output'));
      index += 1;
    } else if (argument === '--dry-run') dryRun = true;
    else if (argument === '--json') json = true;
    else if (argument === '--yes') yes = true;
    else if (argument === '--allow-prerelease') flags.allowPrerelease = true;
    else if (argument === '--allow-breaking-api') flags.allowBreakingApi = true;
    else if (argument === '--allow-execution-change') flags.allowExecutionChange = true;
    else {
      assert(!argument.startsWith('-'), `Unknown option: ${argument}`);
      assert(!inputPath, 'Only one input SB3 may be specified.');
      inputPath = path.resolve(argument);
    }
  }
  assert(inputPath, 'The extensions update-sb3 command requires INPUT.sb3.');
  assert(
    dryRun !== (outputPath !== undefined),
    'Specify exactly one of --output OUTPUT.sb3 or --dry-run.',
  );
  assert(
    Object.keys(requests).length > 0,
    'Name at least one extension with --version, --format, --reference or --url.',
  );
  const withFlags = Object.fromEntries(
    Object.entries(requests).map(([id, request]) => [
      id,
      {...request, ...flags} as ProjectExtensionRequest,
    ]),
  );
  return {
    action: 'update-sb3',
    command: 'extensions',
    inputPath,
    ...(outputPath ? {outputPath} : {}),
    requests: withFlags,
    json,
    yes,
  };
}

function formatProjectExtension(extension: ProjectExtension): string[] {
  const source =
    extension.source.kind === 'npm'
      ? `npm ${extension.source.package}@${extension.source.version}`
      : extension.source.kind === 'github'
        ? `github ${extension.source.repository}@${extension.source.tag}`
        : extension.source.kind;
  return [
    `${extension.id}\t${extension.format}\tversion=${extension.version ?? 'unknown'}\tsource=${source}\tsha256=${extension.sha256}`,
    ...extension.diagnostics.map((item) => `  ${item.severity} ${item.code}: ${item.message}`),
  ];
}

function formatProjectExtensionPlan(plan: ProjectExtensionPlan): string[] {
  return plan.steps.flatMap((step) => [
    `${step.id}\t${step.change}${step.blocked ? ' (blocked)' : ''}\t` +
      `${step.from.format} ${step.from.version ?? 'unknown'} -> ${step.to.format} ${step.to.version ?? 'unknown'}` +
      `\tsha256=${step.to.sha256}${step.to.url ? `\turl=${step.to.url}` : ''}`,
    ...step.diagnostics.map((item) => `  ${item.severity} ${item.code}: ${item.message}`),
  ]);
}

function parseExtensionsArguments(arguments_: string[]): ExtensionsCliOptions {
  const [action, ...actionArguments] = arguments_;
  assert(
    action === 'digests' ||
      action === 'replace-sb3' ||
      action === 'list-sb3' ||
      action === 'update-sb3' ||
      action === 'bundle' ||
      action === 'migrate-id' ||
      action === 'status' ||
      action === 'sync' ||
      action === 'unbundle' ||
      action === 'update',
    'The extensions command requires status, digests, sync, update, migrate-id, bundle, unbundle, replace-sb3, list-sb3, or update-sb3.',
  );
  if (action === 'list-sb3') return parseExtensionListSb3Arguments(actionArguments);
  if (action === 'update-sb3') return parseExtensionUpdateSb3Arguments(actionArguments);
  if (action === 'digests') return parseExtensionDigestsArguments(actionArguments);
  if (action === 'replace-sb3') return parseExtensionReplaceSb3Arguments(actionArguments);
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

export function parseCliArguments(arguments_: string[]): CliOptions {
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
  if (command === 'clean-up') return parseCleanUpArguments(commandArguments);
  if (command === 'extensions') return parseExtensionsArguments(commandArguments);
  if (command === 'test') {
    const [action, input, flag, ...extra] = commandArguments;
    if (action === 'run') return parseTestRunArguments(input, commandArguments.slice(2));
    assert(action === 'list', 'The test command supports list or run.');
    assert(
      input &&
        !input.startsWith('-') &&
        (flag === undefined || flag === '--json') &&
        extra.length === 0,
      'Usage: sb3-toolchain test list INPUT.sb3|SOURCE_DIR [--json]',
    );
    return {command: 'test', action, inputPath: path.resolve(input), json: flag === '--json'};
  }
  throw new Error(`Unknown command: ${command}`);
}

function formatDifferenceLines(differences: DirectoryDifferences): string {
  const labels: Record<string, string> = {added: '+', modified: '~', removed: '-'};
  const lines = Object.entries(differences).flatMap(([kind, paths]) =>
    paths.map((relativePath: string) => `${labels[kind]} ${relativePath}`),
  );
  const visibleLines = lines.slice(0, 12);
  if (lines.length > visibleLines.length) {
    visibleLines.push(`... and ${lines.length - visibleLines.length} more`);
  }
  return visibleLines.join('\n');
}

async function confirmImportReplacement(context: OutputReplacementContext): Promise<boolean> {
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

async function confirmBuildReplacement(outputPath: string): Promise<boolean> {
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

async function confirmExtensionReplacement({
  comparison,
  sourceDirectory,
}: ExtensionSyncConfirmContext): Promise<boolean> {
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

function logMigrationResult(result: MigrationLogResult, log: (message: string) => void): void {
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
  arguments_: string[],
  {fetch: fetchImplementation = globalThis.fetch, log = console.log}: RunCliOptions = {},
): Promise<void> {
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
      stripTests: options.stripTests,
      yes: options.yes,
    });
    const action = result.changed ? 'Built' : 'Already up to date';
    const cleanUpMessage = result.blockCleanUp
      ? `, ${result.blockCleanUp.movedScriptCount}/${result.blockCleanUp.scriptCount} scripts laid out`
      : '';
    const testStripMessage = result.testStrip
      ? `, ${result.testStrip.removedScriptCount} test scripts stripped`
      : '';
    log(
      `${action}: ${result.outputPath} (${result.entryCount} entries, ` +
        `${result.assetCount} assets, ${result.embeddedExtensionCount} embedded extensions` +
        `${cleanUpMessage}${testStripMessage}).`,
    );
    if (result.rollbackCleanupWarning) log(result.rollbackCleanupWarning);
    return;
  }
  if (options.command === 'clean-up') {
    const result = await cleanUpSb3({
      ...options,
      confirmReplace: confirmBuildReplacement,
    });
    log(
      `${result.changed ? 'Wrote' : 'Already up to date'}: ${result.outputPath} ` +
        `(${result.movedScriptCount}/${result.scriptCount} scripts moved across ${result.targetCount} targets).`,
    );
    if (result.rollbackCleanupWarning) log(result.rollbackCleanupWarning);
    return;
  }
  if (options.command === 'test') {
    if (options.action === 'run') {
      const report = await runProjectTests(
        options.inputPath,
        options.editorDirectory,
        options.revision,
        options.only.length ? options.only : undefined,
        options.allowed,
      );
      const xml = toJUnitXml(report);
      if (options.outputPath) await writeFile(options.outputPath, xml, {flag: 'wx'});
      else log(xml.trimEnd());
      assert(report.ok, 'One or more project tests did not pass.');
      return;
    }
    const discovery = await listProjectTests(options.inputPath);
    if (options.json) {
      log(JSON.stringify(discovery, null, 2));
    } else {
      for (const item of discovery.tests)
        log(`${JSON.stringify(item.address)}	${JSON.stringify(item.name)}`);
    }
    return;
  }
  if (options.command === 'extensions') {
    if (options.action === 'digests') {
      const inventory = await inventoryExtensionDigests(options.inputPaths);
      if (options.json) {
        log(`${JSON.stringify(inventory, null, 2)}`);
        return;
      }
      for (const line of formatExtensionDigestInventory(inventory)) log(line);
      return;
    }
    if (options.action === 'list-sb3') {
      const extensions = await listSb3Extensions(options.inputPath);
      if (options.json) log(JSON.stringify({extensions}, null, 2));
      else
        for (const extension of extensions)
          for (const line of formatProjectExtension(extension)) log(line);
      return;
    }
    if (options.action === 'update-sb3') {
      const result = await updateSb3Extensions({
        inputPath: options.inputPath,
        outputPath: options.outputPath,
        requests: options.requests,
        fetch: fetchImplementation,
        confirmReplace: confirmBuildReplacement,
        yes: options.yes,
      });
      if (options.json) log(JSON.stringify(result, null, 2));
      else {
        for (const line of formatProjectExtensionPlan(result.plan)) log(line);
        if (result.written)
          log(
            `${result.written.changed ? 'Wrote' : 'Already up to date'}: ${result.written.outputPath}.`,
          );
        else if (!result.plan.blocked) log('Dry run: nothing was written.');
      }
      assert(!result.plan.blocked, 'The update is blocked; nothing was written.');
      return;
    }
    if (options.action === 'replace-sb3') {
      const result = await replaceSb3Extensions({
        confirmReplace: confirmBuildReplacement,
        fetch: fetchImplementation,
        fromPath: options.fromPath,
        inputPath: options.inputPath,
        outputPath: options.outputPath,
        yes: options.yes,
      });
      log(
        `${result.changed ? 'Wrote' : 'Already up to date'}: ${result.outputPath} (${result.extensionIds.join(', ')}).`,
      );
      log(
        `Donor: ${result.donor.source}; version=${result.donor.version ?? 'unknown'}; sha256=${result.donor.sha256}`,
      );
      if (result.rollbackCleanupWarning) log(result.rollbackCleanupWarning);
      return;
    }
    if (options.action === 'bundle') {
      const result = await bundleExtensions({
        bundleId: options.bundleId,
        bundleName: options.bundleName,
        metadata: options.metadata,
        extensionIds: options.extensionIds,
        recoveryCapsule: options.recoveryCapsule,
        buildMode: options.buildMode,
        sharedDependencies: options.sharedDependencies,
        paletteGroups: options.paletteGroups,
        memberColors: options.memberColors,
        memberParentGroups: options.memberParentGroups,
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
        if ('package' in status) {
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
  for (const warning of result.warnings) log(`Warning: ${warning.message}`);
  if (result.rollbackCleanupWarning) log(result.rollbackCleanupWarning);
}
