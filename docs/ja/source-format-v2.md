# SB3展開ソース形式v2

[English](../source-format-v2.md)

形式 v2 は、[形式 v1](source-format-v1.md) にブロックパレットの設定を足したものである。設定とは、スプライト・背景ごとに、ブロックパレットにどのブロックグループを表示するかである。ここに書いていないことは v1 と同じ。

## どちらの版で書くか

版は作品の中身で決まり、利用者は選ばない。

- パレット設定のある作品は、`block-palette.json` を付けて v2 で書く。
- 設定のない作品は、今までと1バイトも変わらない v1 で書く。設定をすべて消したときは v1 に戻し、`block-palette.json` と `blockPalette` のキーを消す。

読み手（`check`・`build`・`import`、ブラウザー版の `validateSourceFiles`・`unpackSb3`）は v1 と v2 を受け付ける。それ以外の版は、出力を変えずに拒否する。v1 しか知らない版のツールは、v2 の作品フォルダの設定を黙って捨てずに、対応していない版として断る。

## 構成

```text
SOURCE_DIR/
├── sb3-source.json
├── project.source.json
├── embedded-extensions.json
├── block-palette.json
├── assets/
└── extensions/
```

`sb3-source.json` は `"formatVersion": 2` で、パレット設定のパスを記録する。

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

`blockPalette` は v2 では必須で、v1 では書けない。`embedded-extensions.json` は、独自の `"formatVersion": 1` のままである。

## ブロックグループの ID

| 種類                       | ID                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| 標準                       | `motion`・`looks`・`sound`・`events`・`control`・`sensing`・`operators`・`variables`・`lists`・`myBlocks` |
| 機能拡張（1つのグループ）  | `<extensionId>`（例：`pen`）                                                                              |
| 機能拡張（複数のグループ） | `<extensionId>/<groupId>`（例：`myExt/geometry`）。`groupId` は英数字・`_`・`-` だけで書く                |

グループ ID は `^[A-Za-z0-9._-]+(/[A-Za-z0-9_-]+)?$` に合う文字列とする。作品に読み込まれていない機能拡張のグループ ID はエラーにしない。あとで機能拡張を読み込めば表示されるようにするためである。

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
    "logic": {"name": "ロジック専用", "groups": ["events", "control", "operators", "myExt"]}
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

- `formatVersion`：パレット設定の形式の版で、`1`。展開ソース形式の版とは別に数える。
- `order`（省略可）：作品全体でのグループの並び。載っていないグループは後ろに並べる。
- `sets`（省略可）：作品全体で使う、名前付きのグループの組。組の ID は `^[A-Za-z_][A-Za-z0-9_-]*$` に合う文字列とし、組ごとに空でない `name` と `groups` を書く。
- `stage`（省略可）：背景に表示するグループ。
- `sprites`（省略可）：スプライトごとに表示するグループ。キーはスプライト名で、作品にあるスプライトを指す。空のオブジェクトは書かず、キーごと省く。
- `groups` は、既定からの差分ではなく、表示するものをすべて書く。既定が将来変わっても、作品の見え方が変わらないようにするためである。重複はエラーにする。
- 記録のないスプライト・背景は、エディターの既定のグループで表示する。
- 知らないキーはエラーにする。`order`・`sets`・`stage`・`sprites` のどれか1つは必要である。

ツールは、2 スペースで字下げし、キーを上の例の順に並べ、末尾に改行を付けて書く。

## `project.source.json` のコメント参照

設定のあるスプライト・背景には、本文が次のとおりのコメントがちょうど1つある。

```text
block-palette:block-palette.json
```

このコメントは、sb3 での ID・位置・大きさ・最小化の状態・並び順を保つ。背景では、`stage`・`order`・`sets` のどれかがあるときにこのコメントを置く。設定のないスプライト・背景にはこのコメントを置かない。参照のあるスプライト・背景に、パレット設定のコメントの本文をそのまま置くこともできない。

## sb3 のパレット設定のコメント

sb3 では、設定を普通のコメントとして、スプライト・背景ごとに1つずつ入れる。標準の TurboWarp や Scratch 3 で開いて保存し直しても、設定が失われないようにするためである。本文は2行である。

```text
TurboWarp Plus Editor block palette for this sprite. You can delete this comment to reset the palette.
{"formatVersion":1,"groups":["events","control","operators","myExt/geometry"]} // _twplus_palette_
```

- 1行目は英語で固定する。背景では `TurboWarp Plus Editor block palette for the stage. You can delete this comment to reset the palette.` とする。
- 2行目は1行の JSON で、末尾に印 ` // _twplus_palette_` を付ける。パレット設定のコメントは、コメントの ID ではなくこの印で見分ける。TurboWarp は保存のたびにコメントの ID を付け直すためである。
- スプライトの JSON のキーは、`formatVersion`・`groups` の順とする。
- 背景の JSON のキーは、`formatVersion` のあとに、あるものだけ `groups`・`order`・`sets` の順に並べる。
- 本文全体を 8000 文字（Unicode のコードポイント数）以内にする。Scratch 3 はこれより長いコメントを含む作品を開かないため、`check` と `build` を失敗させる。
- 新しく置くコメントは、`blockId: null`、`x: 0`、`y: 0`、`width: 200`、`height: 200`、`minimized: true` で作る。

## 展開と `build`

- **展開（sb3 → 作品フォルダ）**：各スプライト・背景から印の付いたコメントを探し、その JSON を `block-palette.json` の `stage` か `sprites.<名前>` に移す。背景のコメントからは `order` と `sets` も移す。コメントの本文は参照に置き換える。
- **`build`（作品フォルダ → sb3）**：参照を、上の決まった書式の本文に戻す。パレット設定のコメントが決まった書式どおりの sb3 は、展開して `build` すると同じバイト列に戻る。
- **本文が決まった書式と違うとき**（手で書き換えた場合など）：JSON として読めて検査に通れば取り込み、`build` で決まった書式に書き直すことを展開時に警告する。この場合、元の sb3 と同じバイト列には戻らない。
- **本文が読めないとき**：普通のコメントとしてそのまま残し、設定はないものとして扱い、展開時に警告する。
- **1つのスプライト・背景に印の付いたコメントが2つ以上あるとき**：展開を失敗させる。
- **本文がちょうど `block-palette:block-palette.json` の普通のコメントがあるとき**：参照のために取ってある本文なので、展開を失敗させる。

ブラウザー版の `unpackSb3` は、警告を `block-palette-normalized` か `block-palette-invalid` として、`target`・`commentId`・`message` を付けて返す。`importSb3` は結果の `warnings` で返し、CLI はそれを表示する。`validateSourceFiles` は、パレット設定の誤りを `invalid-block-palette` のコードで報告する。
