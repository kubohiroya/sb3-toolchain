# sb3-toolchain

A Node.js toolchain for managing Scratch 3 and TurboWarp `.sb3` projects as Git-diffable
expanded sources and rebuilding bit-for-bit identical SB3 files from the same input.

## Features

- Safely expand an SB3 into formatted `project.source.json`, assets, and embedded extensions
- Validate asset references, MD5 hashes, ZIP entries, and embedded extension mappings
- Record commits and SHA-256 hashes for GitHub-hosted embedded extensions and verify them offline
- Optionally compare versioned extension API manifests before replacing embedded JavaScript
- Statically bundle multiple extensions into one permission unit without deleting their original
  JavaScript, then restore them from either the expanded source or the bundled SB3
- Produce deterministic builds with fixed ZIP entry order, timestamps, and compression settings
- Protect uncommitted Git changes when importing
- Protect existing output through transactional replacement and rollback
- Provide both a CLI and a JavaScript API

TMPose kamishibai script conversion, project-specific data, and web application generation with
TurboWarp Packager are outside the scope of this package.

## Requirements

- Node.js 22.12.0 or later
- pnpm 11

## Installation

Pin the verified npm version for reproducible installation.

```bash
pnpm add --save-dev --save-exact @kubohiroya/sb3-toolchain@0.2.0
```

## Quick start

Expand an SB3 saved by TurboWarp, validate it, and rebuild it.

```bash
sb3-toolchain import tmp/project.sb3 --output app
sb3-toolchain check app
sb3-toolchain build app --output dist/project.sb3
```

See [`docs/workflows.md`](docs/workflows.md) for the recommended source-of-truth, re-import,
replacement protection, extension update, and CI workflows for a project repository.

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
});

const {archive} = await createDeterministicSb3('app');

const integrity = extensionIntegrity(await readFile('app/extensions/example.js'));

const statuses = await extensionStatus('app');
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

## Documentation

- [`docs/workflows.md`](docs/workflows.md): SB3 source and extension management workflows
- [`docs/source-format-v1.md`](docs/source-format-v1.md): expanded source format and deterministic output
- [`docs/extension-id-migration.md`](docs/extension-id-migration.md): migration of extension IDs already used by a project
- [`docs/extension-api-compatibility.md`](docs/extension-api-compatibility.md) ([日本語](docs/ja/extension-api-compatibility.md)): opt-in static API compatibility checks for extension updates
- [`docs/extension-bundles.md`](docs/extension-bundles.md): static bundling into one permission unit and reversible unbundling

## Development

```bash
pnpm install
pnpm check
```

## License

[Mozilla Public License 2.0](LICENSE)

This implementation extracts the general SB3 source-management mechanism developed for
[`kubohiroya/tmpose-kamishibai`](https://github.com/kubohiroya/tmpose-kamishibai) from its
project- and TMPose-specific processing.
