# Review findings: stop decisions and worker VCC view

## Quick oracle

Source: `pi-quick-oracles` child run `39dbb784-0523-4da7-ab28-8fbadb666f4c`; saved answer:
`/home/code/.pi/agent/sessions/--home-code-.pi-agent-git-github.com-wassname-pi-goals--/subagent-artifacts/outputs/bb2764b1-20df-48e2-805d-32e1b1098339/quick-oracle-review.md`

### Finding 1: compaction could skip unseen turns

> “The cursor needs an entry identity or compaction-generation anchor, not only a count.”

Confirmed from the implementation. Fixed by persisting both the compaction boundary ID and the last shown message entry ID. A missing anchor restarts from the new boundary. The regression test now covers view → compaction → twelve new turns → view.

### Finding 2: a result arriving after its call could disappear

> “View B gives VCC only the isolated `toolResult`, without the originating call or arguments. The call also vanishes from ‘unanswered tool calls.’”

Confirmed. VCC intentionally omits tool-result bodies. The view now adds bounded one-line outcomes for late results, failures and background-control results. Raw result bodies and JSON remain omitted. The regression test covers a process result arriving after its call was shown.

### Finding 3: disconnect episodes could deduplicate forever

> “Repeated disconnects after the same last assistant entry also reuse the same ID.”

Confirmed for missing history and assistant-derived fallback IDs. The worker binding now persists a disconnect revision and includes it in fallback disconnect IDs. Structured stop IDs remain canonical and deduplicated. The regression test covers two disconnect episodes with unavailable history.

## OpenRouter Fable review

Source: OpenRouter `anthropic/claude-fable-5.1`, medium reasoning, run with `moa` after the user explicitly selected OpenRouter. The first direct-Anthropic child had failed with `credits_required`; it produced no review evidence.

Saved answer: `slop/reviews/2026-09-20_claude-fable-5.1_stop-flow-vcc-postfix.answer.md` (generated working artifact, not tracked).

### Finding 1: a changed Intercom UUID would reject reconnection

> “If Intercom assigns a fresh UUID on reconnect, a selected review can never be delivered and the worker is detached.”

Conditional and not changed. `pi-intercom` uses the Pi session ID by default, so reload of the same saved session keeps the UUID. A cloned or replacement Pi session is a different worker identity and must not silently inherit ownership using only the old request ID. Explicit replacement correlation remains required.

### Finding 2: size validation happened after formal selection

> “An oversized review throws after the REPORT exists.”

Confirmed and fixed. The complete Intercom payload is now constructed and checked against 16 KiB before `pi-goals-report` is appended. A regression test supplies a 17 KiB quote and confirms that no formal report is created.

### Finding 3: disconnect after a structured stop was deduplicated

> “The supervisor never learns the worker actually left.”

Confirmed. The original stop stays canonical; a later disconnect now records a separate non-reviewable `receipt` with an episode ID. It does not wake the supervisor or reopen formal review.

### Finding 4: the cursor advanced past content omitted by size limits

> “The cursor advances past all rows, making omitted info unavailable from worker_view.”

Confirmed and fixed. The view now summarizes a chronological prefix that fits the bounded view, advances only through the last represented entry, and states how many newer saved turns remain. Result summaries are no longer silently limited to the last five. A single oversized turn is explicitly marked as partial and remains available in the saved session.

### Finding 5: child Pi process detection assumed the executable name was `pi`

> “`comm=` ... is `node`/`bun` for a Pi CLI.”

Confirmed and fixed conservatively. The summary now counts probable child Pi processes from either the command or a `pi`/`pi-coding-agent` executable path. Only the exact snapshot command is excluded; unrelated `ps` children remain visible.

### Finding 6: exact JSON serialization made review acknowledgement brittle

> “Key-order/serialization drift would fail the same way.”

Confirmed for key order. Saved review verification now compares the review ID, report ID, verdict, content and continuation explicitly. It still requires the parent’s existing draft and exact worker/request/plan ownership; an unsolicited historical review cannot acquire authority.

### Minor findings

`supersedes` remains a legacy-compatible field used by pending-report projection but is not written by the current one-event-per-stop path. Empty disconnect session paths were not changed: an attached worker necessarily supplied an absolute saved-session path before its Intercom ID became authoritative.

## Verification after fixes

- `npm test`: 140 passed
- `npm run typecheck`: passed
- `npm run lint`: passed
- `git diff --check`: passed

— PI/OpenAI
