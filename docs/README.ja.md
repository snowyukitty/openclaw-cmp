# OpenClaw CMP

OpenClaw 向けのマルチ AI 比較ワークフローです。

**言語:** [English](../README.md) | [繁體中文](README.zh-Hant.md) | **日本語**

## 概要

OpenClaw CMP は `/cmp` を実際の OpenClaw コマンドとして登録し、複数のブラウザ駆動 AI プラットフォームの回答を比較・統合します。

現在の対応プラットフォーム：
- ChatGPT
- Claude
- Gemini

現在の出力方針：
- `Best Combined Answer` を先頭に置く
- プレースホルダではなく実際の統合回答を返す
- 1 つの provider が失敗しても比較を継続する
- デバッグに役立つ簡潔な診断情報を残す

## 機能

- `/cmp` を実コマンドとして登録
- 同じ質問を複数プラットフォームへ送信
- 完了待ち、回答抽出、妥当性確認
- 利用可能なモデルで最終 synthesis を実行
- 一部 provider が利用不可でも継続
- raw answer と実行診断を保存
- 英語、日本語、繁體中文の出力フローをサポート

## インストール

ローカルの OpenClaw にインストール：

```bash
npm run install:local
openclaw gateway restart
```

手動コピー：
- `extensions/cmp` -> `~/.openclaw/extensions/cmp`
- `skills/cmp` -> `~/.openclaw/skills/cmp`
- `skills/_shared` -> `~/.openclaw/skills/_shared`

## 検証

Smoke test：

```bash
npm test
```

ローカル live テスト：

```bash
npm run test:live
```

## 現在の synthesis runtime

- 主要 provider：GitHub Copilot 互換 endpoint
- 主要モデル：`gpt-4o`
- fallback モデル：`gpt-5-mini`

## 完了検出の仕組み

各プラットフォームは、注入した永続 JS 状態ではなく、**ポーリングごとに実行される専用 DOM プローブ**を使用します。

- **ChatGPT / Gemini / Grok：** ポーリングサイクルごとに DOM シグナルを評価します。
- **Claude：** 同じ専用プローブパターンを使用します。Claude.ai はプロンプト送信後に `/new` から `/chat/<id>` へナビゲートするため、送信時点で保存したタブ参照が無効になります。プローブはサイクルごとに新たに評価するため、注入済み状態への依存がなく、stale reference の問題が発生しません。

CMP はレスポンスが複数回の連続ポーリングで安定してから完了と判断するため、ストリーミングの一時停止で早期終了することはありません。

## 補足

- 中国語の質問では、synthesis に繁體中文を優先させ、簡体字を避けるよう指示しています。
- ブラウザ型 provider は UI 変更やログイン/session 状態の影響を受けることがあります。
- すべての provider はログイン状態の維持が必要です。CMP はログイン操作を代行しません。

## ライセンス

[MIT](../LICENSE)
