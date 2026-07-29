# sb3-toolchain

Scratch 3／TurboWarpの`.sb3`をGit差分可能な展開ソースとして管理し、同じ入力から
bit-for-bitで同一のSB3を再生成するNode.jsツールチェーンです。

## 主な機能

- SB3を整形済み`project.source.json`、アセット、埋め込み拡張へ安全に展開
- アセット参照、MD5、ZIPエントリ、埋め込み拡張対応を検証
- GitHub由来の埋め込み拡張についてcommitとSHA-256を記録し、オフラインで検証
- ZIPエントリ順、タイムスタンプ、圧縮条件を固定した決定的ビルド
- Git管理中の未コミット変更を保護したimport
- 既存出力を保護する原子的な置換とロールバック
- CLIとJavaScript API

TMPose紙芝居の台本変換、特定作品のデータ、TurboWarp PackagerによるWebアプリ生成は
このパッケージの対象外です。

## 必要な環境

- Node.js 22.12.0以上
- pnpm 11

## インストール

再現可能な導入のため、npmで検証済みバージョンを固定します。

```bash
pnpm add --save-dev --save-exact @kubohiroya/sb3-toolchain@0.1.1
```

## クイックスタート

TurboWarpで保存したSB3を展開し、検証して再構築します。

```bash
sb3-toolchain import tmp/project.sb3 --output app
sb3-toolchain check app
sb3-toolchain build app --output dist/project.sb3
```

作品リポジトリでの正本、再import、上書き保護、拡張更新、CIの共通手順は
[`docs/workflows.md`](docs/workflows.md)を参照してください。

## JavaScript API

```js
import {readFile} from 'node:fs/promises';

import {
  buildSb3,
  createDeterministicSb3,
  extensionIntegrity,
  extensionStatus,
  importSb3,
  migrateExtensionId,
  planExtensionIdMigration,
  syncExtensions,
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
});

const {archive} = await createDeterministicSb3('app');

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
  yes: true,
});
```

## ドキュメント

- [`docs/workflows.md`](docs/workflows.md): 作品リポジトリでのSB3ソース管理と拡張管理
- [`docs/source-format-v1.md`](docs/source-format-v1.md): 展開ソース形式と決定的出力
- [`docs/extension-id-migration.md`](docs/extension-id-migration.md): 読み込み済み拡張IDの移行

## 開発

```bash
pnpm install
pnpm check
```

## ライセンス

[Mozilla Public License 2.0](LICENSE)

本実装は
[`kubohiroya/tmpose-kamishibai`](https://github.com/kubohiroya/tmpose-kamishibai)
で開発したSB3ソース管理機構を、作品およびTMPose固有処理から分離したものです。
