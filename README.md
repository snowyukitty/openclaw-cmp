# OpenClaw CMP

Multi-AI comparison workflow for OpenClaw.

This package contains:
- `extensions/cmp`: the live CMP plugin command implementation
- `skills/cmp`: the CMP runbook, scripts, config, and references

## What CMP does

- Registers `/cmp` as a real OpenClaw command
- Sends the same question to multiple browser-backed AI platforms
- Waits for terminal completion on each platform
- Extracts and validates each answer
- Synthesizes a final comparison with an AI model
- Preserves diagnostics when a provider or synthesis step fails

## Current synthesis runtime

- Primary synthesis provider: GitHub Copilot compatible endpoint
- Primary model: `gpt-4o`
- Fallback model: `gpt-5-mini`

## Repo layout

```text
extensions/cmp/
skills/cmp/
tests/
```

## Local validation

```bash
npm test
```

## Install into OpenClaw

Copy:
- `extensions/cmp` -> `~/.openclaw/extensions/cmp`
- `skills/cmp` -> `~/.openclaw/skills/cmp`

Then restart the gateway:

```bash
openclaw gateway restart
```
