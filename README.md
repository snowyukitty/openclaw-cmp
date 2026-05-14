# OpenClaw CMP

Multi-AI comparison workflow for OpenClaw.

**Languages:** **English** | [繁體中文](docs/README.zh-Hant.md) | [日本語](docs/README.ja.md)

Current release: `v0.1.0`

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

Manual copy:
- `extensions/cmp` -> `~/.openclaw/extensions/cmp`
- `skills/cmp` -> `~/.openclaw/skills/cmp`
- `skills/_shared` -> `~/.openclaw/skills/_shared`

## Validation

Smoke test:

```bash
npm test
```

Live local run:

```bash
npm run test:live
```

## Current Synthesis Runtime

- Primary provider: GitHub Copilot compatible endpoint
- Primary model: `gpt-4o`
- Fallback model: `gpt-5-mini`

## Notes

- Claude may be partially limited on free accounts; CMP should continue with other successful providers.
- For Chinese questions, synthesis is instructed to use Traditional Chinese rather than Simplified Chinese.
- Browser-backed providers remain subject to UI drift and login/session constraints.

## License

[MIT](LICENSE)
