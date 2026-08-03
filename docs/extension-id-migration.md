# Migrating embedded extension IDs

TurboWarp stores the IDs of loaded extensions in project opcodes and monitors. `extensions migrate-id`
does not perform a global string replacement. It changes only references whose meaning is defined by
SB3 source format v1.

## Dry run and apply

The standalone migration command is a dry run by default.

```bash
sb3-toolchain extensions migrate-id app --from twOld --to newext
```

Review the classified change counts and `Unclassified` references. Before applying the migration,
place a JavaScript artifact that declares the new ID at `extensions/twOld.js`.

```bash
sb3-toolchain extensions migrate-id app --from twOld --to newext --yes
```

The new ID must use TurboWarp's official `[a-z0-9]+` format. The migration is rejected as a collision
if the new ID already exists in the manifest, `extensionURLs`, or `project.extensions`.

## Classified references

The tool changes the following references:

- Exact IDs in `project.source.json` `extensions[]`
- Exact `extensionURLs` keys and embedded-extension values
- Exact `<oldId>_` prefixes in `targets[*].blocks[*].opcode`
- Menu block opcodes, which use the ordinary block schema
- Exact `<oldId>_` prefixes in `monitors[*].opcode`
- `id` and `path` in `embedded-extensions.json`
- The filename from `extensions/<oldId>.js` to `extensions/<newId>.js`

Strings containing the old ID in variable names, list names, block literals, metadata, or another
extension's opcode are not changed. They appear in the dry-run output as unclassified references
with JSON Pointers so that a person can determine their meaning.

## GitHub-managed extensions

For a managed extension, the recommended workflow combines the update and migration after the
upstream repository publishes an artifact declaring the new ID.

```bash
sb3-toolchain extensions update app twOld \
  --migrate-id newext \
  --artifact dist/newext.js
```

Specify `--artifact` only when the upstream artifact path also changed. The tool resolves the tracked
ref to an immutable commit and downloads the new artifact from that commit. It rejects an artifact
that does not declare `// ID: newext`, a collision, or an invalid new ID before changing local files.

## Validation and rollback

The tool completes normal source validation and a deterministic candidate SB3 build before replacing
the expanded source directory transactionally. It restores the original directory automatically if
replacement fails. To roll back after merge, revert the project migration commit so that the old ID,
artifact, and provenance return together.
