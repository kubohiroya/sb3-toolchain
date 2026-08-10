# project asset追加manifest

生成SB3にだけスプライト、コスチューム、音声を追加し、展開済みbase sourceへは書き込みたくない場合、
project asset追加manifestをビルド入力として使用します。source directory、`project.source.json`、
`assets/`は変更しません。

## manifest format 1

```json
{
  "formatVersion": 1,
  "sprites": [
    {
      "name": "Princess",
      "layerOrder": 6,
      "visible": false,
      "x": 4,
      "y": -16,
      "size": 70,
      "direction": 90,
      "draggable": false,
      "rotationStyle": "all around",
      "volume": 100,
      "costumes": [
        {
          "name": "Princess",
          "file": "assets/Princess.png",
          "size": 220534,
          "sha256": "e9d1857528a619e4a56ebd232fea4767fd6bdd00b20ac67a90c859c6b3598e83",
          "dataFormat": "png",
          "bitmapResolution": 2,
          "rotationCenterX": 507,
          "rotationCenterY": 507,
          "license": "CC-BY-SA-4.0: ../../LICENSES.md"
        }
      ],
      "sounds": []
    }
  ]
}
```

スプライトの各fieldは省略せず指定します。`costumes`には1件以上が必要です。任意の`license`は
1行の出典・ライセンス情報として検証しますが、Scratchの`project.json`にはコピーしません。音声は`name`、`file`、
`size`、`sha256`、`dataFormat`に加えて、正の整数`rate`と0以上の整数`sampleCount`を指定します。

toolchainはJSONのfield、target／asset名の重複、相対path、通常fileであること、symlinkを経由しないこと、
byte size、SHA-256、data format、Scratch metadataを検証します。Scratch用MD5 `assetId`を計算し、
content-addressed fileを1回だけ追加します。同じファイル名に異なるbyte列が衝突した場合は失敗します。

asset fileは既定でmanifestと同じdirectory内に限定します。リポジトリ内の共有素材directoryを読む場合だけ、
許可rootを明示します。

```bash
sb3-toolchain check app \
  --project-assets stories/my-story/project-assets.json \
  --allow-asset-root resources

sb3-toolchain build app \
  --project-assets stories/my-story/project-assets.json \
  --allow-asset-root resources \
  --output dist/my-story.sb3
```

JavaScript APIにも同じ入力を渡せます。

```js
await createDeterministicSb3('app', {
  projectAssetsPath: 'stories/my-story/project-assets.json',
  allowedAssetRoots: ['resources'],
});

await buildSb3({
  sourceDirectory: 'app',
  projectAssetsPath: 'stories/my-story/project-assets.json',
  allowedAssetRoots: ['resources'],
  outputPath: 'dist/my-story.sb3',
});
```

`projectAssetsPath`を指定しなければ、既存buildの挙動へ戻ります。同じ展開source、manifest、lock済み
asset byte列、toolchain versionからはbit-for-bit同一のSB3を生成します。
