# Contributing

Thanks for contributing to `openclaw-cmp`.

## Scope

This project aims to keep CMP:
- small
- practical
- browser-runtime compatible with OpenClaw
- useful under partial provider failure

## Before Opening a PR

Run:

```bash
npm test
```

If your change affects live browser flow, also run:

```bash
npm run test:live
```

## Change Guidelines

- Prefer small, robust fixes over broad rewrites.
- Preserve OpenClaw compatibility first.
- Do not replace honest failure reporting with placeholder text.
- Keep diagnostics concise and avoid leaking secrets or tokens.
- Preserve Japanese and Traditional Chinese support when editing prompts or docs.

## Docs

If you change user-facing behavior, update:
- `README.md`
- `docs/README.zh-Hant.md`
- `docs/README.ja.md`
