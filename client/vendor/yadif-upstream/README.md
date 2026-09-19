# vendored @mpeg2toh264/yadif (Canvas scheduler)

## 何をしているか

KonomiTV の `mpeg2toh264/yadif` だけを、このディレクトリのバンドルへ差し替える
(`client/vite.config.mts` の `resolve.alias`)。変換側 (`mpeg2toh264/player` と
同梱 wasm) は `client/package.json` の固定 commit のまま変更しない。

差し替える理由は、配布中の fork の yadif に、フレーム提示を
`expectedDisplayTime` で予定するスケジューラーが入っていないこと。現在の
KonomiTV は Deinterlacer 内蔵 Canvas をそのまま表示経路にするため、この
スケジューラーが Original 画質のなめらかさを決める。

## 由来 (正本)

- リポジトリ: https://github.com/libratechw/mpeg2toh264
- commit: `fix/yadif-runtime-20260919` の tip (= 下の `build.sh` に記載)
  - 元は https://github.com/otya128/mpeg2toh264 `867587d` (packages/yadif)
  - 追加修正: canvas owner window に rAF ループを追従 (PiP)、使えない
    `expectedDisplayTime` の棄却、`capture()`、`autoFilm` 別名なしの `film`
- ビルド: `npm run build --workspace @mpeg2toh264/yadif` (vite build + tsc)

## 再生成

手で patch を当てない。`build.sh` が固定 commit を取得してビルドし、`index.js`
と型定義をこのディレクトリへコピーする。

```
client/vendor/yadif-upstream/build.sh
```

## 暫定であること

これは依存更新までの隔離経路で、恒久構成ではない。依存先の commit が
公開されたら `client/package.json` を更新し、このディレクトリと alias、
`client/tsconfig.json` の `paths` を削除する。それまでは
`client/tsconfig.json` の `paths` で型もこのバンドルへ揃えてある
(install 済み package の型は `autoFilm` のままのため)。