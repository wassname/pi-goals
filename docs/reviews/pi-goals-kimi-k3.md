I only have the `read` tool available, so let me locate the changed files by probing the repository structure.The extension source is clear. Let me verify the pi API usage (`sendMessage` with `customType`/`display`, `appendEntry`, `getSessionId`, `ctx.compact`) against the pi docs, since several required behaviors hinge on them.I can't run `git diff` or the test suite — this review environment only exposes a `read` tool, and the test directory can't be enumerated (every probe under `test/` returned ENOENT, and directories can't be listed). So I reviewed the changed files directly in the working tree (`src/index.ts`, `src/prompts.ts`, `README.md`, `scripts/check-judge-footprint.sh`) against the five required behaviors, and verified every pi API the behaviors depend on (`pi.sendMessage` with `customType`/`display`, `pi.appendEntry` restore via `session_start`, `pi.sendUserMessage` followUp, `ctx.compact` with onComplete/onError) against the installed pi docs. Findings below.

## Defects

**1. `/goals` arg parsing swallows ordinary objectives — src/index.ts, `/goals` handler**

```ts
if (arg.startsWith("judge")) {
```

Any objective whose first word is "judge" — e.g. `/goals judge the vendor options`, `/goals judge readiness of the export` — is treated as the judge-model subcommand: it sets `judgeModel` to "the vendor options" and **does not reserve a new `.pi/plan/<session_id>-vN.md`**, violating "every ordinary `/goals` invocation reserves a new file". Same class of issue for an objective that is exactly `clear` (deletes the plan instead of planning). Use exact-match subcommand parsing (`arg === "judge"` / `arg.startsWith("judge ")` at minimum, and even then an objective like "judge model quality" is unreachable — a `:` or `--` separator would be safer).

**2. The checked-artifact-list regex false-rejects compliant judges — `decideSignOff`, src/index.ts**

```ts
const checks = /^checks:\s*\n(?:-\s+.+\n)+VERDICT:/im.test(judge.output);
```

This requires the last `- ` bullet to be *immediately* followed by `VERDICT:` with no blank line, and requires the heading to be exactly `checks:` at line start. Nothing in `judgeSystem` tells the judge not to separate sections with a blank line (models habitually emit `…bullet\n\nVERDICT: accept`), and a judge writing `## checks:` or `**checks:**` also fails. Result: a valid accept *with* a real checked-artifact list is rejected, and the working agent gets a "Missing: checked-artifact list" reply it already satisfied — a retry loop against a nondeterministic judge. It's fail-closed (never accepts without the list, so the hard requirement holds), but as written it will produce systematic false rejects. Allow optional blank lines / formatting, e.g. `/^#*\s*checks:\s*\n(?:[-*]\s+.+\n)+\s*VERDICT:/im`.

**3. Judge transcript files collide within the same minute — CompleteGoal `execute`, src/index.ts**

```ts
const rel = `.pi/judge/${stamp().replace(/[: ]/g, "-")}.md`;
```

`stamp()` has minute resolution, so two sign-offs in the same minute (two goals signed off back-to-back — the common case) write the same `.pi/judge/<stamp>.md` path and the second silently overwrites the first's full transcript, contradicting "every run saves the judge's full transcript … referenced from the log line" (both log lines then cite one file containing only the second run). Add seconds or a short unique suffix.

## Minor / cosmetic

- Misindented closing `}` of the `if (!checks)` block in `decideSignOff` (extra indentation on the `}` line) — likely flagged by `biome check src/`, which `prepublishOnly` runs.
- In plan mode, if the agent drafts a plan with no recognizable `goal:` checkbox line, the `agent_end` `while (scanGoals(...).length > 0)` loop never shows the Ready menu and plan mode can't be exited via the menu; the "no recognizable goal line" nudge in `dueInjection` only fires in the *non*-plan-mode branch. Not one of the five required behaviors, but a reachable dead end (escape hatch is `/goals clear`).

## Behaviors verified as correct

- **Versioning**: each ordinary `/goals` writes a fresh `<session_id>-vN.md` (empty reservation) via `nextPlanVersion` (max+1, so no clobbering); prior versions are never touched; legacy unversioned names are ignored by `nextPlanVersion` and never read — consistent with the intentional breaking change. `planVersion` is persisted via `appendEntry` and restored in `session_start`, so it survives resume/reload.
- **Visible plan before Ready**: `pi.sendMessage({ customType: "plan", content: plan, display: true })` fires before `ctx.ui.select(...)`, and re-prints inside the `$EDITOR` loop when the text changed. `sendMessage`+`display: true` is the documented visible-transcript mechanism.
- **Grill me**: sets `skipReadyMenu`, queues the single understanding-check question as a followUp user message, and consumes the skip at the next `agent_end` — so no Ready offer exists between asking the question and the human's reply being processed. `skipReadyMenu` is persisted, so it survives resume mid-grill.
- **Judge**: `buildJudgeArgs` yields `pi -p --no-session --no-extensions --tools read,grep,find,ls --exclude-tools edit,write`; `judgeUser` embeds the complete plan file; `judgeSystem` demands per-artifact verbatim quotes framed as an inspectable record ("not hidden reasoning", "no bullet for a file you did not open"); an accept without the `checks:` list is rejected in `decideSignOff` (subject to defect 2); full transcript persisted per run (subject to defect 3).

Main caveat: I could not execute `git diff` or `npm test` here, so I can't confirm the exact diff boundaries or that the focused vitest cases (judge argv invariants, `appendLog`, `decideSignOff` fail-forward) pass — defects 1–3 are from source inspection, not reproduced runs. Not approved as-is; defects 1 and 2 are worth fixing before merge.