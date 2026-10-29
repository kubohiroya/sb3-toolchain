# Kamishibai作品SB3の埋め込み機能拡張を一括更新する

```sh
sb3-toolchain extensions replace-sb3 ari-kirigirisu-20161029.sb3 --output ari-kirigirisu-updated.sb3
```

`--from`を省略すると、[公式サンプルサイトの公開マニフェスト](https://kubohiroya.github.io/turbowarp-kamishibai-samples/stories/tutorial/public-surfaces.json)から
ブロック台本SB3のURLを解決し、自動取得します。公開済み状態・バージョンの整合性・ダウンロードしたSB3のサイズとSHA-256を検証してから、入力作品にある次の実装を差し替えます。

- `kubohiroyakamishibai4`: Kamishibai DSL 4.0 Runtimeを含むバンドル全体
- `kubohiroyakamishibaiauthoring4`: Kamishibai Block Script

入力に両方あれば、同じ提供元SB3から両方を更新します。片方だけなら、その機能拡張だけを更新します。提供元に必要なIDがない場合は停止します。取得したコードは実行しません。

取得するのはサンプルサイトで現在公開されているブロック台本です。開発中の候補版は使いません。アプリ本体だけが先に公開され、サンプルサイトの更新がまだの場合は、その本体版を取得できません。公開版が入力のRuntimeヘッダーに記載された版より古い場合は、自動ダウングレードを防ぐため停止します。入力にバージョンヘッダーがない場合は、新旧の比較を省略します。

提供元を手元のファイルに固定する場合は、`--from`を指定します。この場合、ネットワーク通信は不要です。明示的に古い提供元を選ぶこともできます。

```sh
sb3-toolchain extensions replace-sb3 input.sb3 --from 新版のブロック台本.sb3 --output updated.sb3
```

元ファイルを保護するため、入力と提供元は出力先に指定できません。既存の出力内容が異なる場合は、対話確認または`--yes`が必要です。検証失敗時には出力を変更しません。元の作品を開けば更新前の状態に戻れます。

変更するのは`project.json`内の対象IDの`extensionURLs`の値です。その他の機能拡張、ブロック、座標、変数、リスト、`extensionStorage`、素材、および追加のZIPエントリーは保持します。ZIPの圧縮とタイムスタンプ、`project.json`の文字列表現は再生成します。出力には提供元・公開版・SHA-256・更新対象IDを表示します。ローカル提供元にバージョンヘッダーがない場合は`unknown`と表示します。

このコマンドはDSLや保存データの移行を行いません。例えば`/assets/SafetyPose`の参照が作品の保存データに残っている場合、そのデータは保持されます。コードの置換だけでは、旧版とのDSL互換性や再生の成功を保証できません。更新後の作品をエディターで再生して確認してください。

入力・提供元の圧縮サイズは64 MiB、展開サイズは256 MiB、ZIPエントリー数は4096までです。ネットワーク取得には各30秒のタイムアウトを設け、マニフェストは1 MiBまで受け付けます。

JavaScript APIでも同じ処理を利用できます。

```js
import {replaceSb3Extensions} from '@kubohiroya/sb3-toolchain';

const result = await replaceSb3Extensions({
  inputPath: 'input.sb3',
  outputPath: 'updated.sb3',
});
console.log(result.donor, result.extensionIds);
```
