# 埋め込み機能拡張IDの移行

[English](../extension-id-migration.md)

TurboWarpは読み込んだ機能拡張のIDをプロジェクトのopcodeとmonitorに保存します。
`extensions migrate-id`はグローバルな文字列置換を行いません。SB3ソース形式v1で意味が定義されている参照だけを
変更します。

## dry runと適用

単独の移行コマンドは、既定ではdry runです。

```bash
sb3-toolchain extensions migrate-id app --from twOld --to newext
```

分類済みの変更件数と`Unclassified`参照を確認します。移行を適用する前に、新しいIDを宣言するJavaScript成果物を
`extensions/twOld.js`へ配置します。

```bash
sb3-toolchain extensions migrate-id app --from twOld --to newext --yes
```

新しいIDはTurboWarp公式の`[a-z0-9]+`形式でなければなりません。新しいIDがマニフェスト、
`extensionURLs`、`project.extensions`のいずれかにすでに存在する場合、移行は衝突として拒否されます。

## 分類済み参照

ツールは次の参照を変更します。

- `project.source.json`の`extensions[]`にある完全一致のID
- `extensionURLs`の完全一致するキーと埋め込み機能拡張の値
- `targets[*].blocks[*].opcode`の完全一致する`<oldId>_`接頭辞
- 通常のブロックスキーマを使用するメニューブロックのopcode
- `monitors[*].opcode`の完全一致する`<oldId>_`接頭辞
- `embedded-extensions.json`の`id`と`path`
- `extensions/<oldId>.js`から`extensions/<newId>.js`へのファイル名変更

変数名、リスト名、ブロックリテラル、メタデータ、別の機能拡張のopcodeに旧IDを含む文字列は変更されません。
これらは、人が意味を判断できるように、dry run出力へJSON Pointer付きの未分類参照として表示されます。

## GitHub管理対象機能拡張

管理対象機能拡張では、新しいIDを宣言する成果物を上流リポジトリが公開した後、更新と移行を組み合わせる方法を
推奨します。

```bash
sb3-toolchain extensions update app twOld \
  --migrate-id newext \
  --artifact dist/newext.js \
  --api-manifest-artifact dist/newext.manifest.json
```

上流のJavaScript成果物パスも変わった場合に限り`--artifact`を指定します。任意で使用しているマニフェストの
成果物パスも変わった場合に限り`--api-manifest-artifact`を指定します。ツールは追跡対象のrefを変更不能な
コミットに解決し、そのコミットから新しい成果物をダウンロードします。ローカルファイルを変更する前に、
`// ID: newext`を宣言していない成果物、衝突、無効な新IDを拒否します。

管理対象機能拡張が`source.apiManifest`を持つ場合、ツールは同じコミットから候補マニフェストをダウンロードし、
明示した旧IDと新IDのトップレベルIDだけを正規化して、残りのすべてのフィールドに通常のAPI互換性ポリシーを
適用します。JavaScript、名前を変更したローカルマニフェスト、来歴、指定した場合の両リモート成果物パス、
両方のintegrity値を、1回のトランザクションで変更します。詳しくは、
[`extension-api-compatibility.md`](extension-api-compatibility.md)を参照してください。

## 検証とロールバック

ツールは展開ソースディレクトリをトランザクションで置き換える前に、通常のソース検証と候補SB3の決定的ビルドを
完了します。置換が失敗した場合は、元のディレクトリを自動的に復元します。merge後にロールバックするには、
プロジェクトの移行コミットをrevertし、旧ID、成果物、来歴をまとめて元に戻します。
