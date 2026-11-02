# 機能拡張のdigestと保持形式を出す

```bash
sb3-toolchain extensions digests project.sb3 [another.sb3 ...] [--json]
```

SB3が自分自身について述べていることを読み、マニフェストが挙げる各機能拡張について次を出力します。

- 機能拡張のID
- 固定された`sha256`
- 作者が選んだ4つの保持形式のどれか（`remote-non-cacheable` / `remote-cacheable` /
  `embedded-file` / `embedded-data`）
- そのSB3が実際に保持しているバイト数
- 保持しているバイト列のdigest（固定値と異なる場合のみ表示）
- 記録されたURL、`embedded-file`の場合はアーカイブ内のパス
- 要求された実行モード

あわせて作品自身の`uri`を出力します。これはブラウザーのキャッシュと、開いた人の記録済みの判断が
ひも付けられる名前です。SB3を複数与えた場合は、どのdigestが複数の作品から名指され、どれが1作品だけの
ものかも出力します。

## このコマンドができないこと

**ブラウザーの保存状態は読みません。** 機能拡張のキャッシュはIndexedDBにあり、これはオリジンに属すると
同時に**ブラウザーのプロファイル**にも属します。コマンドラインからは、実行する人が実際に持っている
キャッシュには原理的に届きません。自動化されたブラウザーを新たに起動しても、誰も使っていない
プロファイルが見えるだけです。どの作品がキャッシュされているかを知っているのはブラウザーだけなので、
一覧と削除は[`kubohiroya/turbowarp-title-menu#23`](https://github.com/kubohiroya/turbowarp-title-menu/issues/23)
の画面が担います。このコマンドは、その状態と照合するための一覧を作る側です。

**到達性で何も判断しません。** 作品のURIは作者がそこに公開するまで何も返しません。保存したが未公開の
作品と、公開済みだが住所が腐った作品は見分けがつきません。SB3の中のURLには一切アクセスせず、
リクエストが失敗したことを根拠に何かを「無い」と扱うことはありません。与えなかった入力は「不明」で
あって「無い」ではありません。

## 何に使うか

1. 共通バケットに何を置くべきかの判断材料。複数の作品が名指すdigestは、作品ごとに持つのではなく
   一度だけ持つ価値のあるバイト列です。
2. title-menuの画面の「どの作品からも名指されなくなったキャッシュを消す」モードへの入力。手元の
   作品群が実際に名指すdigestの集合を渡します。
3. 作品を`remote-cacheable`から`remote-non-cacheable`に変換したあと、取り残された古いエントリーを
   見つける材料。キャッシュを持ちうるのは`remote-cacheable`だけなので、すべての入力で`cacheable`が
   falseのdigestは、もうどの作品も保持を求めていないバイト列です。作者が「残すな」と決めたのに
   ブラウザーに残り続けるなら、その判断は反故になっています。

## 出力の読み方

テキスト出力は機能拡張ごとに`key=value; ...`の1行を、続いてdistinctなdigestごとに1行を出します。
後者は複数の入力から名指されていれば`Shared`、1つだけなら`Single`と表示します。`size=not-held`は
そのSB3が参照だけを持っていて、測るべきバイト列がそこに無いという意味で、失われているのではありません。
`--json`は同じ内容をJSONで出力します。`projects`は入力順、`digests`はdigest順です。

## JavaScript API

```js
import {inventoryExtensionDigests} from '@kubohiroya/sb3-toolchain';

const inventory = await inventoryExtensionDigests(['one.sb3', 'two.sb3']);

for (const usage of inventory.digests) {
  if (!usage.cacheable) {
    // どの入力も、ブラウザーが保持しうる唯一の形式では持っていないバイト列。
    console.log(
      usage.sha256,
      usage.ids,
      usage.projects.map((project) => project.uri),
    );
  }
}
```

`inspectSb3ExtensionDigests(inputPath, contents)`は既に読み込んだアーカイブ1件を対象にします。
`readProjectManifest(project)`は、解析済み`project.json`の`turboWarpPlus`メンバーだけを検証し、
マニフェストを持たない作品では`null`を返します。4つの名前が存在する前に書かれたマニフェストは、
作者がしていない選択を勝手に補う代わりに、廃止された綴りごとに何がそれを置き換えるかを示して拒否します。

## 制限

入力は圧縮サイズ64 MiB、展開サイズ256 MiB、ZIPエントリー数4096まで、マニフェスト1件あたりの機能拡張は
64件までです。入力の重複、シンボリックリンク、`.sb3`以外のパスは拒否します。
