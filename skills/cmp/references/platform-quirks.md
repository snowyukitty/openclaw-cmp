# Platform-Specific Quirks

## ChatGPT

- Uses a React-controlled composer. `agent-browser fill` usually works.
- If the send button stays disabled after filling, click the composer, re-snapshot, and use the fresh send control.
- Rate-limit or Cloudflare messages can become the effective response text.

## Claude

- The composer is usually `contenteditable`, not a plain `textarea`.
- Always start from `/new` so each `/cmp` run uses a fresh conversation.
- After the prompt is submitted, Claude navigates from `/new` to `/chat/<id>`. This changes the browser targetId stored at send time. Completion detection must not depend on JS state injected into the original tab — use a fresh DOM probe on every polling cycle instead.
- Completion signals: stop/cancel button visible (streaming), or `data-is-streaming="true"`, streaming cursor class names. Done when stop is gone, response text is stable across multiple polls, and the composer is empty.
- Long answers may require scrolling before extraction.
- Trailing UI chrome ("Retry", "Copy") may appear at the end of extracted text and should be stripped only at the tail, not mid-text.

## Gemini

- Gemini changes its DOM structure often.
- If multiple editors appear, use the main composer nearest the bottom of the active conversation pane.
- Ignore boilerplate disclaimer text if cleaner response text is available.

## Grok

- Requires an active X or Twitter login.
- Promotional or subscription overlays can block the composer.
- Extract text only and ignore media-heavy content when possible.

## General

- `@eN` element refs are short-lived. Re-snapshot after fills, clicks, navigation, or major DOM updates.
- If a login page appears, mark the platform as session-expired and move on.
- Use the JavaScript detector first; only fall back to snapshot-stability polling when evaluation is unavailable.
