---
name: cmp
description: "Multi-AI comparison engine. Use when the user invokes /cmp to send one question through the managed browser to ChatGPT, Claude, Gemini, and Grok, then synthesize a final answer from the completed platform outputs."
version: 2.0.0
user-invocable: false
metadata: {"openclaw":{"emoji":"🔄","requires":{"config":["browser.enabled","browser.evaluateEnabled"],"os":["darwin"]}}}
---

# CMP

This skill is the internal runbook for the `cmp` plugin command.

## Real Platform UX

- `/cmp <question>`
- `/cmp-status`
- `/cmp-on <platform|all>`
- `/cmp-off <platform|all>`

Telegram native aliases:

- `/cmpstatus`
- `/cmpon <platform|all>`
- `/cmpoff <platform|all>`

The live `/cmp` command is owned by the cmp plugin, not by this skill directly.

## Product Contract

`/cmp` is not a stitched report builder.

The correct behavior is:

1. Ask every enabled platform the same question.
2. Wait until each platform either finishes, fails, times out, or becomes unusable.
3. Extract the full usable answer from each platform.
4. Clean and validate each extracted answer.
5. Aggregate usable answers and unusable/failure metadata separately.
6. Send the original question plus the full usable cleaned answers into the local agent-model synthesis stage. Prefer the embedded agent runtime over raw gateway chat-completions when available.
7. Let the agent model own:
   - per-platform summaries
   - consensus
   - major differences
   - genuinely useful unique additions
   - the direct answer to the user
8. Render that structured synthesis into clean Discord/Telegram delivery without rewriting the synthesis content.

Do not:

- clip the first visible text and call it a summary
- truncate cleaned platform answers before the final synthesis stage unless the platform output is technically unusable
- hard-cut the final Discord/Telegram reply with a transport suffix
- build the final answer from stitched fragments
- let the renderer invent comparison content
- synthesize before every enabled platform has reached a terminal state
- let platform failures dominate the main presentation
- output placeholder text like `退化輸出`, `保底資訊`, or `差異分析未完成`

The old fixed output template is obsolete.

## Prerequisites

Before browser automation, verify:

1. The gateway-managed browser is running and logged in for the target sites. On installs where the interactive CLI still exposes it, `openclaw browser status --json` should report `running: true`.
2. The user is already logged into each target site in the managed browser.
3. `browser.evaluateEnabled` is enabled in `~/.openclaw/openclaw.json`.

If the interactive shell does not expose `openclaw browser ...`, use `python3 {baseDir}/scripts/doctor.py` plus the latest `logs/last-run.json` browser trace instead.

Never type credentials or attempt login flows.

Read only the files needed for the task:

- `{baseDir}/config/platforms.json`
- `{baseDir}/config/state.json`
- `{baseDir}/references/platform-quirks.md` only when platform-specific behavior is relevant
- `{baseDir}/references/user-guide.md` for operator/user UX
- `{baseDir}/references/runtime-architecture.md` for runtime maintenance

Helper commands:

- `python3 {baseDir}/scripts/state.py status`
- `python3 {baseDir}/scripts/state.py enabled --json`
- `python3 {baseDir}/scripts/state.py set <platform> on|off`
- `python3 {baseDir}/scripts/state.py set-all on|off`
- `python3 {baseDir}/scripts/doctor.py`

Run logs:

- `{baseDir}/logs/last-run.json`
- `{baseDir}/logs/cmp.log`

## Execution Rules

- Use the managed browser snapshot tooling for discovery when it is available in the current runtime.
- Re-snapshot after interactions that invalidate refs.
- Open a fresh conversation URL for every platform.
- After sending one platform prompt, move to the next platform instead of waiting serially for the answer.
- Wait for platform completion before final synthesis.
- Extraction and validation are input-prep stages, not summary-writing stages.
- Reject or mark unusable any answer that is wrong-topic, stale, placeholder-like, too thin, or contaminated with UI/history residue.
- Pass only usable cleaned answers to the final synthesis model.
- Use the synthesis layer to surface concrete overlap, concrete disagreements, and concrete unique contributions from the platform answers themselves.
- Preserve compact failure metadata for unusable platforms.
- Never present a success-looking comparison if no usable answers survived validation.

## Runtime Stages

### 1. Platform Runtime Stage

- Open tab
- focus
- wait for load
- detect login/session expiry
- fill prompt
- submit prompt
- record submission verification

### 2. Completion Stage

- Wait until each enabled platform is in a terminal state:
  - complete
  - timed out
  - failed
- Per-platform wait must be quality-first:
  - wait a minimum of 120 seconds before considering timeout
  - if a platform still appears to be actively streaming at 120 seconds, wait another 60 seconds
  - prefer a 3-5 minute total wait over premature synthesis
- A platform is only complete when the response has genuinely stopped generating.
- Re-check completion multiple times with delays between checks.
- Log the final completion status of every enabled platform before moving to extraction/synthesis.
- Never treat a temporarily paused stream or partially visible answer as complete.

### 3. Extraction Stage

- Extract the COMPLETE latest answer text, not the first visible block.
- Scroll, expand, and continue extraction until the full answer body is captured.
- Apply platform cleanup only after the full answer is collected.
- Validate relevance and usability.
- If the extracted text looks suspiciously short, clipped, repetitive, or ends mid-thought, retry extraction before accepting it.
- Store the full cleaned answer for synthesis. Never truncate it to save space.

### 4. Aggregation Stage

Build two collections:

- usable: platforms whose full answer was successfully extracted and is relevant to the question
- unusable: platforms that failed, timed out, or produced irrelevant/empty output

A platform answer is "usable" only if:
- It directly addresses the user's question
- It contains substantive content (not just a planning statement or one-liner)
- It is the platform's FINAL answer, not a partial/streaming fragment

Do NOT proceed to synthesis until every enabled platform has reached a terminal state.

### 5. Agent-Model Synthesis Stage

You are an AI with deep analytical capability. This stage is where you USE that capability.

You receive the original question and the full answer from each usable platform. Your job is to READ every answer thoroughly, UNDERSTAND what each says, and WRITE an original expert synthesis.

You must produce exactly 5 sections. Here is what each section must contain:

**Consensus**
Identify the specific claims, facts, conclusions, and recommendations that most or all platforms agree on. Be concrete. Name the actual shared points.
- WRONG: "共同的評估角度包括：程式/開發" (this says nothing)
- WRONG: "這些回答都在回應同一個問題" (this is obvious and useless)
- RIGHT: "所有平台都指出 AI 不會直接取代程序員，而是推動職能結構性轉變：初級重複性編碼工作將大幅減少，而系統設計、架構決策、AI 協作能力將成為核心競爭力。ChatGPT、Claude 和 Gemini 都預測未來 3-5 年內，純 coding 崗位需求下降 30-50%，但 AI-augmented 工程師的薪資和需求會顯著上升。"

**Major Differences**
Where do platforms disagree or take meaningfully different analytical approaches? Name the platform and describe the specific difference.
- WRONG: "ChatGPT 的側重不同，特別提到 執行環境" (this is a content-free sentence)
- RIGHT: "ChatGPT 較為樂觀，認為 AI 將創造比它消滅更多的新職位類型（如 prompt engineer、AI ops）；Claude 則更謹慎，強調轉型期的結構性失業風險，特別是對 3-7 年經驗的中層工程師衝擊最大；Gemini 獨特地從企業成本角度切入，預測中小企業將率先用 AI 替代外包開發團隊。"

**Unique Additions**
What genuinely interesting insight did only ONE platform provide? Must be specific and valuable.
- WRONG: "ChatGPT 額外補充了 執行環境" (meaningless)
- RIGHT: "Gemini 獨特地指出了一個反直覺趨勢：隨著 AI 降低開發門檻，軟件項目總量會爆炸性增長，反而在中期（2027-2029）創造更多而非更少的技術崗位需求 — 只是這些崗位要求的技能組合完全不同。"

**Best Combined Answer**
Write a complete, detailed, standalone answer to the user's question. This is your main deliverable. Requirements:
- This must be the LONGEST section (minimum 400 words for any non-trivial question)
- Write it as if YOU are an expert directly answering the user — not summarizing other answers
- Structure it with clear sub-points or paragraphs
- Include specific facts, examples, predictions, and reasoning from all platforms
- The user should be able to read ONLY this section and get a comprehensive, satisfying answer
- Match the user's language (Chinese question → Chinese answer)

**Platform Views**
For each usable platform, write a 4-8 sentence summary capturing the key points and conclusion of that platform's FULL answer. Write this summary yourself — do NOT copy-paste or clip the original text.
- WRONG: copying the first paragraph of the platform's answer verbatim
- WRONG: "主要整理了 X、Y、Z 這幾個面向" followed by copied text
- RIGHT: A genuine summary written in your own words that captures the essence of the full answer

For failed platforms, write one line: "[Platform]: 回答未能成功生成（[reason]）"

CRITICAL RULES:
- Do NOT use any pre-written template or fallback text. Every word must be freshly generated based on the actual platform answers you received.
- Do NOT write meta-commentary about the comparison process itself. Write about the CONTENT.
- Do NOT truncate, clip, or copy-paste from platform answers. Summarize in your own words.
- If a platform's extracted text starts with planning/thinking statements (like "識別語言偏好並籌劃專業回應策略"), skip those and use only the actual answer content.

### 6. Rendering Stage

Delivery rules:
- Send the complete synthesis to the user. Never truncate.
- If output exceeds Discord (2000 char) or Telegram (4096 char) limits:
  - Split at section boundaries into multiple messages
  - Message 1: Consensus + Major Differences + Unique Additions
  - Message 2: Best Combined Answer
  - Message 3: Platform Views
- Each split message must be self-contained and readable.
- Never append metadata, file paths, or truncation notices.
- The renderer must NOT modify, summarize, or rewrite the synthesis content. It only handles layout and delivery.

## Output Principles

- Every section must contain SPECIFIC, SUBSTANTIVE analysis of the actual platform answers. Generic filler is forbidden.
- "Best Combined Answer" is the primary deliverable and must be comprehensive and detailed.
- Match the user's language throughout the entire output.
- Format for Discord/Telegram readability:
  - Use **bold** for section headers
  - One blank line between sections
  - Bullet points for lists of distinct points
  - Short paragraphs (2-4 sentences) for mobile readability
  - Tables when comparing structured data
  - Sub-headers or numbered points within long sections
- Never truncate content to fit message limits. If the output exceeds the platform character limit, split into multiple messages at section boundaries.
- Never show file paths, log locations, or "[Response truncated...]" messages to the user.
- Never use pre-written template phrases. Every output must be unique to the question asked.

## Recovery

When command registration or delivery breaks:

1. `openclaw gateway restart`
2. `python3 {baseDir}/scripts/doctor.py`
3. `tail -n 200 /tmp/openclaw/openclaw-$(date +%F).log | rg 'cmp|native command|Telegram|Discord'`
4. In Telegram groups, verify `channels.telegram.groupAllowFrom` if `groupPolicy` is `allowlist`.

## Maintenance Notes

- Treat `{baseDir}/references/runtime-architecture.md` as the detailed source of truth for runtime stages, trace semantics, and file ownership.
- Treat `{baseDir}/references/user-guide.md` as the operator-facing guide.
- Do not reintroduce the obsolete stitched-template section list into docs or implementation.
