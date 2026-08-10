# `--project-assets`: project asset追加build入力

`--project-assets`は、展開済みSB3 sourceを編集せず、生成するSB3にStage backdrop、sprite costume、
stage／sprite sound、新規spriteを追加するためのbuild入力です。JSONとYAMLを使用できます。

```bash
sb3-toolchain check app \
  --project-assets stories/my-story/project-assets.yml \
  --allow-asset-root resources

sb3-toolchain build app \
  --project-assets stories/my-story/project-assets.yml \
  --allow-asset-root resources \
  --output dist/my-story.sb3
```

`check`はSB3を書き出さず、base sourceとproject assetsをメモリ上で合成して検証します。`build`だけが
出力SB3を生成します。どちらもbase sourceの`project.source.json`、`sb3-source.json`、`assets/`を
変更しません。

## YAML形式（推奨）

`.yml`または`.yaml`は、DSL 4.0の`assets:`と同様に、asset IDをmapping key、`kind`をasset種別として
記述します。新規spriteの表示属性だけを`sprites:`へ分離します。

```yaml
formatVersion: 1

sprites:
  Princess:
    layerOrder: 6
    visible: false
    x: 4
    y: -16
    size: 70
    direction: 90
    draggable: false
    rotationStyle: all around
    volume: 100

assets:
  Princess:
    kind: costume
    target: Princess
    file: ../../resources/Princess.png
    bitmapResolution: 2
    rotationCenterX: 507
    rotationCenterY: 507
    license: 'CC-BY-SA-4.0: ../../LICENSES.md'

  DragonCastle:
    kind: backdrop
    file: ../../resources/DragonCastle.svg
    rotationCenterX: 240
    rotationCenterY: 180

  OpeningSound:
    kind: sound
    file: ../../resources/OpeningSound.mp3

  PrincessVoice:
    kind: sound
    target: Princess
    file: ../../resources/PrincessVoice.wav
```

- `backdrop`は常にStageの`costumes`へ追加します。`target`は指定しません。
- `costume`は`target`で指定したspriteの`costumes`へ追加します。
- `sound`は`target`省略時にStage、指定時にそのspriteの`sounds`へ追加します。
- 既存spriteへ追加する場合、そのspriteを`sprites:`へ重ねて宣言する必要はありません。
- 新規spriteは`sprites:`で宣言し、`assets:`から1件以上のcostumeを割り当てます。
- asset ID（例: `Princess`）がScratch内のcostume／backdrop／sound名になります。別名にする場合だけ
  `name`を指定します。

YAMLは1.2として解釈します。duplicate key、複数document、anchor、alias、merge key、custom tag、
`__proto__`／`constructor`／`prototype` keyを拒否します。YAMLコメントは使用できます。

## JSON形式

`.json`はYAMLと同じfield構成です。次は上のPrincess部分と等価です。

```json
{
  "formatVersion": 1,
  "sprites": {
    "Princess": {
      "layerOrder": 6,
      "visible": false,
      "x": 4,
      "y": -16,
      "size": 70,
      "direction": 90,
      "draggable": false,
      "rotationStyle": "all around",
      "volume": 100
    }
  },
  "assets": {
    "Princess": {
      "kind": "costume",
      "target": "Princess",
      "file": "../../resources/Princess.png",
      "bitmapResolution": 2,
      "rotationCenterX": 507,
      "rotationCenterY": 507
    }
  }
}
```

JSONでもduplicate keyを拒否します。`.json`、`.yml`、`.yaml`以外の拡張子は受け付けません。

## 編集用の通常モード

画像を描き直したり、音声を録り直したりしながら同じファイルへ上書きする場合、`size`と`sha256`は
記述しません。`file`の現在のbyte列を正本として、buildごとにScratch用MD5 `assetId`を再計算します。

画像では次を指定します。

| field                                | 必須            | 内容                              |
| ------------------------------------ | --------------- | --------------------------------- |
| `kind`                               | 必須            | `backdrop`または`costume`         |
| `target`                             | costumeだけ必須 | 追加先sprite名                    |
| `file`                               | 必須            | manifestからの相対path            |
| `rotationCenterX`, `rotationCenterY` | 必須            | Scratchの回転中心                 |
| `bitmapResolution`                   | 任意            | `1`（既定）または`2`              |
| `name`                               | 任意            | Scratch内の名前。省略時はasset ID |

音声では通常、`kind: sound`と`file`だけで足ります。open-sourceの`music-metadata`を使ってMP3／WAVを
解析し、`rate`と`sampleCount`を自動取得します。sprite soundだけは`target`も指定します。`dataFormat`は画像・音声ともfile拡張子から
取得します。

## 配布用のstrict lock

再現対象の入力byte列を固定する場合だけ、次のfieldを追加します。fieldごとに独立して検証するため、
必要なものだけ指定できます。

```yaml
assets:
  Princess:
    kind: costume
    target: Princess
    file: ../../resources/Princess.png
    rotationCenterX: 507
    rotationCenterY: 507
    size: 220534
    sha256: e9d1857528a619e4a56ebd232fea4767fd6bdd00b20ac67a90c859c6b3598e83
    dataFormat: png
```

| strict field          | 検証内容                               |
| --------------------- | -------------------------------------- |
| `size`                | fileのbyte数と一致すること             |
| `sha256`              | fileのSHA-256と一致すること            |
| `dataFormat`          | file拡張子から得たformatと一致すること |
| `rate`, `sampleCount` | 音声から自動取得した値と一致すること   |

指定していないstrict fieldは不一致判定に使用しません。`license`は任意の1行の出典・ライセンス情報として
検証しますが、Scratchの`project.json`にはコピーしません。

同じbase source、manifest、asset byte列、toolchain versionからはbit-for-bit同一のSB3を生成します。
通常モードでasset fileを上書きすれば、次のbuild結果が変わるのは意図した動作です。配布時に意図しない
上書きを検出する必要があれば`size`と`sha256`を指定します。

## pathと入力の安全性

asset fileは既定でmanifest directory内に限定します。共有素材directoryを参照する場合だけ、
repeatableな`--allow-asset-root`で明示的に許可します。

```bash
sb3-toolchain build app \
  --project-assets stories/my-story/project-assets.yml \
  --allow-asset-root resources/images \
  --allow-asset-root resources/sounds \
  --output dist/my-story.sb3
```

絶対path、許可rootからの逸脱、symlink経由、通常file以外、拡張子と指定`dataFormat`の不一致、既存の
target／costume／backdrop／sound名との衝突はfail-closedで拒否します。manifest自体は1 MiB以下の
通常fileである必要があります。

## JavaScript API

CLIと同じ入力を`createDeterministicSb3`または`buildSb3`へ渡せます。

```js
await createDeterministicSb3('app', {
  projectAssetsPath: 'stories/my-story/project-assets.yml',
  allowedAssetRoots: ['resources'],
});

await buildSb3({
  sourceDirectory: 'app',
  projectAssetsPath: 'stories/my-story/project-assets.yml',
  allowedAssetRoots: ['resources'],
  outputPath: 'dist/my-story.sb3',
});
```

`projectAssetsPath`を指定しなければ、project assetを追加しない従来のbuildへ戻ります。
