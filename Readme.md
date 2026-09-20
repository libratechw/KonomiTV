# KonomiTV dogfood 統合検証環境

日常視聴環境で複数の改善候補を横断的に検証・評価するための統合リポジトリです。本環境は upstream への一括取り込みをそのまま推奨するものではなく、動作実績と課題の切り分けを蓄積するための検証用ブランチです。

## リポジトリとブランチ構成
- KonomiTV: [`dogfood/integration`](https://github.com/libratechw/KonomiTV/tree/dogfood/integration)
- DPlayer: [`dogfood/integration`](https://github.com/libratechw/DPlayer/tree/dogfood/integration)
- mpeg2toh264: [`candidate/combined-improvements`](https://github.com/libratechw/mpeg2toh264/tree/candidate/combined-improvements)

※現在の配備構成およびビルドコミットは、外部の配備マニフェストファイルを正本として管理・追跡しています。更新対象は通常視聴環境（ポート7016等）であり、本番（production）や録画バックエンドの設定は変更しません。

## 統合されている修正・機能

### 1. DPlayer / 再生制御の改善
- **ライブ同期ガード**: `sync()` 計算時に非有限値（`NaN`、`Infinity`）や負値が発生した場合に `video.currentTime` への代入を除外（iPad Safari等の開始直後の停止防止）。
- **旧videoイベント・拒否プロミスの干渉防止**: 画質切替時に旧video要素から遅延発火するイベントや拒否プロミスが新videoの状態を上書きしないよう保護。
- **画質切替時の再生意図引き継ぎ**: native `video.paused` ではなく論理状態（`this.paused`）を参照し、再生継続の意図を新videoへ維持。
- **film状態・エラー表示**: 後述のGPU film動作状態および障害発生時の復帰状況をプレイヤーUI上に表示（[`candidate/film-status`](https://github.com/libratechw/DPlayer/tree/candidate/film-status)）。

### 2. KonomiTV 本体の改善
- **Native error handlerの重複登録防止**: 画質切替ごとの多重登録を防ぎ、現行世代のvideo要素と再生backendのみを処理。
- **GPU film移行とフォールバック**: 24fps設定時にGPU filmを明示選択。ライブラリからのfilm系障害通知を受けた場合にGPU要求を解除し、CPU autoFilmへの復帰を試みる（[`candidate/gpu-film-migration`](https://github.com/libratechw/KonomiTV/tree/candidate/gpu-film-migration)）。
- **Safari録画におけるメインスレッドMSE経路の保持**: 既存のMSE経路を維持。
- **AMD VCE（Windowsネイティブ環境）**: 実機環境における稼働確認用設定の保持。

### 3. mpeg2toh264（新統合ライブラリ）
- **otya128上流完全取込**: MBAFF対応、変換処理最適化、GPU film、描画周期と表示予定時刻に基づく新スケジューラを取り込み、KonomiTV向けAPIを維持（[`candidate/full-upstream-take`](https://github.com/libratechw/mpeg2toh264/tree/candidate/full-upstream-take)）。
- **追加改善3件の統合**: CPU IVTC comb score行参照最適化、TSパケット欠落検知時の完成ピクチャ保持、録画終端HTTP 416時の正常EOF完了処理を統合。

### 過去版におけるTVライブ再生・同期の回帰実績
以前の固定スナップショット環境において、TVライブOriginal再生での「一時停止（10秒以上維持）→ 再生再開 → 時刻進行」の一連動作を、主要端末（Windows / Mac / Linux / POCO / Galaxy）で確認しています（Galaxy低遅延ONでの10秒維持・10サンプル、Linux環境での約10秒維持・66サンプル・MPEG-TS PSIイベント処理・正常クリーンアップ等）。これらは同期ガードや論理paused保持の基礎動作を検証した過去の記録であり、現行の更新配備（`4477647`）における全端末再走や視聴体感・A/V同期を一律に保証するものではありません。

## 現在の検証状況と確認待ち項目
- **最終配備版 `4477647`**: POCOで録画Originalの一時停止5秒・60秒シーク・再開後45秒進行・設定復元・終了処理を確認。Linux実デスクトップでは33秒進行・1920×1080キャプチャ・主要画面表示を確認しました（未捕捉例外0件）。
- **先行ビルド `fc92834`**: Windows Chrome・Mac Safariで録画pause/seek/playと約30秒進行、POCOでLive Original低遅延ON/OFF各30秒進行を確認。同じmpeg2toh264・DPlayerですが、別依存のmpegts.jsのキャッシュ不一致を後で修正したため、最終版の全端末再試験とは扱いません。
- 以上は機械確認であり、視聴品質やA/V同期の評価ではありません。iPad Airは信頼後も自動化初期化で停止し、製品再生は未確認です。
- **検証待ちの主な課題**:
  1. iOS（iPhone / iPad）環境における初期再生開始時の挙動および実機表示安定性の詳細検証。
  2. 長時間連続再生時の安定性、可聴音声・A/V同期、および字幕表示の検証。
  3. 各種ブラウザ（Safari、Firefox、Chrome）間での機能差分・描画品質の継続追従。

## ビルド再現性と成果物照合

依存をコミットハッシュ固定のGit URLで指定し、インストールされたライブラリdist（mpeg2toh264全41ファイル・DPlayer全50ファイル）を対象コミットと照合しました。最終統合版はクリーン再ビルド・コミット済みdist・7016配信物の全236ファイルがbyte一致。②単独のクライアントは他235ファイルが一致し、`sw.js`のみprecache配列の順序差があります（URL/revision全234件と残りのコードは同一）。

## 安全な操作境界

- 測定で作成したタブ、process、forward、設定だけを操作し、終了時にその範囲を清掃・復元します。
- production:7000、録画データ、ユーザーのタブ・ジョブ・processは操作しません。
- 切戻し先を配備マニフェストに保存し、healthと配信bundleを照合します。healthだけを再生成功の根拠にはしません。
