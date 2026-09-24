# Changelog

## 0.14.0 - 2026-09-24

- Accept extension API manifest format version 2, which carries the metadata a server-side compiler
  needs to lower a block: `resultType`, `effect`, `immutable`, `errors` and `server` per block, and
  `normalizesTo`, `staticLiteral`, `minimum` and `maximum` per argument. Four published extensions
  already emit such manifests and every one of them was rejected outright, so no project could
  manage them with API compatibility checking.
- Require all five block metadata fields together at version 2, and reject version 2 metadata in a
  version 1 manifest. The `effect` and `resultType` vocabularies match
  `@kubohiroya/turbowarp-extension-manifest` and the compiler manifest reader in
  `turbowarp-http-server`, so a manifest this toolchain accepts is one that reader can parse.
- Report version 2 metadata in `compareExtensionApiManifests`: `block-resultType-changed`,
  `block-effect-changed`, `block-immutable-changed`, `block-error-added`, `block-error-removed`,
  `block-server-supported-changed`, `block-server-ir-operation-changed` and
  `format-version-changed`. Changes are breaking in both directions except a block gaining server
  support, a block declaring a new error code, and a rise from version 1 to version 2.
- Add `state` to the `effect` vocabulary, for a block that mutates extension-held data scoped to a
  target, and accept the optional extension-level `pathSegmentType` and `dataReferenceType` at
  version 2. `turbowarp-structured-data` had put all three in a format version 3 of its own; with
  these in place its manifest fits in version 2, so no reader needs a higher ceiling.
- Export `extensionApiManifestFormatVersions`, `extensionApiManifestResultTypes` and
  `extensionApiManifestEffects`, plus the `ExtensionApiManifestServer`,
  `ExtensionApiManifestFormatVersion`, `ExtensionApiManifestResultType` and
  `ExtensionApiManifestEffect` types. `extensionApiManifestFormatVersion` still reads `1` and is now
  the default rather than the only accepted version.

Rollback: pin `@kubohiroya/sb3-toolchain@0.13.0`. A version 1 manifest parses and compares exactly as
before, so a project with no version 2 extension is unaffected either way.

## 0.13.0 - 2026-09-14

- Add `tryParseExtensionApiManifest`, which returns `{manifest, error}` instead of throwing.
  `parseExtensionApiManifest` aborts on the first problem, so a caller auditing several published
  manifests could only report one failure per run; the new entry point lets it collect every
  failure and report them together.
- Export `ExtensionApiManifestParseResult` and its `ExtensionApiManifestParseSuccess` /
  `ExtensionApiManifestParseFailure` members from the package entry point.

Rollback: pin `@kubohiroya/sb3-toolchain@0.12.0`.

## 0.12.0 - 2026-09-10

- Ignore `.claude/**` in the ESLint config: flat config does not read `.gitignore`, so `eslint .`
  was linting nested worktree checkouts of this repository and reporting their release snapshot
  helpers as 47 errors.
- Re-release the 0.11.0 TypeScript migration. npm 0.11.0 was published from a stale base and shipped
  a narrower, scripts-only migration instead of this one.

Rollback: pin `@kubohiroya/sb3-toolchain@0.10.0`.

## 0.11.0 - 2026-09-05

- Migrate the source, tests, and build to TypeScript with `strict` type checking.
- Build the published package with Vite in library mode; `dist/` now holds ESM output, `.d.ts`
  declarations, and source maps, and `exports` points at `dist/` instead of `src/`.
- Replace the `node --test` runner with Vitest and lint TypeScript with `typescript-eslint`.
- Export the public domain types (`EmbeddedExtension`, `ProjectJson`, `ExtensionSource`, and the
  option and result shapes of every exported function) from the package entry point.

Rollback: pin `@kubohiroya/sb3-toolchain@0.10.0`. The CLI and JavaScript API surfaces are unchanged;
only the published file layout and the development toolchain differ.

## 0.10.0 - 2026-08-27

- Add generic deterministic SB3 release snapshot helpers.
- Add release source identity, candidate write, freeze, publication, and published artifact verification utilities.

Rollback: pin `@kubohiroya/sb3-toolchain@0.9.0` and keep app-specific release workflows local to each app package.

## 0.9.0 - 2026-08-25

- Add a TurboWarp TM extension ID migration fixture workflow for `kubohiroyatm`.
- Add repository policy metadata and `repo:check` validation.
- Update README metadata, package archive checks, and release dry-run tooling.

Rollback: pin `@kubohiroya/sb3-toolchain@0.8.0` and revert project migration commits generated with this release.
