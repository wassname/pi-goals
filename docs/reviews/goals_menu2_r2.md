You're right on both counts. Let me trace through each.

**Finding 1, withdrawn.** Keeping `isPlanMode` true during compaction would mean any message the human sends while compaction runs gets processed in plan mode: blocked tools (`tool_call` hook), a "You are still in plan mode" injection (`context` hook), and a second Ready menu on `agent_end`. The current order (flip first, then compact) means that same message is processed in work mode — the destination the session is heading to. The cost is at worst one redundant turn when the `onComplete` follow-up lands. Your order is the correct one.

**Finding 2, withdrawn.** `updateWidget` with `isPlanMode === true` hits the early return that sets two fixed strings already on screen. It is a pure no-op.

---

## Code Review: ready menu — print plan + add "Ready + compact"

### Summary
The `agent_end` handler now prints the plan working set into the transcript before the menu, and adds a 4th option ("Ready + compact") that compacts the planning chatter away before the work turn. The logic is correct and well-considered.

### Positive
- **De-duplication is correct.** `printed` is a local variable, fresh per `agent_end` call, and suppresses re-printing when the working set hasn't changed across `$EDITOR` passes. The `while` loop exits cleanly if the human deletes all goals in the editor.
- **String matching is safe.** `choice?.startsWith("Ready")` gates both Ready options, then `choice.includes("compact")` distinguishes them. The word "compact" appears only in the one label.
- **Both compaction callbacks queue the work turn.** `onComplete` and `onError` both call `pi.sendUserMessage(work, ...)`. A failed compaction does not strand the session.
- **The `session_compact` → `resyncReason` → injection chain is correct.** The pi source confirms `session_compact` fires (and is awaited) before `this.compact()` resolves and `onComplete` fires. The full plan file is re-injected on the next LLM call; the compaction summarizes away the exploration, not the plan.
- **The state-flip-before-compaction order is deliberate and correct.** Flipping `isPlanMode` first means any message the human sends during compaction is handled in work mode, not plan mode (where tools would be blocked and a contradictory injection would fire).

### Verdict
**APPROVE** — no bugs found. The two concerns raised initially were incorrect; the code handles the interleaving correctly.