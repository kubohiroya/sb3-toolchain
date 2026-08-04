# SB3ソース管理ワークフロー

[English](../workflows.md)

この文書では、Scratch 3またはTurboWarpのSB3をGit内の展開ソースとして管理し、検証済みSB3を再ビルドする
一般的なワークフローを説明します。各プロジェクトリポジトリでは、編集、テスト、配布の手順を個別に定義して
ください。

展開ディレクトリのレイアウトとファイル形式については、
[`source-format-v1.md`](source-format-v1.md)を参照してください。

## 原則

- Git内の展開ディレクトリを信頼できる情報源として扱い、生成SB3ファイルはビルド成果物として扱う
- TurboWarp Editorで編集したSB3は、差分を確認した後に限りimportする
- コミット前と配布前に`check`を実行する
- CIとリリースワークフローでは、固定したツールチェーンバージョンとコミット済み展開ソースからビルドする
- 管理対象の埋め込み機能拡張は、固定したソースコミットとSHA-256から再現する

以下の例では、展開ソースに`app/`、エディタで保存したSB3に`tmp/edited.sb3`、生成出力に
`dist/project.sb3`を使用します。必要に応じてプロジェクト固有のパスを選択してください。

## 初回import

TurboWarpで保存したSB3を、Gitでの管理に適したファイルへ展開します。

```bash
sb3-toolchain import tmp/edited.sb3 --output app
sb3-toolchain check app
git status --short
```

import後、少なくとも次の項目を確認します。

- `project.source.json`の変更がエディタで行った操作に対応している
- `assets/`へのアセット追加または削除が意図したものだけである
- `extensions/`と`embedded-extensions.json`に予期しない変更がない
- `sb3-toolchain check app`が成功する

新規importでは、埋め込みJavaScriptの取得元は推測されません。GitHubでホストされる機能拡張を管理対象にする
場合は、後述の来歴メタデータを追加してください。

## 既存ソースへの再import

プロジェクトを編集した後、保存したSB3を既存の展開ソースディレクトリへimportします。

```bash
git status --short
sb3-toolchain import tmp/edited.sb3 --output app
sb3-toolchain check app
git diff -- app
```

既存の展開ソースと内容が異なる場合、ツールは置換の確認を求めます。非対話環境では`--yes`によって確認を
省略できますが、Git管理対象の未コミット変更は破棄されません。破棄される変更を確認した後に限り、両方の
オプションを指定してください。

```bash
sb3-toolchain import tmp/edited.sb3 --output app \
  --yes \
  --discard-local-changes
```

`--discard-local-changes`は復旧手段ではありません。使用する前に、必要な変更をコミットするなどして保存して
ください。`--force`オプションはありません。

同じIDとパスを持つ管理対象機能拡張の来歴メタデータは、再import時も保持されます。SB3内のJavaScriptが
記録済みのIDまたはSHA-256と異なる場合、実ファイルと来歴の不整合を防ぐため、既存出力を変更せずにimportを
拒否します。

## 検証とビルド

展開ソースだけを検証するには`check`、SB3を生成するには`build`を使用します。

```bash
sb3-toolchain check app
sb3-toolchain build app --output dist/project.sb3
```

`check`と`build`はネットワークへ接続しません。ローカル入力だけを使用して、アセット参照、MD5ハッシュ、
展開形式、埋め込み機能拡張ID、SHA-256ハッシュを検証します。

`build`はZIPエントリ順、タイムスタンプ、圧縮設定を固定します。同じツールチェーンバージョンと展開ソースから、
バイト単位で同一のSB3が生成されます。既存出力が同一なら変更しません。異なる場合は、置換の確認または
`--yes`が必要です。

生成SB3へ書き込む前に、全ターゲットのトップレベルスクリプトを整理するには、明示的にオプションを指定します。

```bash
sb3-toolchain build app --output dist/project.sb3 --clean-up-blocks
```

`--clean-up-blocks`は、TurboWarpの「きれいにする」配置と同じ開始座標、列の判定範囲、余白を使用します。
ブロック、変数、リスト、コメントは削除せず、ブロックに付いたコメントはスクリプトと一緒に移動します。変換する
のは生成物内の`project.json`だけであり、展開ソースは変更しません。生成SB3をTurboWarpで開いた後は座標変更を
元に戻せない場合があります。ソース座標へ戻すにはこのオプションを外して再ビルドしてください。

プロジェクト固有のテストに加えて、生成SB3をTurboWarpで開き、起動、主要な操作、画像、音声、埋め込み
機能拡張の動作を確認してください。

## 管理対象の埋め込み機能拡張

`embedded-extensions.json`の`source`オブジェクトには、GitHubコミットの来歴またはインストール済みnpm
パッケージの完全固定バージョンと、成果物パス、SHA-256を記録できます。更新時の静的互換性検査に使用する
バージョン付きAPIマニフェストも任意で設定できます。完全なスキーマは
[`source-format-v1.md`](source-format-v1.md)を参照してください。

機能拡張コマンドの役割は次のとおりです。

| コマンド                | ネットワーク | refの解決  | メタデータ更新 | 目的                                   |
| ----------------------- | ------------ | ---------- | -------------- | -------------------------------------- |
| `extensions status`     | GitHubのみ   | GitHubのみ | なし           | 上流または導入済みパッケージを確認     |
| `extensions sync`       | GitHubのみ   | なし       | なし           | 宣言したsourceからファイルを復元       |
| `extensions update`     | GitHubのみ   | GitHubのみ | あり           | 上流または導入済みパッケージを採用     |
| `extensions migrate-id` | なし         | なし       | ID／参照       | プロジェクトで使用中の機能拡張IDを移行 |
| `extensions bundle`     | なし         | なし       | bundle設定     | 機能拡張を1つの権限単位へ統合          |
| `extensions unbundle`   | なし         | なし       | 設定またはSB3  | 個別機能拡張を使用する出力へ復元       |

### 更新の確認

```bash
sb3-toolchain extensions status app
```

`status`はローカルファイルを変更しません。GitHub sourceでは追跡対象refと`resolvedCommit`を比較します。
npm sourceでは、宣言した完全固定バージョンとインストール済みパッケージをネットワークなしで比較します。

### 固定したコミットからの復元

```bash
sb3-toolchain extensions sync app
sb3-toolchain check app
```

`sync`は変更可能なブランチやタグを解決しません。GitHub sourceは`resolvedCommit`からダウンロードし、
npm sourceは最寄りの親`node_modules`へ導入済みの完全固定パッケージから読み込みます。JavaScriptと任意の
APIマニフェストが記録済みIDおよびSHA-256値に一致する場合に限り、ローカルファイルを置き換えます。

### 追跡対象refの更新

```bash
sb3-toolchain extensions update app
sb3-toolchain extensions update app EXTENSION_ID
sb3-toolchain check app
git diff -- app
```

IDを省略すると、管理対象の全機能拡張を1回のトランザクションで更新します。ダウンロードまたは検証が1つでも
失敗した場合、ファイルもメタデータも変更しません。

npm sourceでは、最初にプロジェクトのパッケージマネージャーで新しい完全固定バージョンを導入し、続けて
`extensions status`と`extensions update`を実行します。updateは導入済み成果物をコピーし、パッケージの
`version`とintegrityを記録します。sb3-toolchain自身はnpm registryへ問い合わせません。

`source.apiManifest`が存在する場合、同じ解決済みコミットからJavaScriptとAPIマニフェストをダウンロードします。
互換性のある追加は報告されます。ブロックの削除、ブロック種別の変更、引数契約の変更、参照中メニューの削除、
`acceptReporters`の変更は、インストール前に拒否されます。未参照メニューの削除には互換性があります。
報告されたすべてのパスを確認した後、意図的な破壊的更新には両方のフラグが必要です。

```bash
sb3-toolchain extensions update app EXTENSION_ID --allow-breaking-api --yes
```

バージョン付きマニフェスト契約、分類表、既定OFFの動作、ロールバックについては、
[`extension-api-compatibility.md`](extension-api-compatibility.md)を参照してください。

更新PRでは、`resolvedCommit`またはnpmの`version`、JavaScriptとマニフェストのintegrity、互換性パス、
両成果物をまとめて確認し、生成SB3で機能拡張の主要機能をテストします。

## 機能拡張IDの移行

機能拡張IDはopcodeとmonitorに保存されるため、ファイル名やマニフェストだけを手作業で変更しないでください。
dry runから始め、分類済み参照と未分類参照の両方を確認します。

```bash
sb3-toolchain extensions migrate-id app --from OLD_ID --to NEW_ID
```

新しいIDを宣言するJavaScriptを用意して結果を確認し、適用します。

```bash
sb3-toolchain extensions migrate-id app --from OLD_ID --to NEW_ID --yes
sb3-toolchain check app
git diff -- app
```

GitHub管理対象機能拡張では、上流成果物の更新とID移行を1回のトランザクションにできます。

```bash
sb3-toolchain extensions update app OLD_ID \
  --migrate-id NEW_ID \
  --artifact dist/NEW_ID.js
```

上流の成果物パスも変わった場合に限り`--artifact`を指定します。影響するスキーマ、衝突検査、未分類参照、
ロールバックについては、[`extension-id-migration.md`](extension-id-migration.md)を参照してください。

## unsandboxed権限を1回の確認に統合

複数の埋め込み機能拡張を含むプロジェクトでは、静的bundleを任意で使用できます。元のJavaScript、ID、opcode、
来歴は変更されず、ビルド出力だけが1つの複合機能拡張へ変換されます。

```bash
sb3-toolchain extensions bundle app \
  --id projectbundle \
  --name "Project Extension Bundle" \
  extensionone extensiontwo
sb3-toolchain extensions bundle app \
  --id projectbundle \
  --name "Project Extension Bundle" \
  extensionone extensiontwo \
  --yes
sb3-toolchain check app
sb3-toolchain build app --output dist/project.sb3 --yes
```

プロジェクトレベルの自動テストと実際のTurboWarpでのスモークテストを使用し、bundle前後での同等な動作、
1回だけの権限確認、保存後の再読み込み成功を検証します。問題がある場合は、保持されている個別機能拡張へ
復元します。

```bash
sb3-toolchain extensions unbundle app projectbundle
sb3-toolchain extensions unbundle app projectbundle --yes
sb3-toolchain check app
sb3-toolchain build app --output dist/project.sb3 --yes
```

展開ソースが利用できない場合でも、このバージョンのツールチェーンで生成したSB3は直接unbundleできます。
最初のコマンドはdry runで、`--yes`を指定した場合に限り出力を書き込みます。

```bash
sb3-toolchain extensions unbundle \
  dist/project.sb3 projectbundle \
  --output dist/project.unbundled.sb3
sb3-toolchain extensions unbundle \
  dist/project.sb3 projectbundle \
  --output dist/project.unbundled.sb3 \
  --yes
```

互換性契約、ソースコメント、opcodeとストレージの変換、直接unbundleの制限、再import時の注意事項については、
[`extension-bundles.md`](extension-bundles.md)を参照してください。

## CIと配布

依存関係のバージョンを固定し、CIで少なくとも次のコマンドを実行します。

```bash
sb3-toolchain check app
sb3-toolchain build app --output dist/project.sb3 --yes
```

プロジェクトレベルの自動テストと手動検証に合格したSB3だけを配布してください。ネットワーク状態が入力になって
しまうため、リリースビルドの一部として`sync`や`update`を暗黙的に実行しないでください。更新は独立した
レビュー可能な変更として行い、固定した展開ソースを先にコミットします。

## 失敗時の対応

- コマンドが置換を拒否した場合は、再試行する前に`git status`と該当する差分を確認する
- `.<output-name>.rollback-*`が残っている場合は、復元または削除を決める前に現在の出力と比較する
- 機能拡張更新が途中で失敗した場合は、再試行する前に`git diff`を確認する
- merge済み変更はプロジェクトコミットをrevertし、ソース、成果物、来歴をまとめて元に戻す
- 公開済みSB3を置き換える場合は、プロジェクトのリリースポリシーに従い、履歴を保持する

復旧の近道としてGit履歴を破壊しないでください。原因と影響範囲を調査可能な状態に保ちます。
