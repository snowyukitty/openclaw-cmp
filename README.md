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

Run several real CMP questions against the local OpenClaw install:

```bash
npm run test:live
```

## Install into OpenClaw

Use:

```bash
npm run install:local
```

Or copy manually:
- `extensions/cmp` -> `~/.openclaw/extensions/cmp`
- `skills/cmp` -> `~/.openclaw/skills/cmp`

Then restart the gateway:

```bash
openclaw gateway restart
```

## Publish readiness

Before pushing to GitHub:
- confirm `npm test` passes
- optionally run `npm run test:live`
- verify no local logs or secrets were copied into the repo
