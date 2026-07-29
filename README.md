# sb3-toolchain

Scratch 3／TurboWarpの`.sb3`をGit差分可能な展開ソースとして管理し、同じ入力から
bit-for-bitで同一のSB3を再生成するNode.jsツールチェーンです。

## 主な機能

- SB3を整形済み`project.source.json`、アセット、埋め込み拡張へ安全に展開
- アセット参照、MD5、ZIPエントリ、埋め込み拡張対応を検証
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

既存出力と内容が同じ場合は更新時刻を変えません。異なる既存出力の置換には対話確認
または`--yes`が必要です。import先に未コミット変更がある場合、`--yes`だけでは置換せず、
明示的な`--discard-local-changes`も要求します。

## JavaScript API

```js
import {
  buildSb3,
  createDeterministicSb3,
  importSb3,
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
```

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
