# 埋め込み拡張IDの移行

TurboWarpで読み込み済みの拡張IDは、project内のopcodeやmonitorにも保存されます。
`extensions migrate-id`はJSON全体の文字列置換を行わず、SB3 source format v1で意味が
確定している参照だけを変更します。

## dry-runと適用

単独の移行コマンドは既定でdry-runです。

```bash
sb3-toolchain extensions migrate-id app --from twOld --to newext
```

出力される分類済み変更件数と`Unclassified`参照を確認し、新IDを宣言するJavaScript成果物を
`extensions/twOld.js`へ用意してから明示的に適用します。

```bash
sb3-toolchain extensions migrate-id app --from twOld --to newext --yes
```

新IDはTurboWarp公式形式の`[a-z0-9]+`でなければなりません。既存のmanifest、
`extensionURLs`、または`project.extensions`に新IDが存在する場合はcollisionとして
拒否します。

## 分類して変更する参照

- `project.source.json`の`extensions[]`にある完全一致ID
- `extensionURLs`の完全一致keyと埋め込み拡張value
- `targets[*].blocks[*].opcode`の`<oldId>_`完全prefix
- menu blockのopcode（通常のblockと同じschema）
- `monitors[*].opcode`の`<oldId>_`完全prefix
- `embedded-extensions.json`の`id`と`path`
- `extensions/<oldId>.js`から`extensions/<newId>.js`へのファイル名変更

変数名、list名、blockのliteral、metadata、別拡張のopcodeなどに旧IDを含む文字列は
変更しません。これらはJSON Pointer付きの未分類参照としてdry-run結果へ出すため、人が
意味を確認できます。

## GitHub管理対象

管理対象拡張では、上流リポジトリが新IDを宣言する成果物を公開したあと、更新と移行を
一体で実行する方法を推奨します。

```bash
sb3-toolchain extensions update app twOld \
  --migrate-id newext \
  --artifact dist/newext.js
```

`--artifact`は上流の成果物パスも変わる場合だけ指定します。ツールは追跡refを固定commitへ
解決し、そのcommitから新成果物を取得します。`// ID: newext`を宣言しない成果物、
collision、不正な新IDは、ローカルファイルを変更する前に拒否します。

## 検証とロールバック

適用候補について通常のsource検証と決定的SB3 buildを完了してから、展開ディレクトリを
transactionalに置換します。途中失敗時は元ディレクトリを自動復旧します。マージ後に
戻す場合は、作品側の移行commitをrevertし、旧ID・旧成果物・旧provenanceを同時に戻します。
