# CMP User Guide

`/cmp` compares answers from multiple web AI chat sessions through the OpenClaw managed browser.

## What `/cmp` Now Does

`/cmp` is a full-answer comparison flow, not a fragment-report tool.

It:

1. sends the same question to each enabled platform
2. waits for each platform to finish, fail, or time out
3. extracts the full answer from each platform and cleans it
4. rejects unusable outputs
5. gives the full cleaned usable answers to the local synthesis model, preferably through the embedded agent runtime
6. returns one integrated answer with comparison sections and a direct answer

The final answer is produced after collection and validation, not before.

## Supported Platforms

- ChatGPT
- Claude
- Gemini
- Grok

## One-Time Setup

1. Start or verify the gateway-managed browser. On installs where the interactive shell still exposes it, use:
   `openclaw browser start`
2. Sign in manually to the AI sites you want to use.
3. Keep `browser.evaluateEnabled` enabled in `~/.openclaw/openclaw.json`.

`/cmp` never logs in for you.

If your shell says `openclaw browser` is unknown, run `python3 ~/.openclaw/skills/cmp/scripts/doctor.py` and inspect `~/.openclaw/skills/cmp/logs/last-run.json` instead. Newer OpenClaw builds may keep browser control available to the runtime while hiding the interactive browser subcommand.

## Slash Commands

- `/cmp <question>`
- `/cmp-status`
- `/cmp-on <platform|all>`
- `/cmp-off <platform|all>`

Telegram native aliases:

- `/cmpstatus`
- `/cmpon <platform|all>`
- `/cmpoff <platform|all>`

`/cmp` itself is question input only.

## What Good Output Should Feel Like

The reply should feel like:

- multiple AI answers were collected
- the system thought over them together
- the result is one useful combined answer
- the final answer waited for the platform set to settle before synthesizing

It should not feel like:

- clipped openings
- page residue
- debug fragments in headings
- a rigid report template filled with weak heuristics
- placeholder text about degraded or unfinished synthesis
- raw transport truncation markers such as "Response truncated for chat transport"
- vague observations that merely say the platforms are "similar" without naming what they actually said

## Output Structure

`/cmp` now returns exactly five sections in this order:

1. `Consensus`
2. `Major Differences`
3. `Unique Additions`
4. `Best Combined Answer`
5. `Platform Views`

`Best Combined Answer` should be the longest section.
If a full rich answer is too long for Discord or Telegram, CMP should produce a tighter re-summary of the same five sections rather than clipping the text.
`Consensus`, `Major Differences`, and `Unique Additions` should name concrete claims and which platform contributed them.

## Failure Handling

If some platforms fail:

- `/cmp` still uses the usable answers
- failures are shown compactly
- failures should not dominate the main answer

If no usable answers survive:

- `/cmp` reports that clearly
- it does not fake a comparison

## Recovery

If commands stop appearing or routing:

1. `openclaw gateway restart`
2. `python3 ~/.openclaw/skills/cmp/scripts/doctor.py`
3. `tail -n 200 /tmp/openclaw/openclaw-$(date +%F).log | rg 'cmp|native command|Telegram|Discord'`

If `/cmp` runs but quality is wrong:

1. inspect `~/.openclaw/skills/cmp/logs/last-run.json`
2. verify the run reached:
   - completion waiting
   - extraction
   - aggregation
   - synthesis
3. check whether a bad platform answer was rejected or leaked through

## How Completion Waiting Works

CMP does not rely on a fixed timer. Each platform is polled using a dedicated DOM probe until it reaches a terminal state (complete, timed out, or failed).

For **Claude** specifically: Claude.ai navigates from `/new` to `/chat/<id>` after the prompt is submitted. This invalidates the browser tab reference stored at send time. CMP handles this by running a fresh DOM evaluation on every polling cycle — it checks for the stop/cancel button, streaming indicators (`data-is-streaming`, streaming cursor classes), whether the composer is empty, and whether the response text length is stable across multiple consecutive polls. A response is only considered complete once it has been stable for several polls in a row.

This means CMP is designed to wait patiently. If a platform is still generating at the 2-minute mark, CMP will keep checking up to the 5-minute ceiling before timing out.

## Notes For Operators

- Keep sessions logged in.
- Ask one clear question per run.
- If Gemini or Grok return noisy UI-like content, the runtime should reject it before synthesis.
- If the final answer still looks stitched together, treat that as a regression in the synthesis pipeline, not as expected behavior.
- If Claude consistently shows ❌, check `last-run.json` for `inject_detector` entries. They should now show `skipped: true` with reason `claude_uses_dedicated_probe`. If instead they show an error, you may be running an older version of the extension — re-run `npm run install:local`.
