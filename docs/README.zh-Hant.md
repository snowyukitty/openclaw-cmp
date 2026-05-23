# OpenClaw CMP

OpenClaw 的多 AI 比較工作流。

**語言：** [English](../README.md) | **繁體中文** | [日本語](README.ja.md)

## 概要

OpenClaw CMP 會把 `/cmp` 註冊成真正的 OpenClaw 指令，並對多個瀏覽器驅動的 AI 平台做答案比較與整合。

目前支援的平台：
- ChatGPT
- Claude
- Gemini

目前輸出目標：
- `Best Combined Answer` 放在最前面
- 產出真正整合過的答案，而不是占位文字
- 單一 provider 失敗時仍可繼續整合
- 保留精簡但有用的診斷資訊

## 功能

- 把 `/cmp` 註冊成真實 OpenClaw 指令
- 對多平台送出同一問題
- 等待完成、抽取並驗證回答
- 用可用模型做最終 synthesis
- 某個 provider 不可用時仍可繼續
- 保留 raw answer 與執行診斷資訊
- 支援英文、日文、繁體中文輸出流程

## 安裝

安裝到本機 OpenClaw：

```bash
npm run install:local
openclaw gateway restart
```

本機 installer 會保留既有的 `~/.openclaw/skills/cmp/config/state.json`、`platforms.json`、`~/.openclaw/skills/cmp/logs`，以及存在時的 `~/.openclaw/extensions/cmp/.git`，因此 provider 開關、本機平台設定、近期診斷紀錄與 extension working-tree metadata 不會因更新 repo 被覆蓋。

手動複製：
- `extensions/cmp` -> `~/.openclaw/extensions/cmp`
- `skills/cmp` -> `~/.openclaw/skills/cmp`
- `skills/_shared` -> `~/.openclaw/skills/_shared`

## 驗證

Smoke test：

```bash
npm test
npm run doctor
```

本機 live 測試：

```bash
npm run test:live
```

`npm run doctor` 會檢查已安裝的 CMP plugin、browser/evaluate 設定、native command 設定、頻道 allowlist、已啟用平台、gateway 狀態與近期 run trace。

## 目前 synthesis runtime

CMP 使用**兩階段 synthesis pipeline**。兩個階段都走 GitHub Copilot endpoint（訂閱制，無 token 計費）。

**第一階段 — 結構 synthesis（GPT-4.1，5000 tokens）**

產出完整五個區段：`platformViews`、`Consensus`、`Major Differences`、`Unique Additions`，以及 `Best Combined Answer` 初稿。

**第二階段 — Best Combined Answer（GPT-4.1，8000 tokens 專屬）**

獨立的第二次呼叫，專注於撰寫 `Best Combined Answer`。接收每個平台的完整回答，使用 8000 tokens 專屬預算重新撰寫。僅當第二階段輸出比初稿更長更豐富時才替換；若第二階段失敗，保留第一階段初稿。

這個階段的 trace event 使用 `rich_direct_answer_*` 命名，避免把 GitHub Copilot synthesis 誤標成特定廠商路徑。

| | 模型 | Token 預算 | Fallback 鏈 |
|---|---|---|---|
| 第一階段 | `github-copilot/gpt-4.1` | 5000 | `gpt-4o` → `gpt-5-mini` |
| 第二階段 | `github-copilot/gpt-4.1` | 8000 | `gpt-4o` → `gpt-5-mini` |

## 完成偵測機制

每個平台都使用**獨立的逐次輪詢 DOM probe**，不依賴注入的持久 JS 狀態：

- **ChatGPT / Gemini / Grok：** 每次輪詢循環皆對 DOM 做新鮮 evaluate。
- **Claude：** 同樣使用專用 probe。Claude.ai 在提交 prompt 後會從 `/new` 導航至 `/chat/<id>`，這會使初始 tab 引用失效。Probe 在每次輪詢時重新取值，沒有注入狀態，就沒有 stale reference 問題。

CMP 要求回答在多次連續輪詢中長度穩定後，才會觸發最終 synthesis，因此 streaming 暫停不會導致提前結束。

## 備註

- 中文題目的 synthesis 會明確要求使用繁體中文，而不是簡體中文。
- 瀏覽器型 provider 仍可能受到 UI 變動與登入/session 狀態影響。
- 所有平台都需要保持登入狀態。CMP 不會代你登入。

## 授權

[MIT](../LICENSE)
