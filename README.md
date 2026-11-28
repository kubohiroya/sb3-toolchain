# sb3-toolchain

English | [日本語](README.ja.md)

A Node.js toolchain for managing Scratch 3 and TurboWarp `.sb3` projects as Git-diffable
expanded sources and rebuilding bit-for-bit identical SB3 files from the same input.

## Features

- Safely expand an SB3 into formatted `project.source.json`, assets, and embedded extensions
- Validate asset references, MD5 hashes, ZIP entries, and embedded extension mappings
- Manage embedded extensions from pinned GitHub commits or exact installed npm package versions and
  verify their SHA-256 hashes offline
- Optionally compare versioned extension API manifests before replacing embedded JavaScript
- Change the version (latest stable, exact, or older) and stored form of any extension an SB3
  uses with `extensions update-sb3`, after checking its ID, API, execution mode and address
- Statically bundle multiple extensions into one permission unit without deleting their original
  JavaScript, then restore them from either the expanded source or the bundled SB3
- Report every extension's pinned SHA-256, retention form, held size, and the project URI, and
  which digests several projects share, without reading browser storage or fetching anything
- Produce deterministic builds with fixed ZIP entry order, timestamps, and compression settings
- Add sprites, backdrops, costumes, and sounds from an optional JSON or YAML build manifest without
  modifying the expanded base source
- Optionally lay out every target's scripts in a deterministic TurboWarp-style cleaned arrangement
- Rearrange scripts in an existing SB3 and save a separate copy with `clean-up`
- Protect uncommitted Git changes when importing
- Protect existing output through transactional replacement and rollback
- Provide both a CLI and a JavaScript API

## Requirements

- Node.js 24 or later
- pnpm 11

## Installation

Pin the verified npm version for reproducible installation.

```bash
pnpm add --save-dev --save-exact @kubohiroya/sb3-toolchain@0.33.0
```

## Quick start

Expand an SB3 saved by TurboWarp, validate it, and rebuild it.

```bash
sb3-toolchain import tmp/project.sb3 --output app
sb3-toolchain check app
sb3-toolchain build app --output dist/project.sb3
```

Update a Kamishibai SB3's runtime bundle and Block Script together. Omitting `--from`
downloads and verifies the published block SB3 from the official samples site.

```bash
sb3-toolchain extensions replace-sb3 input.sb3 --output updated.sb3
```

See the [replacement guide (Japanese)](docs/ja/sb3-extension-replacement.md) for local donors,
preserved story data, validation, and limits.

List what the SB3s on hand say about their extensions, to compare a browser's extension cache
against. Nothing is fetched, and no browser storage is read.

```bash
sb3-toolchain extensions digests one.sb3 two.sb3
```

See [`docs/workflows.md`](docs/workflows.md) for the recommended source-of-truth, re-import,
replacement protection, extension update, and CI workflows for a project repository.

### Discover tests included in a project

`sb3-toolchain test list app --json` and `sb3-toolchain test list project.sb3 --json`
list the same test hats by target and block ID. Without `--json`, each line shows the
address and display name as quoted text. Discovery never loads extensions or runs a
VM. To make a distribution without the test and setup scripts, add `--strip-tests` to
`build`; the default keeps them.

### Run project tests in a pinned local Editor

Install Chromium for the matching Playwright Core version
(`npx playwright-core@1.64.1 install chromium`), then provide a trusted local
TurboWarp Plus Editor build and its full site revision:

```bash
sb3-toolchain test run project.sb3 --editor-dir /path/to/build \
  --editor-revision FULL_SITE_SHA --test Stage/BLOCK_ID --reporter junit --out results.xml
```

Omit `--test` to run all cases; repeat it to select several. The command runs offline
in the actual Editor test frame. Only the pinned, embedded TurboWarp Test extension
(`7f6541ce…`, at `extensions/turbowarp-test.js`) is supported. Archives with legacy,
remote, additional or differently hashed extensions are rejected before launching the
browser unless you explicitly grant an extra, dependency-free sandboxed embedded file
with `--allow-sandboxed ID=SHA256`. Use the digest of trusted local build output, not
a value asserted by an unknown archive. These grants require an Editor build that
reports the exact loaded build digests. The matching revision is an identity check
on local build metadata, not cryptographic authentication; only supply a trusted
Editor build. JUnit goes to standard output by default or to a new file
with `--out`. Failed assertions, errors and timeouts exit nonzero.

## JavaScript API

```js
import {readFile} from 'node:fs/promises';

import {
  buildSb3,
  bundleExtensions,
  createDeterministicSb3,
  extensionIntegrity,
  extensionStatus,
  importSb3,
  inventoryExtensionDigests,
  migrateExtensionId,
  planExtensionIdMigration,
  syncExtensions,
  unbundleSb3,
  unbundleExtensions,
  updateExtensions,
  validateSb3Source,
} from '@kubohiroya/sb3-toolchain';

await importSb3({
  inputPath: 'tmp/project.sb3',
  outputDirectory: 'app',
});

await validateSb3Source('app');

await buildSb3({
  sourceDirectory: 'app',
  outputPath: 'dist/project.sb3',
  // Opt in to cleaned block coordinates in the generated SB3 only:
  cleanUpBlocks: true,
});

const {archive} = await createDeterministicSb3('app', {cleanUpBlocks: true});

const integrity = extensionIntegrity(await readFile('app/extensions/example.js'));

const statuses = await extensionStatus('app');
// Read-only: no URL in an SB3 is contacted and no browser storage is read.
const inventory = await inventoryExtensionDigests(['dist/project.sb3']);
const migration = await planExtensionIdMigration({
  sourceDirectory: 'app',
  fromId: 'oldId',
  toId: 'newid',
});
await migrateExtensionId({
  sourceDirectory: 'app',
  fromId: 'oldId',
  toId: 'newid',
  yes: true,
});
await syncExtensions({sourceDirectory: 'app', yes: true});
await updateExtensions({
  sourceDirectory: 'app',
  extensionId: 'oldId',
  migrateToId: 'newid',
  sourceArtifact: 'dist/newid.js',
  apiManifestArtifact: 'dist/newid.manifest.json',
  yes: true,
});
// After reviewing a reported breaking API change, opt in explicitly:
await updateExtensions({sourceDirectory: 'app', allowBreakingApi: true, yes: true});
await bundleExtensions({
  sourceDirectory: 'app',
  bundleId: 'projectbundle',
  bundleName: 'Project Extension Bundle',
  extensionIds: ['extensionone', 'extensiontwo'],
  yes: true,
});
// Opt in to one dependency graph when every member provides a pinned source.module entry:
// await bundleExtensions({...options, buildMode: 'module', sharedDependencies: {yaml: '2.9.1'}});
await unbundleExtensions({
  sourceDirectory: 'app',
  bundleId: 'projectbundle',
  yes: true,
});
await unbundleSb3({
  inputPath: 'dist/project.sb3',
  outputPath: 'dist/project.unbundled.sb3',
  bundleId: 'projectbundle',
  yes: true,
});
```

### Change the version and stored form of a project's extensions

`@kubohiroya/sb3-toolchain/project-extensions` is the shared core behind
`extensions list-sb3 / update-sb3` and the Editor's project properties. It runs in a browser and in
Node, takes an unpacked archive and a parsed `project.json`, and never touches files, a VM or an
approval.

```js
import {
  applyProjectExtensionUpdate,
  listProjectExtensions,
  planProjectExtensionUpdate,
} from '@kubohiroya/sb3-toolchain/project-extensions';

const extensions = await listProjectExtensions(archive, project);
const plan = await planProjectExtensionUpdate(archive, project, {
  myextension: {version: 'latest', format: 'remote-cacheable'},
});
if (!plan.blocked) {
  const result = await applyProjectExtensionUpdate(archive, project, plan); // new archive and project
}
```

- A source is known only from the SB3's own extension lock (`tw-plus/extension-locks.json`) for the
  same bytes, or from a `reference` the caller names. Otherwise it is `unknown`; an ID, a name or a
  URL never identifies a package, and no extension JavaScript is evaluated.
- `latest` is the current stable release. A prerelease that `latest` or a tag resolves to blocks the
  step unless `allowPrerelease` is set; an exact prerelease is an explicit request.
- Every candidate is checked first: its ID, its API against the locked one, the blocks the project
  uses, a wider execution mode, and that the address a reference form records serves the same
  bytes. Errors block the step; `allow*` options turn them into warnings. Requesting unsandboxed
  execution is not permission: the host still asks for the new digest.
- A form change keeps the same bytes and SHA-256, using
  `@kubohiroya/turbowarp-sb3-save-format/extension-format`. A new version replaces the code and
  its lock and records the exact version, address and SHA-256.
- Applying refuses a blocked plan, a plan for input that changed since, and a plan not made in this
  process. Nothing changes the input, and one failing extension applies none.

### Create a project folder in a browser

`unpackSb3(bytes)` from `@kubohiroya/sb3-toolchain/browser` expands SB3 bytes into a project folder represented by a `Map<string, Uint8Array>` and a list of warnings. The folder uses source format 1. The TurboWarp Plus Editor screen state (the ZIP entry `tw-plus/workspace.json`) becomes `.tw-plus/workspace.json`. Use `validateSourceFiles(files)` to check the resulting files again. Both functions run without Node.js built-ins or filesystem access.

The block palette functions of the same entry (`resolveBlockPaletteReferences`, `applyBlockPaletteComments`, `extractBlockPalette`, `hasBlockPaletteSettings`) remain for folders in [source format v2](docs/source-format-v2.md), which is no longer written.

The browser API reports and omits unreferenced assets with hash-based filenames and directory entries. It rejects Plus extension manifests and unsupported attachments with the `Sb3SourceError` code `unsupported-project`. Validation checks image, sound and font references and bytes, and the layout of embedded extensions. Use the CLI `check` and `build` commands for bundle builds and full managed-extension validation.

## Documentation

- [External extension resolution, standard builds and artifact locks (Japanese)](docs/ja/external-extension-resolution.md)

- [`docs/workflows.md`](docs/workflows.md): SB3 source and extension management workflows
- [`docs/source-format-v1.md`](docs/source-format-v1.md): expanded source format and deterministic output
- [`docs/source-format-v2.md`](docs/source-format-v2.md): format v2, which added block palette settings (read, no longer written)
- [`docs/project-asset-additions.md`](docs/project-asset-additions.md): JSON/YAML `--project-assets`, backdrops, and editable or strict locks
- [`docs/extension-id-migration.md`](docs/extension-id-migration.md): migration of extension IDs already used by a project
- [`docs/extension-api-compatibility.md`](docs/extension-api-compatibility.md) ([日本語](docs/ja/extension-api-compatibility.md)): opt-in static API compatibility checks for extension updates
- [`docs/extension-bundles.md`](docs/extension-bundles.md): static bundling, opt-in module builds with shared dependencies, and reversible unbundling
- [`docs/extension-digests.md`](docs/extension-digests.md) ([日本語](docs/ja/extension-digests.md)): extension digests, the four retention forms, project URIs, and shared digests

## Development

The source is TypeScript, built with Vite in library mode and tested with Vitest. `pnpm run check`
runs lint, format, typecheck, tests, build, repository policy, and pack checks in that order.

```bash
npm install --global corepack@latest
corepack enable
pnpm install --frozen-lockfile
pnpm run check
```

Individual steps:

```bash
pnpm run typecheck
pnpm run test
pnpm run test:watch
pnpm run build
```

`pnpm run build` emits `dist/` (ESM plus `.d.ts` declarations and source maps). The library entry
and the `sb3-toolchain` executable are both built from `src/`, so run a build before using the CLI
from a checkout.

## License

SPDX-License-Identifier: MPL-2.0

This implementation extracts the general SB3 source-management mechanism developed for
[`kubohiroya/tm-kamishibai`](https://github.com/kubohiroya/tm-kamishibai) from the
TurboWarp TM application layer.
