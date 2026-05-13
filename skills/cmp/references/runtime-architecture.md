# CMP Runtime Architecture

This document is the maintenance reference for the `/cmp` plugin runtime.

## Purpose

`/cmp` collects answers from multiple web AI platforms, validates the collected outputs, and produces one final combined answer through a model-driven synthesis stage.

The key architectural rule is:

- the final answer must be authored by the synthesis model from the complete cleaned answer set
- not by heuristic section builders
- not by raw fragment stitching
- not by the renderer

## Runtime Ownership

Live execution path:

- [index.js](/Users/snowyai/.openclaw/extensions/cmp/index.js)

Documentation and runbook:

- [SKILL.md](/Users/snowyai/.openclaw/skills/cmp/SKILL.md)
- [user-guide.md](/Users/snowyai/.openclaw/skills/cmp/references/user-guide.md)
- [platform-quirks.md](/Users/snowyai/.openclaw/skills/cmp/references/platform-quirks.md)

Config and state:

- [platforms.json](/Users/snowyai/.openclaw/skills/cmp/config/platforms.json)
- [state.json](/Users/snowyai/.openclaw/skills/cmp/config/state.json)

Helpers:

- [state.py](/Users/snowyai/.openclaw/skills/cmp/scripts/state.py)
- [doctor.py](/Users/snowyai/.openclaw/skills/cmp/scripts/doctor.py)
- [detect-complete.js](/Users/snowyai/.openclaw/skills/cmp/scripts/detect-complete.js)
- [extract-response.js](/Users/snowyai/.openclaw/skills/cmp/scripts/extract-response.js)

Run traces:

- [last-run.json](/Users/snowyai/.openclaw/skills/cmp/logs/last-run.json)
- [cmp.log](/Users/snowyai/.openclaw/skills/cmp/logs/cmp.log)

## Pipeline

### 1. Platform Runtime Stage

For each enabled platform:

1. open a fresh chat tab
2. focus the tab
3. wait for load
4. detect session/login failure
5. find/fill the prompt input
6. submit the prompt
7. verify that submission really happened

This stage must not author any user-facing comparison text.

### 2. Completion Stage

After all prompts are submitted:

- the runtime waits for each platform to either finish, fail, or time out
- platform-specific completion probes are used where generic polling is not reliable
- the final synthesis does not start until every enabled platform is in a terminal state
- completion checks must be conservative enough to avoid paused-stream false positives
- the effective wait budget should tolerate 120 seconds plus an extra 60-second grace window when a platform is still visibly streaming

Completion traces:

- `response_wait_start`
- `platform_completion_probe`
- `response_complete`
- `response_timeout`

### 3. Extraction Stage

For each completed or timed platform:

- extract the full raw answer text
- apply platform-specific cleanup
- validate for usability
- retry if the response is too thin, clipped, repetitive, or unstable

Validation rejects outputs such as:

- UI/history/menu residue
- stale wrong-topic content
- placeholder or promo text
- question echo only
- very thin non-answers

Extraction traces:

- `response_validation`
- `response_retry_wait`
- `response_extracted`

### 4. Aggregation Stage

The runtime builds two explicit collections:

- `usable`
  Cleaned validated answers allowed into synthesis.
- `unusable`
  Failed, timed out, or rejected answers with compact reasons.

The aggregation stage is the boundary between browser/runtime mechanics and final reasoning.

Aggregation traces:

- `aggregation_start`
- `screening_model_request`
- `screening_model_response`
- `aggregation_complete`

## Screening Model

The runtime may use a screening pass before final synthesis.

Its job is narrow:

- decide if an extracted answer is usable
- catch wrong-topic or contaminated answers that heuristics may miss
- preserve only compact reasons for rejected answers

It is not the final author of the user-facing reply.

## Final Synthesis Stage

This is the main intellectual stage.

Inputs:

- original user question
- all full usable cleaned platform answers
- compact metadata for unavailable/unusable platforms

Outputs:

- `platformViews`
- `consensus`
- `majorDifferences`
- `uniqueAdditions`
- `directAnswer`

Rules:

- compare answer substance, not model personality
- produce real summaries, not clipped openings
- answer the user directly with an original expert synthesis
- reference concrete claims, examples, assumptions, and differences from the platform answers
- `directAnswer` is the primary deliverable and should be the richest section
- mention unavailable inputs quietly

Synthesis traces:

- `synthesis_start`
- `summary_generation_start`
- `synthesis_model_request`
- `synthesis_model_response`
- `synthesis_model_parsed`
- `summary_generation_complete`

## Rendering Stage

The renderer is presentation-oriented but must preserve content quality.

It:

- orders sections for chat readability
- prints platform views from synthesis output
- formats the answer cleanly for Discord and Telegram
- re-summarizes structurally when a transport limit is tight

It does not:

- create consensus text from scratch
- infer differences itself from raw extracts
- clip raw text and call that a summary
- append transport-truncation notices

## User-Facing Layout Priorities

Preferred order:

1. `Consensus`
2. `Major Differences`
3. `Unique Additions`
4. `Best Combined Answer`
5. `Platform Views`
6. compact unavailable-inputs section
7. compact status footer

Avoid:

- putting `Platforms queried` prominently near the top
- debug-report presentation
- letting failure notes crowd out the answer

## Obsolete Design To Avoid

The following design is obsolete and should not return:

- fixed stitched template sections as the source of truth
- heuristic consensus generation before collection is complete
- platform summaries made from the first visible text fragment
- truncating cleaned platform answers before the final synthesis stage
- chat-transport suffixes that leak internal file paths
- rendering logic that invents substantive comparison content

If future changes reintroduce these patterns, treat that as a regression.

## Debugging Checklist

1. Confirm browser health:
   use `python3 ~/.openclaw/skills/cmp/scripts/doctor.py`; on installs where the interactive shell still exposes it, `openclaw browser status --json` should also report healthy browser state
2. Run a real `/cmp` query.
3. Inspect [last-run.json](/Users/snowyai/.openclaw/skills/cmp/logs/last-run.json).
4. Verify stage order:
   - prompt send
   - completion wait
   - extraction
   - aggregation
   - synthesis
   - final render
5. If a platform view looks wrong-topic, check:
   - extraction source
   - validation reason
   - screening result
6. If the final answer reads like stitched filler, check:
   - synthesis prompt/schema
   - fallback activation
   - whether the fallback happened before or after all enabled platforms reached terminal state
   - whether unusable answers leaked into `usable`

## Failure Policy

- If no usable answers survive validation, return a failure report instead of fake comparison prose.
- If synthesis fails after usable answers were collected, return a deterministic synthesis built only from the collected answers. Do not emit placeholder sections.
- Never silently replace failed synthesis with heuristic consensus while pretending it is the normal product path.
