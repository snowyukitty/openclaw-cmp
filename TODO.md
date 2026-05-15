# TODO

Long-term optimization backlog for `openclaw-cmp`.

## Reliability

- ~~Improve Claude target recovery and timeout handling for free-account constraints.~~ ✅ Fixed in v0.2.0: Claude now uses a dedicated per-poll DOM probe; no injected state means no stale-targetId failures.
- ~~Reduce provider-specific UI fragility when tabs or conversation target ids change mid-run.~~ ✅ Fixed in v0.2.0 for Claude; ChatGPT and Gemini already handled this.
- Add stronger detection for provider session-expired states and surface clearer recovery messages.
- Keep partial-provider synthesis stable even when two providers degrade in different ways.
- Add Grok support to completion detection (currently uses generic GROK_COMPLETION_CHECK_FN without the per-poll stable-history pattern).

## Answer Quality

- Further improve synthesis prompts so `Best Combined Answer` reads like a strong analyst, not a formatter.
- Improve current-news handling with better freshness cues and clearer uncertainty labeling.
- Refine platform screening to reject stale-context answers earlier without over-rejecting usable responses.
- Preserve more high-value raw excerpts for debugging without overwhelming the final report.
- Audit `cleanExtractedResponse` across all platforms for any remaining overly-broad regexes.

## Language Support

- Continue improving English, Japanese, and Traditional Chinese output quality.
- Audit all Chinese prompt and fallback paths to ensure Traditional Chinese stays the default.
- Improve multilingual docs and examples so each supported language has equivalent guidance.

## Testing

- Add fixture-based tests for synthesis normalization and fallback rendering.
- Add regression fixtures for ChatGPT temporary chat, Gemini retry extraction, and Claude tab-navigation/completion behavior.
- Add compact-output tests for Discord-sized transport limits.
- Add a test that verifies `cleanExtractedResponse` does not truncate mid-sentence on words like "retry", "copy", "continue".

## Release and Distribution

- ~~Publish a GitHub Release page for `v0.1.0` and later versions.~~ → Publish for v0.2.0.
- Add screenshots or flow diagrams to README for easier first-time adoption.
- Consider a lightweight installer or upgrade script for easier sharing.
