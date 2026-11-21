# METEOR CANYON

ガウシアンスプラットで撮ったガンプラを操り、隕石と彗星をかわしながら宇宙の奥へ飛ぶブラウザゲーム。

**遊ぶ:** https://fumiakim.github.io/test_splat_game/

## 操作

| 操作 | キーボード | タッチ |
|---|---|---|
| 移動 | ← → ↑ ↓ / W A S D | 画面をドラッグ |
| ブースト | Space（長押し） | BOOST ボタン |
| ポーズ | P / Esc | — |
| 音のオン・オフ | M | SOUND ボタン |

ゲームパッドも使えます。

## URL のオプション

- `?rocks` — 隕石の形（7 種類）と大きさ（4 階級）の見本。Space・クリックでページ切り替え
- `?canyon` — 渓谷の中を飛ぶ旧モード

## つくり

- `index.js` / `index.sog` / `settings.json` — SuperSplat Viewer の書き出し（PlayCanvas）
- `game.js` — ゲームの進行・操作・カメラ
- `world.js` — 隕石・彗星の出現と当たり判定
- `rock-shapes.js` — 隕石の形の生成（じゃがいも型・細長い型・双子型・平たい板状・角ばった破片・クレーター型・ごつごつ塊）
- `world-gl.js` / `space-fx.js` — WebGL2 の描画（岩・光・背景の粒・スラスターの炎）
- `splat-light.js` — 自機（スプラット）のライティング（太陽・リムライト・スラスターの光・彗星の光・被弾の赤）
- `hud.js` / `audio.js` — 画面表示と効果音（Web Audio で合成）
