# Changelog

## Unreleased

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
