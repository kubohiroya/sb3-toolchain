# SB3 source-management workflows

[日本語版](ja/workflows.md)

This document describes the common workflow for managing a Scratch 3 or TurboWarp SB3 as expanded
source in Git and rebuilding a validated SB3. Each project repository should define its own editing,
testing, and distribution procedures.

See [`source-format-v1.md`](source-format-v1.md) for the expanded directory layout and file formats.

## Principles

- Treat the expanded directory in Git as the source of truth and generated SB3 files as build artifacts
- Import an SB3 edited in the TurboWarp Editor only after reviewing its differences
- Run `check` before committing and before distribution
- Build in CI and release workflows from a pinned toolchain version and committed expanded source
- Reproduce managed embedded extensions from a pinned source commit and SHA-256

The examples below use `app/` for the expanded source, `tmp/edited.sb3` for an SB3 saved by the
editor, and `dist/project.sb3` for generated output. Choose project-specific paths as needed.

## Initial import

Expand an SB3 saved by TurboWarp into files suitable for Git.

```bash
sb3-toolchain import tmp/edited.sb3 --output app
sb3-toolchain check app
git status --short
```

After import, verify at least the following:

- Changes in `project.source.json` correspond to operations performed in the editor
- Only intended assets were added to or removed from `assets/`
- `extensions/` and `embedded-extensions.json` contain no unexpected changes
- `sb3-toolchain check app` succeeds

A new import does not infer where embedded JavaScript came from. Add the provenance metadata described
below when an extension hosted on GitHub should become managed.

## Re-import into existing source

After editing the project, import the saved SB3 into the existing expanded source directory.

```bash
git status --short
sb3-toolchain import tmp/edited.sb3 --output app
sb3-toolchain check app
git diff -- app
```

The tool asks for replacement confirmation when the existing expanded source differs. In a
non-interactive environment, `--yes` skips that confirmation but does not discard uncommitted
Git-managed changes. Specify both options only after reviewing the changes that will be discarded.

```bash
sb3-toolchain import tmp/edited.sb3 --output app \
  --yes \
  --discard-local-changes
```

`--discard-local-changes` is not a recovery mechanism. Commit or otherwise preserve required changes
before using it. There is no `--force` option.

Provenance metadata for a managed extension with the same ID and path is preserved during re-import.
If the JavaScript in the SB3 differs from the recorded ID or SHA-256, the import is rejected without
changing the existing output, preventing provenance from becoming inconsistent with the actual file.

## Validation and build

Use `check` to validate only the expanded source and `build` to generate an SB3.

```bash
sb3-toolchain check app
sb3-toolchain build app --output dist/project.sb3
```

`check` and `build` do not access the network. They validate asset references, MD5 hashes, the
expanded format, embedded extension IDs, and SHA-256 hashes using only local inputs.

`build` fixes the ZIP entry order, timestamps, and compression settings. The same toolchain version
and expanded source produce a bit-for-bit identical SB3. An identical existing output is left
untouched. A differing output requires replacement confirmation or `--yes`.

To arrange the top-level scripts in every target before writing the generated SB3, opt in explicitly:

```bash
sb3-toolchain build app --output dist/project.sb3 --clean-up-blocks
```

`--clean-up-blocks` uses TurboWarp's cleaned-layout starting coordinates, column grouping tolerance,
and spacing. It preserves blocks, variables, lists, and comments; attached comments move with their
scripts. Only the generated `project.json` is transformed, so the expanded source remains unchanged.
TurboWarp might not be able to undo these coordinate changes after opening the generated SB3. Omit
the option and rebuild to roll back to the source coordinates.

In addition to project-specific tests, open the generated SB3 in TurboWarp and verify startup, primary
operations, images, sounds, and embedded extension behavior.

## Managed embedded extensions

The `source` object in `embedded-extensions.json` can record either GitHub commit provenance or an
exact installed npm package version, together with its artifact path and SHA-256. It can also opt in
to a versioned API manifest for static update compatibility checks. See
[`source-format-v1.md`](source-format-v1.md) for the complete schema.

The extension commands have the following roles:

| Command                 | Network | Resolve ref | Metadata update | Purpose                                     |
| ----------------------- | ------- | ----------- | --------------- | ------------------------------------------- |
| `extensions status`     | GitHub  | GitHub      | No              | Check the upstream or installed package     |
| `extensions sync`       | GitHub  | No          | No              | Restore files from the declared source      |
| `extensions update`     | GitHub  | GitHub      | Yes             | Adopt the upstream or installed package     |
| `extensions migrate-id` | No      | No          | IDs/references  | Migrate an extension ID used by the project |
| `extensions bundle`     | No      | No          | Bundle config   | Combine extensions into one permission unit |
| `extensions unbundle`   | No      | No          | Config or SB3   | Restore output with individual extensions   |

### Check for updates

```bash
sb3-toolchain extensions status app
```

`status` does not change local files. GitHub sources compare the tracked ref with `resolvedCommit`.
npm sources compare the declared exact version with the installed package without network access.

### Restore from a pinned commit

```bash
sb3-toolchain extensions sync app
sb3-toolchain check app
```

`sync` does not resolve a mutable branch or tag. GitHub sources download from `resolvedCommit`; npm
sources read from the exact package installed in the nearest ancestor `node_modules`. It replaces
local files only when JavaScript and an optional API manifest match recorded IDs and SHA-256 values.

### Update a tracked ref

```bash
sb3-toolchain extensions update app
sb3-toolchain extensions update app EXTENSION_ID
sb3-toolchain check app
git diff -- app
```

Omitting the ID updates all managed extensions as one transaction. If any download or validation
fails, neither files nor metadata are changed.

For an npm source, first use the project package manager to install a new exact dependency version,
then run `extensions status` and `extensions update`. The update copies the installed artifacts and
records their package `version` and integrity. It never queries the npm registry itself.

When `source.apiManifest` is present, the update downloads JavaScript and the API manifest from the
same resolved commit. Compatible additions are reported. A removed block, changed block type,
argument-contract change, removed referenced menu, or `acceptReporters` change is rejected before
installation. Removing an unreferenced menu is compatible. After reviewing every reported path, an
intentionally breaking update requires both flags:

```bash
sb3-toolchain extensions update app EXTENSION_ID --allow-breaking-api --yes
```

See [`extension-api-compatibility.md`](extension-api-compatibility.md) for the versioned manifest
contract, classification table, default-off behavior, and rollback.

In an update PR, review `resolvedCommit` or npm `version`, JavaScript and manifest integrity,
compatibility paths, and both artifacts together, then test the extension's primary features in the
generated SB3.

## Migrate an extension ID

An extension ID is stored in opcodes and monitors, so do not change only its filename or manifest by
hand. Start with a dry run and inspect both classified and unclassified references.

```bash
sb3-toolchain extensions migrate-id app --from OLD_ID --to NEW_ID
```

Prepare JavaScript declaring the new ID, review the result, and then apply it.

```bash
sb3-toolchain extensions migrate-id app --from OLD_ID --to NEW_ID --yes
sb3-toolchain check app
git diff -- app
```

For a GitHub-managed extension, the upstream artifact update and ID migration can be one transaction.

```bash
sb3-toolchain extensions update app OLD_ID \
  --migrate-id NEW_ID \
  --artifact dist/NEW_ID.js
```

Specify `--artifact` only when the upstream artifact path also changed. See
[`extension-id-migration.md`](extension-id-migration.md) for the affected schema, collision checks,
unclassified references, and rollback details.

## Combine unsandboxed permission into one prompt

A project containing several embedded extensions can opt in to a static bundle. Original JavaScript,
IDs, opcodes, and provenance remain unchanged; only build output is transformed into one composite
extension.

```bash
sb3-toolchain extensions bundle app \
  --id projectbundle \
  --name "Project Extension Bundle" \
  extensionone extensiontwo
sb3-toolchain extensions bundle app \
  --id projectbundle \
  --name "Project Extension Bundle" \
  extensionone extensiontwo \
  --yes
sb3-toolchain check app
sb3-toolchain build app --output dist/project.sb3 --yes
```

Use project-level automated tests and a real TurboWarp smoke test to verify equivalent behavior before
and after bundling, a single permission prompt, and successful reload after saving. If there is a
problem, restore the preserved individual extensions.

```bash
sb3-toolchain extensions unbundle app projectbundle
sb3-toolchain extensions unbundle app projectbundle --yes
sb3-toolchain check app
sb3-toolchain build app --output dist/project.sb3 --yes
```

An SB3 generated by this version of the toolchain can also be unbundled directly when the expanded
source is unavailable. The first command is a dry run; output is written only with `--yes`.

```bash
sb3-toolchain extensions unbundle \
  dist/project.sb3 projectbundle \
  --output dist/project.unbundled.sb3
sb3-toolchain extensions unbundle \
  dist/project.sb3 projectbundle \
  --output dist/project.unbundled.sb3 \
  --yes
```

See [`extension-bundles.md`](extension-bundles.md) for the compatibility contract, source comments,
opcode and storage transformations, direct-unbundle limitations, and re-import precautions.

## CI and distribution

Pin dependency versions and run at least the following in CI:

```bash
sb3-toolchain check app
sb3-toolchain build app --output dist/project.sb3 --yes
```

Distribute only an SB3 that passed project-level automated tests and manual verification. Do not
implicitly run `sync` or `update` as part of a release build because that would make network state an
input. Perform updates as separate, reviewable changes and commit the pinned expanded source first.

## Handling failures

- If a command refuses replacement, inspect `git status` and the relevant differences before retrying
- If `.<output-name>.rollback-*` remains, compare it with the current output before deciding what to restore or remove
- After a partial extension update failure, inspect `git diff` before retrying
- Roll back a merged change by reverting the project commit so source, artifacts, and provenance return together
- When replacing a published SB3, follow the project's release policy and preserve history

Do not destroy Git history as a recovery shortcut. Keep the cause and affected scope inspectable.
