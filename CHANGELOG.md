# Changelog

All notable changes to `openclaw-cmp` will be documented in this file.

## v0.1.0 - 2026-05-14

Initial public release.

### Added

- Real `/cmp` command registration for OpenClaw
- Multi-provider comparison flow for ChatGPT, Claude, and Gemini
- GitHub Copilot-backed synthesis using `gpt-4o` with `gpt-5-mini` fallback
- Local smoke test and live sample runner
- Multilingual repository docs in English, Traditional Chinese, and Japanese
- Community health files: `CONTRIBUTING.md`, `SECURITY.md`, and `LICENSE`

### Changed

- Moved `Best Combined Answer` to the top of the final report
- Improved Chinese output policy to prefer Traditional Chinese over Simplified Chinese
- Improved synthesis prompts to avoid template-like placeholder phrasing
- Improved portability so the repo copy can run without being hard-bound to a single `~/.openclaw` layout
- Improved browser target recovery after provider UIs switch tab or conversation target ids
- Switched ChatGPT runs toward temporary chat mode to reduce stale-context contamination

### Fixed

- Final synthesis failing because old OpenClaw helper resolution paths no longer matched `2026.5.7`
- Partial-provider failures incorrectly collapsing the whole comparison
- ChatGPT and Gemini submission/completion detection being too strict for newer UIs
- Gemini preference-scaffold contamination in extracted responses
- Fake summary fallback such as placeholder completion text
