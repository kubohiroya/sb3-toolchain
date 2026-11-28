# sb3-toolchain

[English](README.md) | 日本語

検証済みの埋込拡張を持つ Plus SB3 の対応範囲と証跡は [lock 付き Plus SB3 のソース往復](docs/ja/plus-artifact-roundtrip.md) を参照してください。

Scratch 3およびTurboWarpの`.sb3`プロジェクトを、Gitで差分を確認できる展開ソースとして管理し、
同じ入力からバイト単位で同一のSB3ファイルを再ビルドするためのNode.jsツールチェーンです。

## 特長

- SB3を、整形済みの`project.source.json`、アセット、埋め込み機能拡張へ安全に展開
- アセット参照、MD5ハッシュ、ZIPエントリ、埋め込み機能拡張の対応関係を検証
- GitHubの固定コミットまたはインストール済みnpmパッケージの完全固定バージョンから埋め込み機能拡張を管理し、
  SHA-256ハッシュをオフラインで検証
- 埋め込みJavaScriptを置き換える前に、バージョン付き機能拡張APIマニフェストを任意で比較
- 元のJavaScriptを削除せず、複数の機能拡張を1つの権限単位へ静的にbundleし、展開ソースまたは
  bundle済みSB3から復元
- 各機能拡張の固定SHA-256、保持形式、保持バイト数、作品のURI、および複数の作品が共有するdigestを、
  ブラウザーの保存状態を読まず、何も取得せずに出力
- ZIPエントリ順、タイムスタンプ、圧縮設定を固定した決定的ビルド
- 展開済みbase sourceを変更せず、JSON／YAML build manifestからsprite、backdrop、costume、soundを追加
- 全ターゲットのスクリプトをTurboWarp風の決定的な「きれいにする」配置へ任意で整理
- `clean-up` で既存の SB3 内のスクリプトを整理し、別ファイルに保存
- import時に未コミットのGit変更を保護
- トランザクションによる置換とロールバックで既存出力を保護
- CLIとJavaScript APIの両方を提供

## 必要環境

- Node.js 24以降
- pnpm 11

## インストール

再現可能なインストールのため、検証済みのnpmバージョンを固定します。

```bash
pnpm add --save-dev --save-exact @kubohiroya/sb3-toolchain@0.31.4
```

## クイックスタート

TurboWarpで保存したSB3を展開して検証し、再ビルドします。

```bash
sb3-toolchain import tmp/project.sb3 --output app
sb3-toolchain check app
sb3-toolchain build app --output dist/project.sb3
```

Kamishibai作品SB3のRuntimeバンドルとBlock Scriptは、一発コマンドで更新できます。
`--from`省略時は公式サイトの公開済みブロック台本を自動取得します。

```bash
sb3-toolchain extensions replace-sb3 input.sb3 --output updated.sb3
```

提供元の指定方法、保持するデータ、検証と制限は[SB3の機能拡張更新](docs/ja/sb3-extension-replacement.md)を参照してください。

ブラウザーの機能拡張キャッシュと照合するため、手元のSB3が機能拡張について述べていることを一覧します。
何も取得せず、ブラウザーの保存状態も読みません。

```bash
sb3-toolchain extensions digests one.sb3 two.sb3
```

プロジェクトリポジトリに推奨する信頼できる唯一の情報源、再import、置換保護、機能拡張更新、CIの
ワークフローについては、[`docs/ja/workflows.md`](docs/ja/workflows.md)を参照してください。

### 作品内のテストを一覧にする

`sb3-toolchain test list app --json` または `sb3-toolchain test list project.sb3 --json`
で、テスト用ハットをターゲット名とブロック ID で一覧にできます。`--json` を省略すると、
各行に識別子と表示名を引用符付きで表示します。拡張機能や VM は実行しません。
配布用の SB3 からテスト・セットアップ用スクリプトを除くには、`build` に `--strip-tests`
を付けます。既定では残します。

### 固定したローカルの Editor で作品内テストを実行する

`npx playwright-core@1.64.1 install chromium` で対応する Chromium を入れ、
信頼できる手元の TurboWarp Plus Editor ビルドと、サイト側の完全なコミット SHA を指定します。

```bash
sb3-toolchain test run project.sb3 --editor-dir /path/to/build \
  --editor-revision FULL_SITE_SHA --test Stage/BLOCK_ID --reporter junit --out results.xml
```

`--test` を省くと全件、繰り返すと複数件を指定できます。外部に接続せず、Editor の実テストフレームで実行します。
組み込みの TurboWarp Test（`extensions/turbowarp-test.js`、ハッシュ `7f6541ce…`）のみ対応します。
旧形式の URL、外部拡張、ハッシュの不一致は起動前に拒否します。依存のない同梱拡張に限り、
`--allow-sandboxed ID=SHA256` を明示すると、サンドボックス内で実行できます。出所不明の SB3 の
自己申告ではなく、信頼できるビルド出力のダイジェストを使い、実際の読み込みダイジェストを報告する
Editor が必要です。コミット SHA はローカルのビルド情報との照合であり、署名検証ではありません。
信頼できるビルドだけを指定してください。
JUnit は既定で標準出力、`--out` で新規ファイルに出力します。失敗・エラー・タイムアウトは非ゼロで終了します。

## JavaScript API

```js
import {readFile} from 'node:fs/promises';

import {
  buildSb3,
  bundleExtensions,
  createDeterministicSb3,
  extensionIntegrity,
  extensionStatus,
  importSb3,
  inventoryExtensionDigests,
  migrateExtensionId,
  planExtensionIdMigration,
  syncExtensions,
  unbundleSb3,
  unbundleExtensions,
  updateExtensions,
  validateSb3Source,
} from '@kubohiroya/sb3-toolchain';

await importSb3({
  inputPath: 'tmp/project.sb3',
  outputDirectory: 'app',
});

await validateSb3Source('app');

await buildSb3({
  sourceDirectory: 'app',
  outputPath: 'dist/project.sb3',
  // 生成SB3だけを整理済みブロック座標にする場合に明示的に有効化します。
  cleanUpBlocks: true,
});

const {archive} = await createDeterministicSb3('app', {cleanUpBlocks: true});

const integrity = extensionIntegrity(await readFile('app/extensions/example.js'));

const statuses = await extensionStatus('app');
// 読み取り専用です。SB3中のURLにはアクセスせず、ブラウザーの保存状態も読みません。
const inventory = await inventoryExtensionDigests(['dist/project.sb3']);
const migration = await planExtensionIdMigration({
  sourceDirectory: 'app',
  fromId: 'oldId',
  toId: 'newid',
});
await migrateExtensionId({
  sourceDirectory: 'app',
  fromId: 'oldId',
  toId: 'newid',
  yes: true,
});
await syncExtensions({sourceDirectory: 'app', yes: true});
await updateExtensions({
  sourceDirectory: 'app',
  extensionId: 'oldId',
  migrateToId: 'newid',
  sourceArtifact: 'dist/newid.js',
  apiManifestArtifact: 'dist/newid.manifest.json',
  yes: true,
});
// After reviewing a reported breaking API change, opt in explicitly:
await updateExtensions({sourceDirectory: 'app', allowBreakingApi: true, yes: true});
await bundleExtensions({
  sourceDirectory: 'app',
  bundleId: 'projectbundle',
  bundleName: 'Project Extension Bundle',
  extensionIds: ['extensionone', 'extensiontwo'],
  yes: true,
});
await unbundleExtensions({
  sourceDirectory: 'app',
  bundleId: 'projectbundle',
  yes: true,
});
await unbundleSb3({
  inputPath: 'dist/project.sb3',
  outputPath: 'dist/project.unbundled.sb3',
  bundleId: 'projectbundle',
  yes: true,
});
```

### ブラウザーで作品フォルダを作る

`@kubohiroya/sb3-toolchain/browser` の `unpackSb3(bytes)` は、SB3 のバイト列を作品フォルダの `Map<string, Uint8Array>` と警告の一覧に変換します。作品フォルダは展開ソース形式 1 で作ります。TurboWarp Plus Editor の画面状態（ZIP のエントリ `tw-plus/workspace.json`）は `.tw-plus/workspace.json` になります。生成されたファイルは `validateSourceFiles(files)` で再検査できます。どちらの関数も Node.js の組み込みモジュールやファイルシステムを使いません。

同じ入口のブロックパレットの関数（`resolveBlockPaletteReferences`・`applyBlockPaletteComments`・`extractBlockPalette`・`hasBlockPaletteSettings`）は、今は書かない[展開ソース形式 v2](docs/ja/source-format-v2.md)の作品フォルダを扱うために残しています。

参照のないハッシュ名の素材と ZIP のディレクトリエントリーは、警告を返して除外します。Plus 拡張マニフェストと参照のない添付ファイルは、対応する作品フォルダで開けないため `Sb3SourceError` の `unsupported-project` として報告します。画像・音声・フォントの参照と内容、埋め込み拡張のファイル構成を確認します。バンドルのビルドと管理対象拡張の完全な検査には CLI の `check` と `build` を使えます。

## ドキュメント

- [外部拡張の取得・標準ソースビルド・成果物 lock](docs/ja/external-extension-resolution.md)

- [`docs/ja/workflows.md`](docs/ja/workflows.md): SB3ソースと機能拡張を管理するワークフロー
- [`docs/ja/source-format-v1.md`](docs/ja/source-format-v1.md): 展開ソース形式と決定的出力
- [`docs/ja/source-format-v2.md`](docs/ja/source-format-v2.md): ブロックパレットの設定を足した形式 v2（読むだけで、今は書かない）
- [`docs/ja/project-asset-additions.md`](docs/ja/project-asset-additions.md): `--project-assets`のJSON／YAML、backdrop、編集／strict lock仕様
- [`docs/ja/extension-id-migration.md`](docs/ja/extension-id-migration.md): プロジェクトで使用中の機能拡張IDの移行
- [`docs/ja/extension-api-compatibility.md`](docs/ja/extension-api-compatibility.md): 機能拡張更新時の任意の静的API互換性検査
- [`docs/ja/extension-bundles.md`](docs/ja/extension-bundles.md): 静的bundle、共有依存を持つ明示選択のmodule統合ビルド、可逆的なunbundle
- [`docs/ja/extension-digests.md`](docs/ja/extension-digests.md): 機能拡張のdigest、4つの保持形式、作品のURI、共有されるdigest

## 開発

ソースはTypeScriptで記述し、Viteのライブラリモードでビルドし、Vitestでテストします。
`pnpm run check`は、lint・format・typecheck・test・build・リポジトリポリシー・pack検査をこの順で実行します。

```bash
npm install --global corepack@latest
corepack enable
pnpm install --frozen-lockfile
pnpm run check
```

個別のステップ:

```bash
pnpm run typecheck
pnpm run test
pnpm run test:watch
pnpm run build
```

`pnpm run build`は`dist/`（ESMと`.d.ts`型定義、ソースマップ）を出力します。
ライブラリのエントリも`sb3-toolchain`実行ファイルも`src/`からビルドされるため、
チェックアウトからCLIを使う場合は先にビルドしてください。

## ライセンス

SPDX-License-Identifier: MPL-2.0

この実装は、[`kubohiroya/tm-kamishibai`](https://github.com/kubohiroya/tm-kamishibai)
向けに開発された一般的なSB3ソース管理機構を、TurboWarp TMのアプリケーション層から分離したものです。
