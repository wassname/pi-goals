Code review against spec `docs/spec/2026-06-15_pi-plan.md`.

---

### (A) SPEC MISMATCH — code does not match spec intent

1.  **No loop judge** (spec §9, §3b). The extension lacks any per‑turn evaluation that would decide continue/pause; the loop‑judge prompt (`loopJudgeSystem`, `loopJudgeUser`) is defined but never invoked. No motion.

2.  **`/goal` command missing** (spec §7). No handler for `/goal` (restart loop, pause, resume, clear, status). The only command is `/plan`.

3.  **`/subgoal` command missing** (spec §7). Not implemented.

4.  **`CancelGoal` tool not implemented** (spec §5, optional but present in spec). Not a blocker but a gap.

5.  **Plan‑phase model selection (D12) not implemented**. `planDrafting` always runs on the default model; there is no sticky per‑phase model choice, no selection menu, and no persisting of a plan‑phase model reference.

6.  **Widget does not flag `done` goals that lack a sign‑off log line** (spec §7, §6). The widget hides all done goals unconditionally; the visibility guard is missing.

7.  **`/plan` (no args) does not render the task‑list widget** (spec §7). `showPlan()` dumps raw file content via `notify`; the widget is only set through `updateWidget()` on other events, not by the command itself.

8.  **Injection message role** (spec §11). The `before_agent_start` hook returns a `customType` message with `display: false`. The spec demands a **late user‑role message** to avoid system‑prompt mutation; the actual message role depends on the pi API and may be system, not user, risking cache breakage.

9.  **Missing pre‑compact hook** (spec §8). No `pre‑compact` hook to flush any in‑memory state (even just ensuring `plan.md` is up‑to‑date) before compaction.

10. **Reminder cadence deviates** (spec §8a). The spec calls for firing after N file‑modifying turns since last `plan.md` update. The code fires if `plan.md` is byte‑identical between agent starts, which is a coarser proxy.

---

### (B) DEAD/UNUSED CODE

| File | Lines | Reason |
|------|-------|--------|
| `src/prompts.ts` | 128‑146 | `loopJudgeSystem` and `loopJudgeUser` exported but never used. |
| `src/prompts.ts` | 115‑118 | `continuation` exported but never used (the loop is not built). |

---

### (C) OVERLY LONG OR REDUNDANT COMMENTS

The file‑header comments in `index.ts` (lines 1‑20) and `plan‑file.ts` (lines 1‑26) are fairly concise descriptions of the design; they are not excessive. **No comment bloat worth flagging.**

---

### (D) OVER‑ENGINEERING vs. “super simple” goal

None. The line‑scanner in `plan‑file.ts` is minimal; the `getPiInvocation()` helper is a straightforward copy from the oracle extension; no unnecessary abstraction or defensive layers.

---

### (E) REAL BUGS

- **`cmdCtx.newSession` cast risk** (src/index.ts:272, 201).  
  `reviewLoop` casts `ctx` (type `ExtensionContext`) to `ExtensionCommandContext` to pass to `startExecution`, which calls `cmdCtx.newSession(...)`. If the concrete context does not carry that method, it fails at runtime. (In practice the same object may satisfy it, but the cast hides the truth.)

- **`showPlan` raw content instead of widget** (src/index.ts:136‑143).  
  `/plan` with no arguments shows the file content via `ctx.ui.notify`, not the structured task‑list widget the spec expects. The widget is rendered separately via `updateWidget`, but the command does not trigger it, so the output is inconsistent.

No other obvious logic errors; the sign‑off flow, logging, and parsing work as intended.

---

**Verdict:** A clean scaffold for the sign‑off path, but missing the autonomous loop, `/goal` command, and plan‑phase model selection means it’s not yet the “work autonomously” extension the spec describes.