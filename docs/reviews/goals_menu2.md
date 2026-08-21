Let me get the diff to see what changed:

Now let me check the git history to see what changedNow I have full context. Let me verify the pi API behavior by checking the relevant source files to confirm the claims about `sendMessage`, `compact`, and event orderingNow I have all the context needed. Let me verify the `sendMessage` path more carefully:

I now have a complete picture. Here is the review.

---

## Code Review: ready menu — print plan + add "Ready + compact"

### Summary
The `agent_end` handler now prints the plan working set into the transcript before the menu, and adds a 4th option ("Ready + compact") that compacts the planning chatter away before the work turn. The logic is correct and well-considered, with one structural race and one stale-widget gap.

### Important (should fix)

- **`src/index.ts:~248` (the `agent_end` handler) — race: plan mode is turned off before compaction completes.**  
  `state = { ...state, isPlanMode: false }` executes before `ctx.compact()` is called (let alone finished). The compaction is fire-and-forget. If the human types and sends a message in the window between the state flip and the compaction callback firing, the agent starts a turn in normal mode *without* the work instruction. The work instruction arrives later (via `sendUserMessage` in `onComplete`/`onError`), triggering a second, redundant turn.  
  The window is small (compaction is fast) but the behavior is undefined — the agent could start executing before the work instruction lands.  
  **Fix**: flip `isPlanMode` inside the callbacks, not before. Move `state = { ...state, isPlanMode: false }; persist(); updateWidget(ctx);` into both `onComplete` and `onError`, and also into the non-compact branch (where it already is, effectively). The `work` string can be defined before the branch.

  ```typescript
  if (!choice.includes("compact")) {
      state = { ...state, isPlanMode: false };
      persist();
      updateWidget(ctx);
      pi.sendUserMessage(work, { deliverAs: "followUp" });
      return;
  }
  ctx.compact({
      customInstructions: `...`,
      onComplete: () => {
          state = { ...state, isPlanMode: false };
          persist();
          updateWidget(ctx);
          pi.sendUserMessage(work, { deliverAs: "followUp" });
      },
      onError: (e) => {
          ctx.ui.notify(`Compaction failed (${e.message}); starting work anyway.`, "warning");
          state = { ...state, isPlanMode: false };
          persist();
          updateWidget(ctx);
          pi.sendUserMessage(work, { deliverAs: "followUp" });
      },
  });
  ```

  This also means the widget stays in "planning" mode during compaction, which is truthful — compaction hasn't finished yet.

### Suggestions

- **`src/index.ts:~248` — widget not refreshed after `$EDITOR`.**  
  When the human chooses "Open in $EDITOR", `spawnSync` blocks, then `continue` re-enters the loop. The plan is re-read and potentially re-printed, but `updateWidget` is not called. If the human changed goal statuses (e.g. ticked a checkbox), the widget stays stale until the next `turn_end`.  
  Add `updateWidget(ctx);` after the `spawnSync` line (or inside the `continue` branch before the continue).

- **`src/index.ts:~248` — `spawnSync` blocks the event loop.**  
  `spawnSync(process.env.EDITOR || ...)` is a synchronous blocking call. While the editor is open, no async work (including compaction from a previous iteration, timers, etc.) can proceed. This is fine for a local TUI tool, but worth noting — if the editor hangs or the human walks away, the entire pi process is frozen.

### Positive

- **De-duplication is correct.** `printed` is a local variable, fresh per `agent_end` call, and correctly suppresses re-printing when the working set hasn't changed across editor passes. The `while` loop exit condition (`scanGoals(...).length > 0`) correctly handles the human deleting all goals in the editor.
- **String matching is safe.** `choice?.startsWith("Ready")` gates both Ready options, then `choice.includes("compact")` distinguishes them. The word "compact" appears only in the "Ready + compact" string. No ambiguity.
- **Both compaction callbacks queue the work turn.** `onComplete` and `onError` both call `pi.sendUserMessage(work, ...)`. A failed compaction does not strand the session — work starts anyway, with a notification.
- **`session_compact` → `resyncReason` → injection chain is correct.** The pi source confirms `session_compact` fires (and is awaited) *before* `this.compact()` resolves and `onComplete` fires. So `resyncReason` is set before the next LLM call, and the full plan file is re-injected. The compaction summarizes away the exploration; the plan itself survives.

### Verdict
**REQUEST CHANGES** — the race between `isPlanMode = false` and compaction completion is a real timing bug that can cause the agent to start a turn without the work instruction. The fix is straightforward: move the state flip into the callbacks.