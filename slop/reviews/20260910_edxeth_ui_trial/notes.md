# Visible worker trial and design interview

## Observed trial

- pi-goals branch: `experiment/main-supervisor-visible-worker`, created from `2a7c490eb9e1a2455d1b34e9d184a4ab13c75d77`; pre-existing dirty files preserved. Other same-checkout session acknowledged the branch change.
- Candidate: edxeth/pi-subagents v2.9.0, `953c6f6d2fc7d8a5c956c30cd77c51bad697c2a4`, loaded from its previously inspected temporary source clone.
- No package installation or global settings change. Temporary profile: `/tmp/pi-goals-edxeth-trial-YxPEE5/profile`. It loads only this candidate extension and reuses existing credentials/catalog through symlinks; no credentials in this report.
- Temporary Git repo: `/tmp/pi-goals-edxeth-trial-YxPEE5/repo`.
- Parent: Herdr `w8:p63`, agent name `edxeth-trial`, OpenAI Codex Terra medium. Child: `w8:p64`, Fireworks DeepSeek V4 Flash 0731. Both are real interactive Pi processes.
- Parent startup used the temporary profile and `pi --offline --no-skills --no-prompt-templates --no-context-files --no-approve --model openai-codex/gpt-5.6-terra --thinking medium --name 'edxeth trial supervisor'`.
- Parent delegated the small TypeScript demo. Child created `hello.ts` and `verify.log`; parent did not implement them. I read both files. Saved verification contains: `byte-exact match: PASS` and `output:      "Hello, World!"`.
- Evidence: [worker capture](worker.txt), [worker ANSI capture](worker.ansi), [supervisor capture](supervisor.txt). These show normal Pi messages, tool output and a fenced TypeScript result. No screenshot was generated.
- User observation: "oh i see the subagent go, it's looking goo so far".
- Intervention: child was explicitly instructed not to call `subagent_done`, so the user could inspect its pane. This is a UI preview, NOT a test of automatic completion, parent wake, restart, reload, compaction, or sign-off.
- Parent session: `/tmp/pi-goals-edxeth-trial-YxPEE5/profile/sessions/--tmp-pi-goals-edxeth-trial-YxPEE5-repo--/2026-09-10T01-35-13-055Z_01a088f4-649f-72be-98d4-2fac04240dd4.jsonl`.
- Worker session: `/tmp/pi-goals-edxeth-trial-YxPEE5/profile/sessions/--tmp-pi-goals-edxeth-trial-YxPEE5-repo--/2026-09-10T01-35-45-560Z_78e1b19f-b106837a-d9a7fe20-a349.jsonl`.

## Interview: user wording

> q1 1) on stop (without process or subagent running) 2) every 60 minutes 3) on check of or change in plan
> note if we want to be simple we can use pi-scheduled prompt to tell supervisor to check in?
> how will supervisor view subagent in token efficient way?

> q2 hmm i was thinking the worker does but yeah in this model maybe the supervisor... it's just I wanted an independant check where the supervisor is on a ralph loop and has perspective, perhaps read only (or partial)

> q3 yes we can patch if needed, hopefully we don't need to

> if we have to patch it might be easier to patch or extent the main subagent packages idlk

## Preference summary (user wording now recorded in AGENTS.md)

- Main conversation is the stronger supervisor; cheaper workers do implementation in separate contexts.
- Human sees full interactive worker Pi panes with normal Markdown/code rendering, not raw transcript inspectors. Supervisor judgment/messages remain visible too.
- Review after worker stops with no active background work, every 60 minutes, and when plan checkboxes or content change. Clarify whether "check of" also includes an explicit manual review request.
- Independent supervisor judgment and autonomous continuation remain required. Plan ownership and scope of read-only restrictions are not settled.
- Prefer editable prompts and existing subagent/scheduling capabilities over custom lifecycle code. Patches are acceptable if needed; edxeth is a candidate, not an irrevocable package choice.

## Proposed design, not yet approved

- pi-schedule-prompt can deliver a session-bound `1h` interval with no model override, waking the existing supervisor instead of creating a stateless judge. Source: installed `src/scheduler.ts` uses `sendUserMessage(job.prompt, { deliverAs: "followUp" })`; schedules fire only while Pi is open. This does not supply stop/plan-change events.
- Supervisor reads a bounded factual worker update: active work, last substantive message, changed paths, verification paths, and plan changes. Inspect the produced files, saved verification output, and relevant source lines or worker messages when needed; worker summaries are claims, not independent checks. Cross-session background activity reporting is an unresolved integration contract.
- Proposed partial read-only role: supervisor may inspect project state and update the plan/verdict, but delegates implementation. No decision yet to remove exact-state approval checks.

## Lifecycle test and runner failures

- [Lifecycle report](interactive-lifecycle.md): direct worker input, model picker and Escape cancellation worked. A naturally finished manual worker stayed open but did not trigger parent verification. `/tree`, resume, fast completion and background-work conditions remain untested.
- [Actual reload capture](lifecycle-captures/parent-reload-final.txt): `Error: This extension ctx is stale after session replacement or reload.` The stack reaches `running-registry.ts:255` through `updateWidget`. Reload closed the worker and crashed the parent. This is separate from the test-runner failure below.
- [Runtime/script review](minimal-runtime-contract.md): identifies missing settled-turn notification and live steering, recommends one hourly timer, and specifies session-pair discovery, per-session usage and launch provenance. These are source-based recommendations, not implemented behavior.
- Current Nicobailon runner: both original children ended `Request was aborted` after saving their reports, receiving queued follow-ups, and beginning another request. For lifecycle run `16e3531f-4ecd-4535-9e09-09e2f86daf61`, the session records final output at `01:54:44.336Z`, follow-up at `01:54:44.338Z`, then abort at `01:54:45.339Z`. A follow-up timing defect is plausible; the cause is unconfirmed. The workflow completion notification does not make these child statuses successful.
- Reviewer follow-up recovered through same-protocol resume as `dcd54919-94e7-4cf0-8901-c985cde9920a`; its script addendum is saved. No lifecycle retry was needed to recover the already-written report. No alternate executor was used.
- Repository check after failure: branch `experiment/main-supervisor-visible-worker`, HEAD `2a7c490eb9e1a2455d1b34e9d184a4ab13c75d77`; existing dirty files preserved, no `src/` or `test/` changes, candidate checkout clean. Only isolated test workspace `w9` was cleaned up; the original demo panes were not touched.

-- Pi/OpenAI
