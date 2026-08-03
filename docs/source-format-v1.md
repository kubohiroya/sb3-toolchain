# SB3 expanded source format v1

[日本語版](ja/source-format-v1.md)

## Layout

```text
SOURCE_DIR/
├── sb3-source.json
├── project.source.json
├── embedded-extensions.json
├── assets/
│   └── <assetId>.<dataFormat>
└── extensions/
    └── <extensionId>.js
```

`sb3-source.json` records the format version, paths to each component, and the ZIP entry order of the
original SB3.

```json
{
  "formatVersion": 1,
  "project": "project.source.json",
  "embeddedExtensions": "embedded-extensions.json",
  "assetsDirectory": "assets",
  "archiveEntries": ["project.json", "<assetId>.svg"]
}
```

## `project.source.json`

This file is the original SB3 `project.json` formatted as two-space-indented JSON. Array and object
order are preserved as meaningful input. A TurboWarp extension that was embedded as a data URL is
replaced by this reference:

```text
embedded-extension:extensions/<extensionId>.js
```

During a build, the media type, parameters, and encoding from `embedded-extensions.json` are used to
reconstruct the data URL.

## `embedded-extensions.json`

This file records embedded extension data URL information and extraction paths. Optional `source`
metadata can be added for an extension managed from GitHub.

```json
{
  "formatVersion": 1,
  "extensions": [
    {
      "id": "example",
      "path": "extensions/example.js",
      "mediaType": "text/javascript",
      "parameters": [],
      "encoding": "base64",
      "source": {
        "provider": "github",
        "repository": "owner/example-extension",
        "ref": "main",
        "resolvedCommit": "0123456789abcdef0123456789abcdef01234567",
        "artifact": "dist/example.js",
        "integrity": "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        "apiManifest": {
          "artifact": "dist/extension-manifest.json",
          "path": "extensions/example.manifest.json",
          "formatVersion": 1,
          "integrity": "sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB="
        }
      }
    }
  ]
}
```

- `repository`: GitHub repository in `<owner>/<repository>` form
- `ref`: branch, tag, or commit to track for update candidates
- `resolvedCommit`: lowercase 40-character commit SHA used to obtain the current file
- `artifact`: JavaScript artifact path relative to the repository root
- `integrity`: SRI-form SHA-256 of the current file
- `apiManifest`: optional, opt-in API compatibility metadata
  - `artifact`: API manifest path relative to the same GitHub repository
  - `path`: required local path `extensions/<extensionId>.manifest.json`
  - `formatVersion`: supported manifest format, currently `1`
  - `integrity`: SRI-form SHA-256 of the installed manifest

Validation and builds verify managed extensions without accessing the network:

- The actual file SHA-256 matches `integrity`
- The file's `// ID: <extensionId>` header matches `id`
- The repository, ref, commit, and artifact path use safe forms
- When `apiManifest` exists, its JSON schema, ID, format version, path, and SHA-256 are valid

Re-importing an SB3 into an existing expanded source directory preserves `source` metadata for the
same ID and path. If the imported file does not match the recorded hash or ID, the import is rejected
without changing the existing output. A new import cannot infer provenance, so it does not create
`source` automatically.

`extensions sync` downloads the JavaScript and optional API manifest using the immutable
`resolvedCommit` and restores local files only when their IDs and hashes match the existing metadata.
`extensions update` resolves `ref` through the GitHub API, downloads both artifacts from that same
commit, and compares a candidate API manifest with the installed contract. It updates
`resolvedCommit` and both integrity values only after compatibility and content validation succeed.
The expanded source is not changed until every selected entry has been downloaded and validated.

An extension ID migration changes the manifest `id` and `path`, known references in
`project.source.json`, and `extensions/<id>.js` in one transaction. When a managed extension is
migrated as part of `extensions update`, `artifact` when explicitly supplied, `resolvedCommit`, and
`integrity` are also updated for the new artifact. An opt-in API manifest is compared after
normalizing the explicit old and new top-level IDs, saved under the new ID, and updated in the same
transaction. If its remote filename also changes, `--api-manifest-artifact` updates
`source.apiManifest.artifact` explicitly.

API manifest files are expanded-source validation inputs, not SB3 archive entries. They do not
change deterministic SB3 bytes. See
[`extension-api-compatibility.md`](extension-api-compatibility.md) for manifest v1, compatibility
classification, the explicit breaking-change override, and rollback.

### `extensionBundles`

Add the optional `extensionBundles` array to make multiple individual extensions one permission unit
only in the generated SB3.

```json
{
  "formatVersion": 1,
  "extensions": [
    {
      "id": "extensionone",
      "path": "extensions/extensionone.js",
      "mediaType": "text/javascript",
      "parameters": [],
      "encoding": "base64"
    },
    {
      "id": "extensiontwo",
      "path": "extensions/extensiontwo.js",
      "mediaType": "text/javascript",
      "parameters": [],
      "encoding": "base64"
    }
  ],
  "extensionBundles": [
    {
      "id": "projectbundle",
      "name": "Project Extension Bundle",
      "members": ["extensionone", "extensiontwo"]
    }
  ]
}
```

- `id`: composite extension ID in TurboWarp's `[a-z0-9]+` form that does not collide with an individual extension
- `name`: single-line name displayed in the permission prompt and extension category
- `members`: two or more individual extension IDs; their order defines block and menu composition order. The palette receives a decorated, metadata-bearing bundle LABEL heading and a double separator between groups, while LABEL entries and separators from the original extensions remain unchanged

A member cannot belong to more than one bundle. Individual entries, individual JavaScript, `source`,
and `project.source.json` remain authoritative. `build` adds `memberId + "__"` to each original opcode
and changes only the output `project.json` opcodes, `extensions`, `extensionURLs`, and extension storage
to the bundle ID. It embeds one bundle JavaScript data URL.

The end of the bundle JavaScript contains a format 1 recovery capsule with the original individual
data URLs and extension order. Removing the configuration or running `extensions unbundle` against a
generated SB3 containing that capsule restores the ordinary output. See
[`extension-bundles.md`](extension-bundles.md) for the compatibility contract and restoration steps.

## Assets

`assets/` contains costumes and sounds referenced by `project.source.json`. Each filename is
`<assetId>.<dataFormat>`, and `assetId` must match the MD5 of its contents. An unreferenced, missing,
or extra file is a validation error.

## Deterministic output

- ZIP entries follow `archiveEntries`
- ZIP timestamps are fixed at 1980-01-01 00:00:00
- Compression level is fixed at 6
- `project.json` is stored as minimal JSON with a trailing newline
- The same source format version, input files, and tool version produce the same byte sequence

## Safety

- Reject ZIP entries containing absolute paths, `\`, empty components, `.`, or `..`
- Reject symbolic links and special files as source input
- Reject a filesystem root, Git repository root, its ancestor, or `.git/` as an import destination
- Never overwrite an unrecognized existing directory
- Never discard Git-managed changes without the explicit two-stage override
- Never overwrite automatically when an interrupted replacement rollback area is present
- Verify managed extensions offline against their commit, SHA-256, and extension ID
- Preserve individual JavaScript and provenance during bundling and reject contracts whose compatibility cannot be established
- Fetch from GitHub only over HTTPS with redirects rejected and a size limit, and never execute downloaded JavaScript
