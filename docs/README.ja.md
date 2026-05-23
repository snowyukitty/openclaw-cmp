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

ローカル installer は既存の `~/.openclaw/skills/cmp/config/state.json`、`platforms.json`、`~/.openclaw/skills/cmp/logs` を保持するため、provider の有効化状態、ローカル調整値、直近の診断ログは repo 更新で上書きされません。

手動コピー：
- `extensions/cmp` -> `~/.openclaw/extensions/cmp`
- `skills/cmp` -> `~/.openclaw/skills/cmp`
- `skills/_shared` -> `~/.openclaw/skills/_shared`

## 検証

Smoke test：

```bash
npm test
npm run doctor
```

ローカル live テスト：

```bash
npm run test:live
```

`npm run doctor` は、インストール済み CMP plugin、browser/evaluate 設定、native command 設定、チャンネル allowlist、有効化 platform、gateway 状態、直近 run trace を確認します。

## 現在の synthesis runtime

CMP は **2 パス synthesis パイプライン**を採用しています。どちらのパスも GitHub Copilot endpoint を使用します（サブスクリプション制、トークン課金なし）。

**第 1 パス — 構造 synthesis（GPT-4.1、5000 tokens）**

5 つのセクション全体を生成します：`platformViews`、`Consensus`、`Major Differences`、`Unique Additions`、および `Best Combined Answer` の初稿。

**第 2 パス — Best Combined Answer（GPT-4.1、8000 tokens 専用）**

`Best Combined Answer` 専用の独立した呼び出しです。各プラットフォームの完全な回答を受け取り、8000 tokens の専用バジェットで再執筆します。第 2 パスの出力が初稿より長く充実している場合のみ置き換えます。第 2 パスが失敗した場合は第 1 パスの初稿を保持します。

このパスの trace event は `rich_direct_answer_*` という名前にしており、GitHub Copilot synthesis を特定ベンダー経路として誤解しないようにしています。

| | モデル | Token バジェット | Fallback チェーン |
|---|---|---|---|
| 第 1 パス | `github-copilot/gpt-4.1` | 5000 | `gpt-4o` → `gpt-5-mini` |
| 第 2 パス | `github-copilot/gpt-4.1` | 8000 | `gpt-4o` → `gpt-5-mini` |

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
