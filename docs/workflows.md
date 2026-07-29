# SB3ソース管理ワークフロー

この文書は、Scratch 3／TurboWarp作品のSB3を展開ソースとしてGit管理し、検証済みの
SB3を再構築するための共通手順です。作品固有の編集方法、テスト、配布先は各作品の
リポジトリで定めます。

展開ディレクトリの構造と各ファイルの仕様は
[`source-format-v1.md`](source-format-v1.md)を参照してください。

## 基本方針

- 展開ディレクトリをGit上の正本とし、生成したSB3はビルド成果物として扱う
- TurboWarpエディターで編集したSB3は、差分を確認してから展開ディレクトリへimportする
- commit前と配布前に`check`を実行する
- CIと配布では、固定したtoolchainバージョンとcommit済みの展開ソースから`build`する
- 管理対象の埋め込み拡張は、取得元commitとSHA-256を固定して再現する

以下では展開ディレクトリを`app/`、エディターから保存したSB3を
`tmp/edited.sb3`、生成物を`dist/project.sb3`とします。実際のパスは作品側で
決めてください。

## 初回import

TurboWarpから保存したSB3を、Git管理しやすいファイルへ展開します。

```bash
sb3-toolchain import tmp/edited.sb3 --output app
sb3-toolchain check app
git status --short
```

import後は、少なくとも次を確認します。

- `project.source.json`の変更がエディターで行った操作に対応している
- `assets/`の追加・削除が意図したものだけである
- `extensions/`と`embedded-extensions.json`に予期しない変更がない
- `sb3-toolchain check app`が成功する

新規importでは、埋め込みJavaScriptの取得元を推測しません。GitHub上の拡張を
管理対象にする場合は、後述の由来情報を明示します。

## 既存ソースへの再import

エディターで作品を変更した場合は、保存したSB3を既存の展開ディレクトリへimport
します。

```bash
git status --short
sb3-toolchain import tmp/edited.sb3 --output app
sb3-toolchain check app
git diff -- app
```

既存の展開ディレクトリと内容が異なる場合は置換確認を求めます。非対話環境では
`--yes`で確認を省略できますが、Git管理中の未コミット変更は破棄しません。
その変更を破棄する場合だけ、差分を確認したうえで両方を指定します。

```bash
sb3-toolchain import tmp/edited.sb3 --output app \
  --yes \
  --discard-local-changes
```

`--discard-local-changes`は復旧手段ではありません。必要な差分をcommitまたは退避
してから使用してください。`--force`オプションはありません。

同じIDとパスを持つ管理対象拡張の由来情報は再import時に維持されます。SB3内の
JavaScriptが記録済みのIDまたはSHA-256と異なる場合は、由来情報と実ファイルの
食い違いを防ぐため、既存出力を変更せずにimportを拒否します。

## 検証とビルド

展開ソースだけを検証する場合は`check`、SB3を生成する場合は`build`を使います。

```bash
sb3-toolchain check app
sb3-toolchain build app --output dist/project.sb3
```

`check`と`build`はネットワークへ接続しません。アセット参照、MD5、展開形式、
埋め込み拡張のIDとSHA-256などをローカル入力だけで検証します。

`build`はZIPエントリ順、タイムスタンプ、圧縮条件を固定します。同じtoolchain
バージョンと同じ展開ソースからはbit-for-bitで同一のSB3を生成します。既存の出力と
内容が同じ場合は更新時刻を変えず、異なる場合は置換確認または`--yes`を要求します。

生成したSB3は、作品側のテストに加えてTurboWarpで開き、起動、主要操作、画像・音声、
埋め込み拡張の動作を確認してください。

## 管理対象の埋め込み拡張

`embedded-extensions.json`の`source`へ、GitHubリポジトリ、追跡するref、
解決済みcommit、成果物パス、SHA-256を記録できます。完全なschemaは
[`source-format-v1.md`](source-format-v1.md)を参照してください。

各コマンドの役割は次のとおりです。

| コマンド                | ネットワーク | refの解決 | メタデータ更新 | 用途                               |
| ----------------------- | ------------ | --------- | -------------- | ---------------------------------- |
| `extensions status`     | 使用する     | する      | しない         | 追跡refに更新があるか確認する      |
| `extensions sync`       | 使用する     | しない    | しない         | 固定commitから実ファイルを復元する |
| `extensions update`     | 使用する     | する      | する           | refの最新commitへ明示的に更新する  |
| `extensions migrate-id` | 使用しない   | しない    | IDと参照を更新 | 読み込み済み拡張IDを移行する       |

### 更新の確認

```bash
sb3-toolchain extensions status app
```

`status`はローカルファイルを変更しません。追跡refと`resolvedCommit`が異なる拡張を
確認し、上流の変更内容をレビューしてから更新するか判断します。

### 固定commitからの復元

```bash
sb3-toolchain extensions sync app
sb3-toolchain check app
```

`sync`はmutableなbranchやtagを解決せず、記録済み`resolvedCommit`から取得します。
取得した成果物のIDとSHA-256が記録と一致する場合だけ、ローカルファイルを置換します。

### 追跡refの更新

```bash
sb3-toolchain extensions update app
sb3-toolchain extensions update app EXTENSION_ID
sb3-toolchain check app
git diff -- app
```

IDを省略すると、すべての管理対象拡張を一つのtransactionとして更新します。
一部の取得または検証が失敗した場合は、ファイルもメタデータも変更しません。

更新PRでは、`resolvedCommit`、`integrity`、JavaScript成果物を同時にレビューし、
生成SB3上でも拡張の主要機能を確認します。

## 拡張IDの移行

拡張IDはopcodeやmonitorにも保存されるため、ファイル名やmanifestだけを手作業で
変更してはいけません。まずdry-runで分類済みの参照と未分類参照を確認します。

```bash
sb3-toolchain extensions migrate-id app --from OLD_ID --to NEW_ID
```

新IDを宣言するJavaScriptを用意し、結果を確認してから適用します。

```bash
sb3-toolchain extensions migrate-id app --from OLD_ID --to NEW_ID --yes
sb3-toolchain check app
git diff -- app
```

GitHub管理対象の拡張では、上流成果物の更新とID移行を一つのtransactionにできます。

```bash
sb3-toolchain extensions update app OLD_ID \
  --migrate-id NEW_ID \
  --artifact dist/NEW_ID.js
```

`--artifact`は上流の成果物パスも変わる場合だけ指定します。変更対象となるschema、
collision判定、未分類参照、ロールバックの詳細は
[`extension-id-migration.md`](extension-id-migration.md)を参照してください。

## CIと配布

CIでは依存バージョンを固定し、少なくとも次を実行します。

```bash
sb3-toolchain check app
sb3-toolchain build app --output dist/project.sb3 --yes
```

作品側の自動テストと手動確認を通過したSB3だけを配布します。`sync`や`update`を
配布ビルドへ暗黙に組み込むとネットワーク上の状態が入力になるため、更新は独立した
レビュー可能な変更として実行し、固定済みの展開ソースを先にcommitしてください。

## 失敗時の扱い

- コマンドが置換を拒否した場合は、再実行前に`git status`と対象差分を確認する
- `.＜出力名＞.rollback-*`が残った場合は、削除前に元出力と比較して復旧対象を確定する
- 途中で失敗した拡張更新は再実行前に`git diff`を確認する
- マージ済みの変更は、作品側のcommitをrevertしてソース、成果物、由来情報を同時に戻す
- 公開済みSB3を差し替える場合は、作品側のリリース方針に従い履歴を残す

Git履歴を破壊して復旧せず、原因と影響範囲を確認できる状態を保ってください。
