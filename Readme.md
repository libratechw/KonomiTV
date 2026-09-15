# KonomiTV dogfood/integration

`dogfood/integration` は、複数の修正候補を組み合わせて日常利用に近い条件で検証するための統合ブランチです。上流へそのまま取り込む完成版や production 環境ではありません。

## ブランチと配備マニフェスト

- ブランチ: `dogfood/integration`
- 配備マニフェストに記録された識別子:
  - KonomiTV: `e6d9cf704`
  - DPlayer: `2499f05`
  - mpeg2toh264: `1e0eb608`

マニフェストの識別子とブランチの作業状態は別に管理します。READMEの更新だけでは配備中のイメージやbundleは変わりません。

## 現在確認している範囲

### Live pause / resume（PLAYBACK-LIVE-002）

Live Original の pause → hold → 1回の明示的な play → 進行を、共通入口の有界試験で確認しています。Windows Chrome、Mac Safari、Linux Chrome、Android POCO、Galaxy `SM-X930` の要求経路・進行・owned cleanupは各runへ分けて記録しています。Galaxyの最新runは低遅延ON、10秒hold、同一documentのまま10サンプルが進行しました。Linuxの最新run `20260915t105317881597z-linux-live-pause-hold10-resume` では、10.004秒hold、66サンプル、MPEGTS/events/PSI HTTP 200、owned Chrome cleanupを確認しました。

この結果は、物理表示・音声・A/V同期、すべての端末、微細なカクつき、長時間品質の保証ではありません。iPad mini/Airの最新Appium/WDA試行は、RemoteXPC 8111拒否・automation-mode timeout・`xcodebuild` code 65でタブ到達前に停止したため、製品失敗とは分類していません。

### DPlayer Live Original同期ガード

DPlayerの非有限・負の同期先を`currentTime`へ渡さない候補は、Live pause/resumeとは別の修正候補です。配備マニフェストに明記されない候補を、配備済みイメージへ反映済みとは扱いません。

## 安全な操作境界

- 測定で作成したowned tab、process、forward、設定だけを操作し、終了時にその範囲を清掃・復元します。
- `production:7000`、録画データ、ユーザーのタブ・ジョブ・processは操作しません。
- ロールバックは配備マニフェストの対象へ戻し、healthとserved bundle hashを確認します。サービスhealthだけを再生成功の根拠にはしません。

詳細な実行条件とraw evidenceは、非公開の運用結果および各担当QUEUEを参照してください。機微情報、認証情報、録画本文はこのREADMEへ記載しません。
