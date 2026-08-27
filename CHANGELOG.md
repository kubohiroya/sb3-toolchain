# Changelog

## 0.10.0 - 2026-08-27

- Add generic deterministic SB3 release snapshot helpers.
- Add release source identity, candidate write, freeze, publication, and published artifact verification utilities.

Rollback: pin `@kubohiroya/sb3-toolchain@0.9.0` and keep app-specific release workflows local to each app package.

## 0.9.0 - 2026-08-25

- Add a TurboWarp TM extension ID migration fixture workflow for `kubohiroyatm`.
- Add repository policy metadata and `repo:check` validation.
- Update README metadata, package archive checks, and release dry-run tooling.

Rollback: pin `@kubohiroya/sb3-toolchain@0.8.0` and revert project migration commits generated with this release.
