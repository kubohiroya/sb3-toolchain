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

リリースタグを固定してインストールします。公開前の例では`VERSION`を利用するタグへ
置き換えてください。

```bash
pnpm add --save-dev github:kubohiroya/sb3-toolchain#VERSION
```

## CLI

TurboWarpで保存したSB3を展開します。

```bash
sb3-toolchain import tmp/project.sb3 --output app
```

展開ソースを検証します。

```bash
sb3-toolchain check app
```

決定的なSB3を生成します。

```bash
sb3-toolchain build app --output dist/project.sb3
```

管理対象の埋め込み拡張について、追跡中のGitHub refに更新があるか確認します。

```bash
sb3-toolchain extensions status app
```

記録済みの固定commitから実ファイルを復元します。refは解決せず、メタデータも変更しません。

```bash
sb3-toolchain extensions sync app
```

追跡中のrefを最新commitへ解決し、成果物と`resolvedCommit`／`integrity`を更新します。
IDを省略すると、すべての管理対象拡張を一つのtransactionとして更新します。

```bash
sb3-toolchain extensions update app
sb3-toolchain extensions update app example
```

読み込み済みの拡張IDを変更する場合は、まずdry-runで分類済みの変更件数と、変更しない
未分類参照を確認します。`--yes`を付けたときだけ適用します。

```bash
sb3-toolchain extensions migrate-id app --from oldId --to newid
sb3-toolchain extensions migrate-id app --from oldId --to newid --yes
```

GitHub管理対象では、新IDを宣言する新しい成果物の取得とID移行を一つのtransactionにします。
リモートの成果物パスも変わる場合は`--artifact`で明示します。

```bash
sb3-toolchain extensions update app oldId \
  --migrate-id newid \
  --artifact dist/newid.js
```

既存出力と内容が同じ場合は更新時刻を変えません。異なる既存出力の置換には対話確認
または`--yes`が必要です。import先に未コミット変更がある場合、`--yes`だけでは置換せず、
明示的な`--discard-local-changes`も要求します。

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

## 管理対象の埋め込み拡張

`embedded-extensions.json`の拡張エントリには、任意の`source`メタデータとして
GitHubリポジトリ、追跡するref、解決済みcommit、成果物パス、SHA-256を記録できます。
`check`と`build`はネットワークへ接続せず、ローカルのJavaScriptが記録済みハッシュおよび
`// ID: <extensionId>`ヘッダーと一致することを検証します。

既存の展開ディレクトリへSB3を再importする場合、同じIDとパスを持つ拡張の`source`は
維持されます。SB3内の実ファイルが記録済みの内容から変わっている場合は、既存出力を
変更せずにimportを拒否します。メタデータ形式は
[`docs/source-format-v1.md`](docs/source-format-v1.md)を参照してください。

`extensions sync`は`resolvedCommit`だけから取得するため、mutableなbranchやtagを
再現処理に使いません。`extensions update`だけが`ref`を解決します。取得先はGitHubの
HTTPS endpointに限定し、redirectと5 MiBを超える成果物を拒否します。取得したJavaScriptは
実行せず、IDとSHA-256を検証してから展開ディレクトリを置換します。複数拡張の一部だけが
失敗した場合は、ファイルもメタデータも変更しません。

ID移行はTurboWarp公式形式の`[a-z0-9]+`を新IDに要求し、任意の文字列置換を行いません。
対象schema、dry-run、未分類参照の詳細は
[`docs/extension-id-migration.md`](docs/extension-id-migration.md)を参照してください。

展開形式の詳細は[`docs/source-format-v1.md`](docs/source-format-v1.md)を参照してください。

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
