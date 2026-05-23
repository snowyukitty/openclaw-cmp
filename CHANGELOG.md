# Changelog

All notable changes to `openclaw-cmp` will be documented in this file.

## v0.3.3 - 2026-05-23

### Fixed

- Added startup activation and tool contract metadata to the CMP plugin manifest so `/cmp` is loaded into the gateway runtime and exposed to Discord native slash command deployment consistently.
- Updated the CMP doctor to accept current `Connectivity probe: ok` gateway output instead of warning on healthy gateways.
- Updated the CMP doctor to verify the latest gateway startup loaded `cmp`, instead of passing on stale historical registration log lines.
- Updated the CMP doctor to report the newer missing `openclaw browser` subcommand as checked runtime evidence instead of a warning.

### Changed

- Updated English, Traditional Chinese, and Japanese docs with explicit restart-and-doctor guidance after CMP updates.

## v0.3.2 - 2026-05-23

### Added

- Added `npm run doctor` as the standard repository entry point for CMP diagnostics.

### Changed

- Local installer now preserves existing `~/.openclaw/skills/cmp/config/state.json`, `platforms.json`, and `~/.openclaw/skills/cmp/logs` during repo updates.
- Local installer preserves `~/.openclaw/extensions/cmp/.git` when present so extension working-tree metadata is not removed by reinstall.
- Shared skill helpers are copied into the existing `_shared` directory instead of replacing the whole directory.
- Updated English, Traditional Chinese, and Japanese docs with doctor and safer-install guidance.

## v0.3.1 - 2026-05-23

### Changed

- Renamed the second-pass `Best Combined Answer` trace path from `claude_direct_answer_*` to `rich_direct_answer_*`. The pass uses GitHub Copilot GPT-4.1, so the new event names describe the role of the pass instead of implying a Claude/provider dependency.
- Updated English, Traditional Chinese, and Japanese docs to document the new trace naming.

### Fixed

- Updated the CMP doctor so Discord allowlisted guild channels count as allowed when the channel is present in `guilds.<id>.channels` and not explicitly set to `allow: false`.

## v0.3.0 - 2026-05-16

### Changed

- **Synthesis model upgraded to `github-copilot/gpt-4.1`** across all passes. GPT-4.1 has better instruction following and long-form generation quality than GPT-4o, which directly improves `Best Combined Answer` depth. Fallback chain is now `gpt-4.1` → `gpt-4o` → `gpt-5-mini`.
- **Two-pass synthesis pipeline for Best Combined Answer:** a second, independent call to GPT-4.1 now runs after the main synthesis with a dedicated 8000-token budget for `Best Combined Answer` only. The dedicated pass receives every platform's full answer and is instructed to write 800–1500 words of expert-level synthesis. It replaces the first-pass draft only when it produces a longer result; if it fails, the first-pass draft is kept.
- **Pass 1 token budget raised from 3200 to 5000** to give the main synthesis more room for all five sections.
- **`directAnswer` minimum length validation raised** from 350 to 500 characters.
- **`directAnswer` prompt requirements strengthened** in both the system prompt and the agent prompt: changed from "~400 words" to "700+ words, target 1000+".
- **`runGatewayChatCompletion` timeout raised** from 90 s to 120 s to accommodate larger token budgets.

### Fixed

- Removed accidental dependency on `api-proxy-claude` (pay-per-token) in the synthesis path. All synthesis passes now use GitHub Copilot (free/flat-rate subscription).
- Fallback chain in `runGatewayChatCompletion` now iterates a model list instead of a single hardcoded fallback, making it easier to extend.

## v0.2.0 - 2026-05-16

### Fixed

- **Claude always timing out (primary bug):** Claude.ai navigates from `/new` to `/chat/<id>` on prompt submission, which invalidates the browser targetId stored at send time. The old approach of injecting `window.__cmpDone` state into the tab failed silently every time because the tab reference was stale, so Claude always timed out at the 5-minute deadline and was reported as ❌.
- **Replaced injected-state detection with a dedicated per-poll DOM probe for Claude** (`checkClaudeCompletion` + `buildClaudeCompletionCheckFn`), consistent with the ChatGPT and Gemini pattern. The probe evaluates Claude's DOM fresh on every polling cycle and never depends on previously-injected JS variables.
- **Claude extraction retry added:** on a thin first extraction result, Claude now waits 4 seconds and retries, consistent with ChatGPT and Grok.
- **Dangerous regex in Claude response cleanup:** `\bRetry\b.*$/s` (dotAll) was truncating every Claude response at the first occurrence of "retry" anywhere in the text (e.g. mid-sentence "you can retry this approach…"). Replaced with a trailing-only strip of known UI button labels.

### Changed

- `buildClaudeCompletionCheckFn` now checks `data-is-streaming`, streaming cursor and animation class names, cancel button text, and URL path (`/chat/`) as additional completion signals alongside stop-button detection.
- `installCompletionDetectors` skips Claude entirely and records `skipped: true` in the run trace instead of attempting an injection that always fails and logs a misleading error.

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
