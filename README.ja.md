# sb3-toolchain

[English](README.md)

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
- ZIPエントリ順、タイムスタンプ、圧縮設定を固定した決定的ビルド
- 展開済みbase sourceを変更せず、JSON／YAML build manifestからsprite、backdrop、costume、soundを追加
- 全ターゲットのスクリプトをTurboWarp風の決定的な「きれいにする」配置へ任意で整理
- import時に未コミットのGit変更を保護
- トランザクションによる置換とロールバックで既存出力を保護
- CLIとJavaScript APIの両方を提供

## 必要環境

- Node.js 22.12.0以降
- pnpm 11

## インストール

再現可能なインストールのため、検証済みのnpmバージョンを固定します。

```bash
pnpm add --save-dev --save-exact @kubohiroya/sb3-toolchain@0.7.0
```

## クイックスタート

TurboWarpで保存したSB3を展開して検証し、再ビルドします。

```bash
sb3-toolchain import tmp/project.sb3 --output app
sb3-toolchain check app
sb3-toolchain build app --output dist/project.sb3
```

プロジェクトリポジトリに推奨する信頼できる唯一の情報源、再import、置換保護、機能拡張更新、CIの
ワークフローについては、[`docs/ja/workflows.md`](docs/ja/workflows.md)を参照してください。

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

## ドキュメント

- [`docs/ja/workflows.md`](docs/ja/workflows.md): SB3ソースと機能拡張を管理するワークフロー
- [`docs/ja/source-format-v1.md`](docs/ja/source-format-v1.md): 展開ソース形式と決定的出力
- [`docs/ja/project-asset-additions.md`](docs/ja/project-asset-additions.md): `--project-assets`のJSON／YAML、backdrop、編集／strict lock仕様
- [`docs/ja/extension-id-migration.md`](docs/ja/extension-id-migration.md): プロジェクトで使用中の機能拡張IDの移行
- [`docs/ja/extension-api-compatibility.md`](docs/ja/extension-api-compatibility.md): 機能拡張更新時の任意の静的API互換性検査
- [`docs/ja/extension-bundles.md`](docs/ja/extension-bundles.md): 1つの権限単位への静的bundleと可逆的なunbundle

## 開発

```bash
pnpm install
pnpm check
```

## ライセンス

[Mozilla Public License 2.0](LICENSE)

この実装は、[`kubohiroya/tmpose-kamishibai`](https://github.com/kubohiroya/tmpose-kamishibai)
向けに開発された一般的なSB3ソース管理機構を、プロジェクト固有およびTMPose固有の処理から分離したものです。
