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

## 補足

- Claude の free account では制限が出ることがありますが、CMP は他の成功 provider で継続する想定です。
- 中国語の質問では、synthesis に繁體中文を優先させ、簡体字を避けるよう指示しています。
- ブラウザ型 provider は UI 変更やログイン/session 状態の影響を受けることがあります。

## ライセンス

[MIT](../LICENSE)
