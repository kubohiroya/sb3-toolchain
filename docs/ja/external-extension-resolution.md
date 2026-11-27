# 外部拡張の取得と標準ソースビルド

対象: [Issue #103](https://github.com/kubohiroya/sb3-toolchain/issues/103)。既存の GitHub／npm managed source と形式 1 の作品フォルダは引き続き読める。追加の API は利用者による取得・ビルド操作から呼び出す。

## 公開済み成果物（Web／Node）

```ts
import {
  resolvePublishedExtension,
  lockPublishedExtension,
} from '@kubohiroya/sb3-toolchain/web-distribution';

const candidate = await resolvePublishedExtension('@outside-editor/sample@latest');
const lock = lockPublishedExtension(candidate);
// Keep candidate.bytes and lock together. This is not permission to execute the extension.
```

- npm の exact 版・dist-tag（省略時 `latest`）、GitHub の Release タグ URL、リポジトリ URL を受け付ける。npm scope や Plus カタログへの登録を条件にしない。
- 操作開始時に正確な版／Release と commit を解決する。再取得時は前回の `candidate.source` を `expectedSource` に渡す。移動した tag、差し替えた asset、削除、integrity の変化は停止する。
- npm archive の SHA-512 と、descriptor が指す JS／API のサイズ・SHA-256 を別々に検証する。ファイルを書き出さず、path traversal、link、重複、4,096 件を超える entry を拒否する。取得 16 MiB・展開 48 MiB の上限もある。
- GitHub は Release asset の ID・名前・digest と、確定 commit の `dist/` から取得した実バイト列を照合する。asset の直接ダウンロードへの対応を意味しない。Release に対応する `dist/` が commit に存在しない場合は利用できない。
- Web のリポジトリ入力は最新の安定版 Release のみを対象にする。npm の repository／homepage 文字列から配布元の同一性を推定しない。Web からソースビルド、localhost、外部ビルドサービスへの経路はない。
- `apiBytes` は検証した API manifest の元バイト列。更新比較には既存の `parseExtensionApiManifest` と `compareExtensionApiManifests` を使える。ID が変わる場合は既存の ID 移行手順も必要であり、lock の ID だけを書き換えてはいけない。

## Desktop の標準ソースビルド（Node 専用）

```ts
import {
  resolveGitHubExtensionSnapshot,
  runStandardExtensionBuild,
} from '@kubohiroya/sb3-toolchain/standard-extension-build';
import {lockStandardExtensionBuild} from '@kubohiroya/sb3-toolchain';

const snapshot = await resolveGitHubExtensionSnapshot('https://github.com/outside-editor/sample', {
  ref: 'main',
  signal,
});
const build = await runStandardExtensionBuild(snapshot.files, {
  source: snapshot.source,
  signal,
  timeoutMs: 30_000,
});
const lock = lockStandardExtensionBuild(build);
```

GitHub の ref は commit に固定してから Git tree を読む。各 blob のサイズと Git object hash を照合し、symlink・submodule・traversal・重複・不完全な tree を拒否する。取得対象は宣言 JSON、package、lockfile と `src/` の TS／JS／JSON。外部設定を import しない。

ローカル開発では Desktop が許可したディレクトリ handle から安定した `ReadonlyMap<string, Uint8Array>` を作り、同じビルド API に渡す。この API はディレクトリの許可や watch を代行しない。パスや開発セッション承認を receipt に保存せず、ローカル入力は `local-snapshot` と内容の SHA-256 で識別する。ホストの非公開セッション ID は別に管理する。

対応 profile は Manifest 0.8.0 の `turbowarp-typescript-v1`。依存は `none` で、ソース内の静的な相対 import のみを解決する。未対応の外部依存、dynamic import、CommonJS、tsconfig、追加の profile field は任意コード実行への fallback を行わず診断する。package scripts、install／prepare／postinstall、Vite config、ソースのトップレベルコードはビルド中に実行しない。ホストの Rolldown 1.3.3 を使用し、receipt にホスト lockfile 由来の compiler archive integrity を記録する。これはインストール済み compiler 全ファイルの再検証結果ではない。

`runStandardExtensionBuild` は環境変数を限定した専用子プロセスで動作する。入力・出力上限、JS heap 上限、最大 120 秒の deadline、AbortSignal に対応し、失敗時はプロセス終了と作業用ディレクトリの削除を待ってから reject する。出力はメモリ／pipe 上にあり、完成候補を部分返却しない。`buildStandardExtension` は同じ固定 recipe の低水準 API で、詳細な compiler 診断を呼び出し側へ返す。低水準 API の signal は協調的な中断であり、強制停止には子プロセス API を使う。

**子プロセス・環境変数制限・Node heap 制限は OS 隔離ではない。** compiler の脆弱性や native memory 消費への境界、ホーム・token・作品フォルダ・Desktop profile の保護は Desktop の検証済み OS sandbox が必要。Node Permissions、worker、utility process をその代わりに扱わない。任意 recipe／plugin／lifecycle を実行する backend は提供しない。各対応 OS の隔離と native resource 制限の受け入れ検証はこの変更だけでは完了しない。

## 保存と互換性

`EmbeddedExtension.artifactLock` に `lockPublishedExtension`／`lockStandardExtensionBuild` の結果を添え、`embedded-extensions.json` の `formatVersion` を **2** にする。lock がない旧形式は **1** のまま保持する。新版 reader は両方を受け付け、形式 1 に lock が紛れた記録、未知の lock 版・field、ハッシュ不一致を拒否する。

SB3 の build は lock と API を `tw-plus/extension-locks.json` に保存する。Node の import とブラウザーの unpack は JS のバイト列を再照合し、形式 2 の metadata を復元する。receipt は出所の観測記録であり、共有作品の受取人に実行承認を引き継がない。API／descriptor も安全性の証明ではない。

lock した拡張をそのまま bundle／ID 変更すると検証済み成果物が変わるため、古い lock を維持した書き戻しは停止する。新 ID／bundle を取得・ビルドして新しい receipt を準備し、API 比較と既存の ID 移行を含む候補を検証する。元作品は既存の transaction 処理で保持する。

## 容量計測と実測

公開 resolver の `measurements` は実取得 bytes と npm 展開 bytes、ソース resolver は実取得 bytes と snapshot bytes、build は入力／出力 bytes を返す。キャッシュは持たず `cacheBytes: 0`。作業ディレクトリへファイル内容を書かないため `temporaryDiskBytes: 0`。これはディレクトリ自体の filesystem overhead や peak RAM、コンパイラー／Node の初回インストール容量を計測した値ではない。

2026-11-27 JST の検証:

- [CORS の実測記録](../evidence/issue-103-cors.json): ヘッドレス Chromium 156.0.8078.4、ブラウザー保護有効。Template 0.13.0 の npm・Release・repo の3経路が成功。asset 直接 URL の fetch は失敗した。npm 取得 367,219 bytes、展開 4,345,856 bytes、JS 2,838 bytes。
- [ソースビルドの実測記録](../evidence/issue-103-source-build.json): macOS arm64、Node 26.7.0、commit `b4cd60ecf9f2a3094dc446bf1b99dabaeb89517a`。dist を取得せず 11 入力ファイル（71,675 bytes）を2回別プロセスでビルドし、すべての出力 hash が一致。API manifest は同じ Release の hash と一致し、JS のバイト列は公開版とは異なった。他 OS・Node 版との一致は未測定。
- fixture は archive traversal／symlink／過剰 entry、blob／lock／成果物の改変、source／scripts の非実行、外部 import、並列 job、timeout／中断、SB3 往復を検証する。

再検証は `node scripts/verify-distribution-cors.mjs`。Playwright 対応のヘッドレス Chromium とネットワーク接続が必要で、結果は `tmp/cors-evidence.json` に出る。通常の対象 unit test に実ネットワークを要求しない。

## 切り戻し

新規 resolver／ビルド API の呼び出しを停止して利用側の依存を戻す。保存済み JS・API・出所 lock・元のソースは保持する。形式 2 の embedded manifest は旧 reader が明示的に拒否するため、古い reader で未知の記録を削って保存しない。rollback で対応不能な作品は新版 reader で開ける状態を保つ。
