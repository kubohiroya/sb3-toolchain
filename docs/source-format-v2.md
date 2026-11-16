# SB3 expanded source format v2

[日本語版](ja/source-format-v2.md)

Format v2 is [format v1](source-format-v1.md) plus block palette settings: which block groups the
block palette shows for each sprite and for the stage. Everything not described here is the same as
in v1.

## Which version is written

The version follows the contents of the project, not a user choice:

- A project with block palette settings is written as v2 with `block-palette.json`.
- A project without them is written as v1, byte for byte as before. When the last setting is
  removed, the folder goes back to v1: `block-palette.json` and the `blockPalette` key are removed.

Readers (`check`, `build`, `import`, and the browser `validateSourceFiles` and `unpackSb3`) accept
v1 and v2. Any other version is rejected without changing the output. Tools that only know v1 reject
a v2 folder instead of silently dropping its settings.

## Layout

```text
SOURCE_DIR/
├── sb3-source.json
├── project.source.json
├── embedded-extensions.json
├── block-palette.json
├── assets/
└── extensions/
```

`sb3-source.json` has `"formatVersion": 2` and records the path of the palette settings:

```json
{
  "formatVersion": 2,
  "project": "project.source.json",
  "embeddedExtensions": "embedded-extensions.json",
  "assetsDirectory": "assets",
  "archiveEntries": ["project.json", "<assetId>.svg"],
  "blockPalette": "block-palette.json"
}
```

`blockPalette` is required in v2 and not allowed in v1. `embedded-extensions.json` keeps its own
`"formatVersion": 1`.

## Block group IDs

| Kind                          | ID                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| Standard                      | `motion`, `looks`, `sound`, `events`, `control`, `sensing`, `operators`, `variables`, `lists`, `myBlocks` |
| Extension with one group      | `<extensionId>`, for example `pen`                                                                        |
| Extension with several groups | `<extensionId>/<groupId>`, for example `myExt/geometry`; `groupId` uses letters, digits, `_` and `-`      |

A group ID matches `^[A-Za-z0-9._-]+(/[A-Za-z0-9_-]+)?$`. Group IDs of extensions that the project
does not load are not an error, so the groups appear once the extension is added.

## `block-palette.json`

```json
{
  "formatVersion": 1,
  "order": [
    "motion",
    "looks",
    "sound",
    "events",
    "control",
    "sensing",
    "operators",
    "variables",
    "lists",
    "myBlocks",
    "pen"
  ],
  "sets": {
    "logic": {"name": "Logic only", "groups": ["events", "control", "operators", "myExt"]}
  },
  "stage": {
    "groups": [
      "looks",
      "sound",
      "events",
      "control",
      "sensing",
      "operators",
      "variables",
      "lists",
      "myBlocks"
    ]
  },
  "sprites": {
    "Sprite1": {"groups": ["events", "control", "operators", "myExt/geometry"]}
  }
}
```

- `formatVersion`: the version of the palette settings, `1`. It is counted separately from the
  source format version.
- `order` (optional): the order of groups in the palette for the whole project. Groups not listed
  come after the listed ones.
- `sets` (optional): named group sets for the whole project. A set ID matches
  `^[A-Za-z_][A-Za-z0-9_-]*$`; each set has a non-empty `name` and `groups`.
- `stage` (optional): the groups shown for the stage.
- `sprites` (optional): the groups shown for each sprite, keyed by sprite name. Every key must be
  an existing sprite. Omit the key rather than writing an empty object.
- `groups` lists every group to show, not a difference from the default, so a future default does
  not change the project. Duplicates are an error.
- A sprite or the stage without an entry is shown with the editor's default groups.
- Unknown keys are an error, and at least one of `order`, `sets`, `stage` and `sprites` must be
  present.

Tools write the file as two-space-indented JSON with a trailing newline, with keys in the order
shown above.

## Comment references in `project.source.json`

Each sprite or stage that has settings has exactly one comment whose text is:

```text
block-palette:block-palette.json
```

The comment keeps the ID, position, size, minimized state and order it had in the SB3. For the
stage, the comment exists when `stage`, `order` or `sets` is present. A target without settings must
not have such a comment, and a target with a reference must not also have a raw palette comment.

## Palette comments in the SB3

In an SB3, the settings are stored as ordinary comments, one per sprite or stage, so that standard
TurboWarp and Scratch 3 open and save the project without losing them. The text has two lines:

```text
TurboWarp Plus Editor block palette for this sprite. You can delete this comment to reset the palette.
{"formatVersion":1,"groups":["events","control","operators","myExt/geometry"]} // _twplus_palette_
```

- The first line is fixed English text. The stage uses
  `TurboWarp Plus Editor block palette for the stage. You can delete this comment to reset the palette.`
- The second line is one-line JSON followed by the marker ` // _twplus_palette_`. A palette comment
  is identified by this marker, not by its comment ID, because TurboWarp renumbers comment IDs on
  every save.
- Sprite JSON has the keys `formatVersion` and `groups`, in this order.
- Stage JSON has `formatVersion`, then `groups`, `order` and `sets` when present, in this order.
- The whole text must be at most 8000 characters (Unicode code points). Scratch 3 refuses to open a
  project with a longer comment, so `check` and `build` fail instead.
- A new comment is created with `blockId: null`, `x: 0`, `y: 0`, `width: 200`, `height: 200` and
  `minimized: true`.

## Unpack and build

- **Unpack (SB3 → folder)**: for each sprite and the stage, find the comment with the marker, move
  its JSON into `block-palette.json` (`stage` or `sprites.<name>`; `order` and `sets` from the stage),
  and replace the comment text with the reference.
- **Build (folder → SB3)**: replace each reference with the canonical text above. Unpacking an SB3
  whose palette comments are canonical and building the result gives back the same bytes.
- **Non-canonical text** (edited by hand, for example): if the JSON parses and validates, it is
  imported, and unpacking warns that build will rewrite it in the canonical form. The rebuilt SB3 is
  then not byte-identical to the input.
- **Unreadable text**: the comment is kept as a plain comment, the target has no settings, and
  unpacking warns about it.
- **Two or more marked comments on one target**: unpacking fails.
- **A plain comment whose text is exactly `block-palette:block-palette.json`**: unpacking fails,
  because that text is reserved for references.

The browser `unpackSb3` returns the warnings as `block-palette-normalized` or
`block-palette-invalid` with `target`, `commentId` and `message`. `importSb3` returns them in
`warnings`, and the CLI prints them. `validateSourceFiles` reports palette errors with the code
`invalid-block-palette`.
