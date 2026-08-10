# `--project-assets`: project asset build input

`--project-assets` adds Stage backdrops, sprite costumes, Stage or sprite sounds, and new sprites to
a generated SB3 without editing its expanded base source. Both JSON and YAML are supported.

```bash
sb3-toolchain check app \
  --project-assets stories/my-story/project-assets.yml \
  --allow-asset-root resources

sb3-toolchain build app \
  --project-assets stories/my-story/project-assets.yml \
  --allow-asset-root resources \
  --output dist/my-story.sb3
```

`check` composes and validates the base source and project assets in memory. Only `build` writes an
SB3. Neither command modifies `project.source.json`, `sb3-source.json`, or the expanded `assets/`.

## YAML format (recommended)

Like DSL 4.0 `assets:`, `.yml` and `.yaml` use the asset ID as a mapping key and `kind` as the asset
type. Display properties for newly created sprites are kept separately under `sprites:`.

```yaml
formatVersion: 1

sprites:
  Princess:
    layerOrder: 6
    visible: false
    x: 4
    y: -16
    size: 70
    direction: 90
    draggable: false
    rotationStyle: all around
    volume: 100

assets:
  Princess:
    kind: costume
    target: Princess
    file: ../../resources/Princess.png
    bitmapResolution: 2
    rotationCenterX: 507
    rotationCenterY: 507
    license: 'CC-BY-SA-4.0: ../../LICENSES.md'

  DragonCastle:
    kind: backdrop
    file: ../../resources/DragonCastle.svg
    rotationCenterX: 240
    rotationCenterY: 180

  OpeningSound:
    kind: sound
    file: ../../resources/OpeningSound.mp3

  PrincessVoice:
    kind: sound
    target: Princess
    file: ../../resources/PrincessVoice.wav
```

- A `backdrop` is added to the Stage `costumes` and does not accept `target`.
- A `costume` is added to the sprite named by `target`.
- A `sound` is added to the Stage when `target` is omitted, or to the named sprite otherwise.
- An existing sprite does not need a duplicate declaration under `sprites:`.
- A new sprite is declared under `sprites:` and must receive at least one costume from `assets:`.
- The asset ID becomes its Scratch costume, backdrop, or sound name. Set `name` only to override it.

YAML uses version 1.2. Duplicate keys, multiple documents, anchors, aliases, merge keys, custom
tags, and `__proto__`, `constructor`, or `prototype` keys are rejected. YAML comments are allowed.

## JSON format

`.json` uses the same fields. The following is equivalent to the Princess part above.

```json
{
  "formatVersion": 1,
  "sprites": {
    "Princess": {
      "layerOrder": 6,
      "visible": false,
      "x": 4,
      "y": -16,
      "size": 70,
      "direction": 90,
      "draggable": false,
      "rotationStyle": "all around",
      "volume": 100
    }
  },
  "assets": {
    "Princess": {
      "kind": "costume",
      "target": "Princess",
      "file": "../../resources/Princess.png",
      "bitmapResolution": 2,
      "rotationCenterX": 507,
      "rotationCenterY": 507
    }
  }
}
```

Duplicate JSON keys are rejected. Manifest filenames must end in `.json`, `.yml`, or `.yaml`.

## Editable mode

Omit `size` and `sha256` while repeatedly overwriting an image or audio file. The current file
bytes are authoritative and the Scratch MD5 `assetId` is recomputed for every build.

Images require `kind`, `file`, `rotationCenterX`, and `rotationCenterY`; costumes also require
`target`. `bitmapResolution` is optional and defaults to `1`. `dataFormat` is inferred from the
filename extension.

Sounds normally require only `kind: sound` and `file`. MP3 and WAV metadata are parsed to infer
`rate` and `sampleCount`. Only a sprite sound also requires `target`.

## Optional strict locks

Add any of these fields when a distribution build must verify its reviewed input:

| Field                 | Check                                   |
| --------------------- | --------------------------------------- |
| `size`                | Exact file byte length                  |
| `sha256`              | Exact file SHA-256                      |
| `dataFormat`          | Format inferred from the file extension |
| `rate`, `sampleCount` | Values inferred from an audio file      |

Each supplied field is checked independently. Omitted fields do not lock content. Optional
single-line `license` provenance is validated but is not copied into Scratch `project.json`.

Identical base source, manifest, asset bytes, and toolchain version produce a bit-for-bit identical
SB3. Overwriting an asset in editable mode intentionally changes the next build. Add `size` and
`sha256` when accidental overwrites must fail instead.

## Path safety

Files are confined to the manifest directory by default. Use repeatable `--allow-asset-root` only
for intentional shared directories. Absolute paths, escaping an allowed root, symlink traversal,
special files, format mismatches, and target or asset name collisions are rejected. The manifest
itself must be a regular file no larger than 1 MiB.

## JavaScript API and rollback

```js
await createDeterministicSb3('app', {
  projectAssetsPath: 'stories/my-story/project-assets.yml',
  allowedAssetRoots: ['resources'],
});

await buildSb3({
  sourceDirectory: 'app',
  projectAssetsPath: 'stories/my-story/project-assets.yml',
  allowedAssetRoots: ['resources'],
  outputPath: 'dist/my-story.sb3',
});
```

Omit `projectAssetsPath` to return to the existing build behavior without project additions.
