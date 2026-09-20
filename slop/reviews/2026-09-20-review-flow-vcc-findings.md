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

## Independent-family limitation

The Anthropic review child failed before producing findings:

> `429 ... Usage credits are required for this model ... org_level_disabled_until`

No cross-family verdict was available. It was not replaced with another route because the requested panel had already been launched as one bounded workflow and silent route substitution would weaken provenance.

## Verification after fixes

- `npm test`: 137 passed
- `npm run typecheck`: passed
- `npm run lint`: passed
- `git diff --check`: passed

— PI/OpenAI
