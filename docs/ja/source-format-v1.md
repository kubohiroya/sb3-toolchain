# SB3展開ソース形式v1

[English](../source-format-v1.md)

## レイアウト

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

`sb3-source.json`は、形式のバージョン、各構成要素へのパス、元のSB3におけるZIPエントリ順を記録します。

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

このファイルは、元のSB3の`project.json`を2スペースインデントで整形したJSONです。配列とオブジェクトの
順序は意味のある入力として保持されます。data URLとして埋め込まれていたTurboWarp機能拡張は、次の参照に
置き換えられます。

```text
embedded-extension:extensions/<extensionId>.js
```

ビルド時には、`embedded-extensions.json`のメディアタイプ、パラメータ、エンコーディングを使用してdata URLを
再構築します。

## `embedded-extensions.json`

このファイルは、埋め込み機能拡張のdata URL情報と展開先パスを記録します。GitHubまたはインストール済み
npmパッケージから管理する機能拡張には、任意の`source`メタデータを追加できます。

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

完全固定したnpm依存では、GitHub固有のフィールドをパッケージ情報へ置き換えます。

```json
{
  "provider": "npm",
  "package": "@owner/example-extension",
  "version": "1.2.3",
  "artifact": "dist/example.js",
  "integrity": "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
}
```

- `provider`: `github`または`npm`
- `repository`: `<owner>/<repository>`形式のGitHubリポジトリ
- `ref`: 更新候補として追跡するブランチ、タグ、またはコミット
- `resolvedCommit`: 現在のファイルの取得に使用した、小文字40文字のコミットSHA
- `package`: スコープを含む完全なnpmパッケージ名
- `version`: インストール済み`package.json`に記録された完全固定のsemantic version。範囲指定は不可
- `artifact`: リポジトリまたはnpmパッケージのルートを基準にしたJavaScript成果物のパス
- `integrity`: 現在のファイルのSRI形式SHA-256
- `apiManifest`: 任意で使用するAPI互換性メタデータ
  - `artifact`: 同じGitHubリポジトリを基準にしたAPIマニフェストのパス
  - `path`: 必須のローカルパス`extensions/<extensionId>.manifest.json`
  - `formatVersion`: 対応するマニフェスト形式。現在は`1`
  - `integrity`: インストール済みマニフェストのSRI形式SHA-256

検証とビルドでは、ネットワークへ接続せずに管理対象機能拡張を検証します。

- 実ファイルのSHA-256が`integrity`と一致する
- ファイルの`// ID: <extensionId>`ヘッダーが`id`と一致する
- GitHubリポジトリ、ref、コミット、npmパッケージ、完全固定バージョン、成果物パスが安全な形式である
- `apiManifest`が存在する場合、そのJSONスキーマ、ID、形式バージョン、パス、SHA-256が有効である

既存の展開ソースディレクトリへSB3を再importすると、同じIDとパスの`source`メタデータが保持されます。
importしたファイルが記録済みのハッシュまたはIDと一致しない場合、既存の出力を変更せずにimportを拒否します。
新規importでは来歴を推測できないため、`source`は自動作成されません。

GitHub sourceの`extensions sync`は変更不能な`resolvedCommit`からJavaScriptと任意のAPIマニフェストを
ダウンロードします。npm sourceでは、最寄りの親`node_modules`にインストールされた完全固定パッケージから、
ネットワークを使わずに読み込みます。どちらもIDとハッシュが既存メタデータに一致する場合だけ復元します。
パッケージマネージャーで新しい完全固定npmバージョンを導入した後に`extensions update`を実行すると、成果物を
コピーして`version`とintegrityを更新します。GitHub更新では`ref`を解決して`resolvedCommit`を更新します。
どちらも候補APIマニフェストを事前に比較し、選択した全項目の検証が終わるまで展開ソースを変更しません。

機能拡張IDの移行では、マニフェストの`id`と`path`、`project.source.json`内の既知の参照、
`extensions/<id>.js`を1回のトランザクションで変更します。`extensions update`の一部として管理対象機能拡張を
移行する場合は、明示的に指定した`artifact`、`resolvedCommit`、`integrity`も新しい成果物に合わせて更新します。
任意のAPIマニフェストは、明示した旧IDと新IDのトップレベルIDを正規化してから比較し、新しいIDで保存して、
同じトランザクションで更新します。リモートファイル名も変わる場合は、`--api-manifest-artifact`で
`source.apiManifest.artifact`を明示的に更新します。

APIマニフェストファイルは展開ソースの検証入力であり、SB3アーカイブのエントリではありません。決定的なSB3の
バイト列は変わりません。マニフェストv1、互換性分類、破壊的変更の明示的な許可、ロールバックについては、
[`extension-api-compatibility.md`](extension-api-compatibility.md)を参照してください。

### `extensionBundles`

任意の`extensionBundles`配列を追加すると、複数の個別機能拡張を、生成SB3内だけで1つの権限単位にできます。

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

- `id`: TurboWarpの`[a-z0-9]+`形式で、個別機能拡張と衝突しない複合機能拡張ID
- `name`: 権限確認と機能拡張カテゴリに表示される単一行の名前
- `members`: 2つ以上の個別機能拡張ID。順序によってブロックとメニューの合成順が決まる。パレットでは、
  メタデータを持つ装飾済みbundle LABEL見出しとグループ間の二重separatorが追加される一方、元の機能拡張の
  LABELエントリとseparatorは変更されない
- `recoveryCapsule`: 任意の真偽値で、既定値は`false`。追加サイズを許容でき、生成SB3単体からの直接unbundleが
  必要な場合に限り`true`を指定する

1つのメンバーを複数のbundleに所属させることはできません。個別エントリ、個別JavaScript、`source`、
`project.source.json`が引き続き信頼できる情報源です。`build`は各元opcodeに`memberId + "__"`を加え、
出力側の`project.json`のopcode、`extensions`、`extensionURLs`、機能拡張ストレージだけをbundle IDに変更します。
埋め込まれるbundle JavaScriptのdata URLは1つです。

既定では、メンバーコードとヘッダー通知を生成JavaScriptに残したまま、重複する復元データを省略します。
`recoveryCapsule: true`では、元の個別data URLと機能拡張の順序を格納した形式1のカプセルを追加します。
設定を削除すれば展開ソースから常に通常出力へ戻せますが、生成SB3を直接`extensions unbundle`するには
カプセルが必要です。互換性契約と復元手順については、
[`extension-bundles.md`](extension-bundles.md)を参照してください。

## アセット

`assets/`には、`project.source.json`から参照されるコスチュームと音声が含まれます。各ファイル名は
`<assetId>.<dataFormat>`であり、`assetId`は内容のMD5と一致しなければなりません。未参照、欠落、余分な
ファイルはいずれも検証エラーです。

## 決定的出力

- ZIPエントリは`archiveEntries`に従う
- ZIPタイムスタンプは1980-01-01 00:00:00に固定
- 圧縮レベルは6に固定
- `project.json`は末尾に改行を持つ最小JSONとして格納
- ソース形式のバージョン、入力ファイル、ツールのバージョンが同じなら、同じバイト列を生成

## 安全性

- 絶対パス、`\`、空の構成要素、`.`、`..`を含むZIPエントリを拒否
- ソース入力としてシンボリックリンクと特殊ファイルを拒否
- ファイルシステムルート、Gitリポジトリルート、その祖先、`.git/`をimport先として拒否
- 認識できない既存ディレクトリを上書きしない
- 2段階の明示的な許可なしにGit管理対象の変更を破棄しない
- 中断された置換のロールバック領域が存在するときは、自動的に上書きしない
- 管理対象機能拡張のコミット、SHA-256、機能拡張IDをオフラインで検証
- bundle時に個別JavaScriptと来歴を保持し、互換性を確立できない契約を拒否
- GitHubからはHTTPSだけで取得し、リダイレクトを拒否してサイズを制限し、ダウンロードしたJavaScriptは
  決して実行しない
