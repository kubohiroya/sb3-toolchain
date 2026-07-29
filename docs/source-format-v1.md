# SB3展開ソース形式 v1

## 構成

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

`sb3-source.json`は形式バージョン、各構成要素のパス、元SB3のZIPエントリ順を保持します。

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

元SB3の`project.json`を2スペースで整形したJSONです。配列とオブジェクトの順序は
意味のある入力として保持します。data URLで埋め込まれていたTurboWarp拡張は次の参照へ
置き換えます。

```text
embedded-extension:extensions/<extensionId>.js
```

ビルド時には`embedded-extensions.json`のメディアタイプ、パラメーター、エンコーディングを
使ってdata URLへ戻します。

## アセット

`assets/`には`project.source.json`から参照されるコスチュームと音声を置きます。
各ファイル名は`<assetId>.<dataFormat>`であり、`assetId`は内容のMD5と一致しなければ
なりません。未参照、欠損、余分なファイルは検証エラーです。

## 決定的出力

- ZIPエントリ順は`archiveEntries`に従う
- ZIPタイムスタンプは1980-01-01 00:00:00に固定
- 圧縮レベルは6に固定
- `project.json`は末尾改行付きの最小JSONとして格納
- 同じソース形式バージョン、入力ファイル、ツールバージョンから同じバイト列を生成

## 安全性

- 絶対パス、`\`、空要素、`.`、`..`を含むZIPエントリを拒否
- シンボリックリンクまたは特殊ファイルをソースとして受理しない
- import先のファイルシステムルート、Gitリポジトリルート、その祖先、`.git/`を拒否
- 認識できない既存ディレクトリを上書きしない
- Git管理中の差分は明示的な二段階指定なしに破棄しない
- 置換中断時のロールバック領域を検出した場合は自動上書きしない
