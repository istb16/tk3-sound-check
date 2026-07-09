# 音質チェッカー / Audio Quality Checker

WAV・MP3ファイルやマイク録音の音質を5軸でスコアリングするブラウザSPAです。

## 機能

- **ファイル解析** — WAV / MP3 をドロップまたはクリックして選択
- **マイク録音** — 10秒間録音してその場で解析
- **5軸スコアリング**
  | 軸 | 重み | 内容 |
  |---|---|---|
  | ノイズ (Noise) | 25% | 背景雑音の少なさ |
  | 歪み (Distortion) | 20% | 音割れ・クリッピングのなさ |
  | 残響 (Reverb) | 20% | 反響・残響のなさ |
  | エコー (Echo) | 15% | エコーのなさ |
  | 明瞭度 (Clarity) | 20% | 声の聞き取りやすさ |
- **VUメーター** — 総合スコアをアナログ風に表示
- **レーダーチャート** — 5軸を一覧で可視化
- **音声再生** — 解析後にアップロード/録音した音声を再生
- **JA/EN 切替** — ブラウザ言語を初期値とし、`localStorage` に保持

## 技術スタック

- [Svelte 5](https://svelte.dev/) + TypeScript
- [Vite](https://vite.dev/)
- [Vitest](https://vitest.dev/) + Playwright（ブラウザテスト）

## セットアップ

```bash
npm install
```

## 開発サーバー

```bash
npm run dev
```

## ビルド

```bash
npm run build
```

## テスト

```bash
npm test
```

Vitest がヘッドレス Chromium 上でブラウザテストを実行します。

## スコアの判定基準

| スコア | グレード |
|---|---|
| 70〜100 | 優秀 (Excellent) |
| 50〜69 | 良好 (Good) |
| 35〜49 | 普通 (Fair) |
| 0〜34 | 要改善 (Poor) |
