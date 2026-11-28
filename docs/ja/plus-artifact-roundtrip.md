# lock 付き Plus SB3 のソース往復

対象は [Toolchain #103](https://github.com/kubohiroya/sb3-toolchain/issues/103)、保存側の依存契約は [Loader PR #55](https://github.com/kubohiroya/turbowarp-extension-loader/pull/55)。ブランチは `feat/extensions/plus-lock-roundtrip`、base は main `9db6c7e`。

## 対応する範囲

Loader が形式1の成果物 lock を保存した Plus SB3 を、browser の `unpackSb3`／`validateSourceFiles` と Node の `importSb3`／`createDeterministicSb3` で扱う。既存 inventory の読み取り契約を pure module へ分離し、browser と共有する。取得・依存 install・拡張 JS の実行は行わない。

まず次の条件をすべて満たす部分集合を対象にする。

- Plus Manifest は schemaVersion 1、拡張は最大64件。
- 実行方式は `sandboxed`、`artifactLockFormatVersion: 1` を持ち、同じ ID の検証済み sidecar がある。
- 保存方式は `embedded-file` または `embedded-data`。file は `extensions/<id>.js` の標準パス。
- capabilities／dependencies は未指定または空。version／publisher は文字列、source URL と作品 URI は既存の HTTPS 規則で検査する。
- sidecar は Loader と同じ最大1 MiB、JS は最大8 MiB。既存の ZIP／source 上限も適用する。

unsandboxed、remote、非標準パス、未知の版・field、権限や依存を持つ Plus Manifest は明示して停止する。他の Plus 形式まで対応済みとはしない。Plus Manifest のない既存 SB3 の経路を維持する。

## 保存方式と lock を保持する方法

raw SB3 の file carrier は専用の拡張ファイルとして読み、assets に混ぜない。ソース内は既存の `embedded-extension:extensions/<id>.js` を使い、元の Manifest を保持する。再ビルドでは Manifest の保存方式に従い、file は同じ ZIP path、data は data carrier へ戻す。保存方式を自動変換しない。

Manifest、JS hash、API JSON、出所 receipt、実行方式、sidecar の ID を共有 validator で照合する。orphan lock、欠落、重複、改変、ソースの archiveEntries からの file 脱落を拒否する。source の展開後・Node read 後・bundle 後にも照合し、古い receipt を新しいコードに流用しない。

Manifest とプロジェクトの既存 field を保持する。新しい保存形式を追加せず、source 形式1／2と lock を持つ embedded manifest 形式2を使う。旧 browser reader は Plus Manifest を拒否する。旧 Node reader についても、検証なしに新形式を書き戻せると扱わない。記録は実行承認ではなく、受取人の確認や開発 session の権限を継承しない。

## 受け入れ基準と検証

- [x] file／data の両方で manifest・保存方式・JS・API・receipt を保持して browser 展開→Node import/build→再展開できる。
- [x] 再 import/build の2回目の archive が一致する。
- [x] 未知の形式、marker 欠落、unsandboxed、remote、非標準 path、capabilities／dependencies、コード／lock／manifest 不一致を拒否する。
- [x] 取得や拡張 JS の実行をせず、拒否時も入力 archive を変更しない。
- [x] 関連27テスト、型チェック、変更ファイルの lint／format、build が成功。
- [x] 公開 Template の固定 commit→実標準 compiler→Loader #55 の追加 API→新 Toolchain の往復→Loader の再読込が両保存方式で成功。
- [x] 実 Chromium の headless 検証で両保存方式を展開し、出所 commit を保持。通信を全遮断し、Node／compiler／process runner の graph と `process`／`require` global がない。
- [ ] GitHub 入力・導入確認 UI、Desktop job の Loader 接続、公開版と製品 pin／renderer／配布物の統合、他の Plus 保存・実行方式。

[Node／Loader の証跡](../evidence/plus-loader-roundtrip.json)、[browser の証跡](../evidence/plus-browser-roundtrip.json)。Template 0.13.0 の commit `b4cd60ecf9f2a3094dc446bf1b99dabaeb89517a` と Loader #55 の head `2c70c09` を使用した。Node 26.7.0、macOS arm64、Rolldown 1.3.4。製品 renderer・画面付き Electron・新しい DMG の検証とは区別する。承認回数2は fixture の trust provider 呼出回数で、公開作品の実行承認ではない。

```sh
pnpm exec vitest run test/plus-extension-roundtrip.test.ts test/browser-unpack.test.ts \
  test/extension-artifact-lock.test.ts test/extension-digest-inventory.test.ts
pnpm typecheck
pnpm build
SB3_TOOLCHAIN_LOADER_ROOT=/absolute/path/to/trusted-built-loader \
  node scripts/verify-plus-loader-roundtrip.ts
SB3_TOOLCHAIN_LOADER_ROOT=/absolute/path/to/trusted-built-loader \
  node scripts/verify-plus-loader-browser.mjs
```

再現用 Loader checkout は #55 を含む信頼するコードから build し、その開発依存の JSZip／esbuild／Playwright と Chromium を準備する。拡張の source directory を tooling root に指定しない。Node 検証は公開 GitHub の固定 source を取得する。browser 検証は Node 検証が `dist/plus-loader-fixtures/` に生成した SB3 と今回の browser entry を使い、外部通信を遮断する。

## 切り戻しと残条件

新しい Plus ソース往復の利用・生成を止め、元 SB3・source・JS・API・Manifest・receipt を保持する。旧版へ戻す場合は未対応として停止し、Manifest や lock を削除して受理させない。実行許可や URL 取得の fallback は作らない。

この差分は公開前の実装と検証であり、現在の公開版0.31.3の未対応動作は変更しない。Loader #55 の固定0.31.3に対する否定テストは、その版の結果として扱う。統合時は公開版を固定してテストを更新する。#103 は残る DoD とともに open を維持する。
