# Project asset additions

Use a project asset additions manifest when a generated SB3 needs sprites, costumes, or sounds that
must not be written into the expanded base source. The manifest is a build input. The source
directory, `project.source.json`, and its `assets/` directory remain unchanged.

## Manifest format 1

```json
{
  "formatVersion": 1,
  "sprites": [
    {
      "name": "Princess",
      "layerOrder": 6,
      "visible": false,
      "x": 4,
      "y": -16,
      "size": 70,
      "direction": 90,
      "draggable": false,
      "rotationStyle": "all around",
      "volume": 100,
      "costumes": [
        {
          "name": "Princess",
          "file": "assets/Princess.png",
          "size": 220534,
          "sha256": "e9d1857528a619e4a56ebd232fea4767fd6bdd00b20ac67a90c859c6b3598e83",
          "dataFormat": "png",
          "bitmapResolution": 2,
          "rotationCenterX": 507,
          "rotationCenterY": 507,
          "license": "CC-BY-SA-4.0: ../../LICENSES.md"
        }
      ],
      "sounds": []
    }
  ]
}
```

Every sprite field is explicit. `costumes` must contain at least one entry. Optional `license` is
validated as single-line provenance metadata but is not copied into Scratch `project.json`. A sound uses the same
`name`, `file`, `size`, `sha256`, and `dataFormat` fields plus positive integer `rate` and
non-negative integer `sampleCount` fields.

The toolchain validates the exact JSON keys, target and asset name uniqueness, relative file paths,
regular-file type, symlink-free traversal, byte size, SHA-256, data format, and Scratch metadata. It
computes the Scratch MD5 `assetId`, appends each unique content-addressed file once, and rejects a
collision with different bytes.

Asset files are confined to the manifest directory by default. Add an explicit allowed root when a
manifest intentionally reads a shared repository asset directory.

```bash
sb3-toolchain check app \
  --project-assets stories/my-story/project-assets.json \
  --allow-asset-root resources

sb3-toolchain build app \
  --project-assets stories/my-story/project-assets.json \
  --allow-asset-root resources \
  --output dist/my-story.sb3
```

The JavaScript API accepts the same inputs.

```js
await createDeterministicSb3('app', {
  projectAssetsPath: 'stories/my-story/project-assets.json',
  allowedAssetRoots: ['resources'],
});

await buildSb3({
  sourceDirectory: 'app',
  projectAssetsPath: 'stories/my-story/project-assets.json',
  allowedAssetRoots: ['resources'],
  outputPath: 'dist/my-story.sb3',
});
```

Omit `projectAssetsPath` to retain the existing build behavior. Rebuilding from identical expanded
source, manifest, locked asset bytes, and toolchain version produces an identical SB3.
