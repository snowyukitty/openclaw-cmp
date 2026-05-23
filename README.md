# OpenClaw CMP

Multi-AI comparison workflow for OpenClaw.

**Languages:** **English** | [繁體中文](docs/README.zh-Hant.md) | [日本語](docs/README.ja.md)

Current release: `v0.3.2`

## Overview

OpenClaw CMP registers `/cmp` as a real OpenClaw command and compares answers across multiple browser-backed AI platforms.

Current targets:
- ChatGPT
- Claude
- Gemini

Current output goals:
- Best Combined Answer first
- Real synthesis instead of placeholder completion text
- Graceful degradation when one provider fails
- Concise diagnostics for debugging

## Features

- Registers `/cmp` as a real OpenClaw command
- Sends the same question to multiple platforms
- Waits for completion and extracts validated answers
- Synthesizes a final comparison with an available model
- Continues when one provider is unavailable
- Preserves raw-answer diagnostics for debugging
- Supports English, Japanese, and Traditional Chinese output flows

## Example Output

```text
🔄 Multi-AI Answer Comparison
Question
請用三點比較 Python 和 Rust 在系統編程上的核心差異

Best Combined Answer
Python and Rust differ most in memory management, runtime model, and systems-level control...

Consensus
- Python uses garbage collection; Rust uses ownership and compile-time checks.
- Python is productive at higher abstraction levels, while Rust is better suited to low-level performance-sensitive work.

Major Differences
- ChatGPT emphasized Python as a control-layer language.
- Gemini put more weight on Rust's deterministic behavior and concurrency model.

Unique Additions
- Gemini added explicit performance-range comparisons.
- ChatGPT highlighted Python plus C/C++ extension patterns.
```

## Repo Layout

```text
extensions/cmp/
skills/cmp/
skills/_shared/
scripts/
tests/
docs/
```

## Install

Install into a local OpenClaw setup:

```bash
npm run install:local
openclaw gateway restart
```

The local installer preserves existing `~/.openclaw/skills/cmp/config/state.json`, `platforms.json`, and `~/.openclaw/skills/cmp/logs`, so enabled-platform state, local platform tuning, and recent diagnostics survive repo updates.

Manual copy:
- `extensions/cmp` -> `~/.openclaw/extensions/cmp`
- `skills/cmp` -> `~/.openclaw/skills/cmp`
- `skills/_shared` -> `~/.openclaw/skills/_shared`

## Validation

Smoke test:

```bash
npm test
npm run doctor
```

Live local run:

```bash
npm run test:live
```

`npm run doctor` checks the installed CMP plugin, browser/evaluate config, native command settings, channel allowlists, enabled platforms, gateway status, and recent run traces.

## Current Synthesis Runtime

CMP runs a two-pass synthesis pipeline. Both passes use the GitHub Copilot endpoint (free/flat-rate — no per-token cost).

**Pass 1 — structure synthesis (GPT-4.1, 5000 tokens)**

Produces the full five-section output: `platformViews`, `Consensus`, `Major Differences`, `Unique Additions`, and an initial `directAnswer`.

**Pass 2 — Best Combined Answer (GPT-4.1, 8000 tokens dedicated)**

A second, independent call focused entirely on `Best Combined Answer`. It receives every platform's full answer and rewrites the section with a dedicated 8000-token budget. Pass 2 only replaces the initial draft when it produces a longer, richer result; if it fails for any reason, the Pass 1 draft is kept.

Trace events for this pass are named `rich_direct_answer_*` so logs describe the role of the pass rather than implying a specific vendor.

| | Model | Token budget | Fallback chain |
|---|---|---|---|
| Pass 1 | `github-copilot/gpt-4.1` | 5000 | `gpt-4o` → `gpt-5-mini` |
| Pass 2 | `github-copilot/gpt-4.1` | 8000 | `gpt-4o` → `gpt-5-mini` |

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history.

## Roadmap

- Long-term CMP improvements are tracked in [TODO.md](TODO.md).

## Completion Detection

Each platform uses a dedicated per-poll DOM probe rather than injected persistent JS state:

- **ChatGPT / Gemini / Grok:** dedicated completion check functions evaluate DOM signals on each polling cycle.
- **Claude:** uses the same dedicated probe pattern. Claude.ai navigates from `/new` to `/chat/<id>` on submission, which invalidates the initial tab reference. The probe handles this by evaluating fresh on every cycle — no injected state means no stale-reference failures.

CMP requires a response to be stable for multiple consecutive polls before treating it as complete, so temporarily paused streaming does not trigger premature synthesis.

## Notes

- For Chinese questions, synthesis is instructed to use Traditional Chinese rather than Simplified Chinese.
- Browser-backed providers remain subject to UI drift and login/session constraints.
- All providers are subject to login/session requirements. CMP never logs in on your behalf.

## License

[MIT](LICENSE)
