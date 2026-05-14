# TODO

Long-term optimization backlog for `openclaw-cmp`.

## Reliability

- Improve Claude target recovery and timeout handling for free-account constraints.
- Reduce provider-specific UI fragility when tabs or conversation target ids change mid-run.
- Add stronger detection for provider session-expired states and surface clearer recovery messages.
- Keep partial-provider synthesis stable even when two providers degrade in different ways.

## Answer Quality

- Further improve synthesis prompts so `Best Combined Answer` reads like a strong analyst, not a formatter.
- Improve current-news handling with better freshness cues and clearer uncertainty labeling.
- Refine platform screening to reject stale-context answers earlier without over-rejecting usable responses.
- Preserve more high-value raw excerpts for debugging without overwhelming the final report.

## Language Support

- Continue improving English, Japanese, and Traditional Chinese output quality.
- Audit all Chinese prompt and fallback paths to ensure Traditional Chinese stays the default.
- Improve multilingual docs and examples so each supported language has equivalent guidance.

## Testing

- Add fixture-based tests for synthesis normalization and fallback rendering.
- Add regression fixtures for ChatGPT temporary chat, Gemini retry extraction, and Claude partial-failure behavior.
- Add compact-output tests for Discord-sized transport limits.

## Release and Distribution

- Publish a GitHub Release page for `v0.1.0` and later versions.
- Add screenshots or flow diagrams to README for easier first-time adoption.
- Consider a lightweight installer or upgrade script for easier sharing.
