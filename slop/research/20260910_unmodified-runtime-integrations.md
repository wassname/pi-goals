# Unmodified Runtime Integrations — edxeth / pi-intercom / pi-schedule-prompt

Repo `pi-goals` @ fb5503f (experiment/main-supervisor-edxeth), entry `./src/prototype.ts` (package.json `pi.extensions`). Dirty tree = only slop event jsonl, `.local/`, `docs/human_journal.md` (confirmed). All edxeth quotes from `git -C pi-subagents-visible-worker show 953c6f6:PATH` (working tree is the dirty abandoned patch — ignored).

## 1. Stock edxeth parent↔worker messaging: exists but is re-launch not live injection

- Parent→worker: `subagent` / `subagent_resume` / `subagent_kill` (`src/tools/tool-names.ts`). Resume tool: "Continue a previous subagent session from its session file, optionally sending a follow-up task" (`src/tools/resume-tool.ts:63-83`). Follow-up is NOT injected into a live pane: `resume-service.ts:519-523` re-spawns the interactive session in a new mux surface and passes `piArgs.push(\`@${taskPath}\`)` (`writeResumeTaskArtifact`, task as initial-prompt artifact); background path feeds stdin `child.stdin?.end(expandedTask)` (`resume-service.ts:477`). There is no mid-run send-into-pane API.
- Overlay: same resume path; editor prompt "Write a follow-up message. Enter sends, Esc cancels." (`src/tools/overlay/controller.ts:383`).
- Worker→parent: `caller_ping` (one-shot; writes exit signal `{type:"ping"}`, `requestShutdown`, hard-exit backstop `process.exit(0)` at 750ms — `src/tools/caller-ping.ts:22-25,84-108`) and `subagent_done` (exit signal `{type:"done"}`). Registration: `if (!isInteractive || autoExit) registerCallerPingTool(...)` (`src/tools/subagent-done.ts:513-514`); `shouldRegisterSubagentDone` returns false for autoExit/interactive (`subagent-done.ts:48-51`). Results steer back to parent (`src/runtime/result-router.ts:76,169`).
- `goals-worker` agent def (`prototype/agents/goals-worker.md`): `mode: interactive`, `auto-exit: true`, `parent-close-policy: continue` → child gets `caller_ping`, not `subagent_done`, and auto-closes after a terminal turn (`src/auto-exit.ts` `shouldAutoExitOnAgentEnd`).

## 2. pi-intercom 0.13.0 (installed): safe delivery, targeting is "probable" not guaranteed

- Delivery is agent-loop queueing, NOT terminal/Enter injection: busy interactive → `sendIncomingBrokerMessage(entry, "steer")` (`pi-intercom/index.ts:1245-1268`); idle → `pi.sendMessage({customType:"intercom_message",...}, {triggerTurn:true})` else `{deliverAs:"steer"}` (`index.ts:1191-1200`). Pi API: `deliverAs: "steer" | "followUp" | "nextTurn"` queue on the agent loop, drained at tool/turn boundaries (`pi-coding-agent/dist/core/agent-session.d.ts:401-422`; `pi-agent-core/dist/agent.d.ts:84-94` steer = "injected after the current assistant turn finishes"). Inline renderer only (`ui/inline-message.ts:6`). No human-draft interference.
- Targeting: `to` = name, full session ID, or ID prefix; `cwd` scoping via `resolveTargetInCwd` (`project-agent.ts:188-240`). Presence name = `pi.getSessionName()` else runtime alias `subagent-chat-<id[:18]>` (`index.ts:494-512`). **Stock edxeth never sets `PI_SUBAGENT_INTERCOM_SESSION_NAME`** (git grep empty) → child is only addressable by its list/status ID or whatever its Pi session name resolves to; runtime aliases are excluded from queued-mail reconnection (README). Compatibility is *probable from source, not asserted by edxeth*.
- Auto-exit effect: intercom has no auto-exit awareness (only PI_SUBAGENT_* orchestration envs, `index.ts:42-51`). A triggered turn in an `auto-exit: true` child ends with close (stopReason≠aborted); Escape/abort leaves it open. So intercom works only while the pane is live; follow-ups after close should use `subagent_resume`.
- pi-messenger/pi-messenger-bridge: listed in `settings.json:107` but NOT in installed `node_modules` → **unverified**.

## 3. pi-schedule-prompt (installed): yes — tool-only add/list/remove suffices

- `add` binds current session by default: `const session = getDefaultScope() === "session" ? ctx.sessionManager.getSessionId() : undefined;` (`src/tool.ts:88-89`; default `"session"` at `tool.ts:17`, `index.ts:79`).
- Single-session firing: `isLoadedFor = !job.session || job.session === sessionId` (`src/scheduler.ts:61-62`), re-checked at fire (`scheduler.ts:211`).
- No-model inline: `this.pi.sendUserMessage(job.prompt, { deliverAs: "followUp" })` (`scheduler.ts:243`) — wakes only the owning session.
- Cleanup: `session_shutdown` → `autoCleanupDisabledJobs` (own/unbound disabled only) + `cleanupSession` stops scheduler/hides widget (`index.ts:105-133,143-145`). No duplication on reload: `initializeSession` calls `cleanupSession(ctx)` first — "Without this, every `session_start` (fires on reload/resume/fork too…) leaks a live croner timer… accumulating duplicate fires" (`index.ts:86-90`); non-startup `session_start` also sweeps disabled (`index.ts:136-140`). Storage: project-local `.pi/schedule-prompts.json` (`storage.ts:12-19`).

## Verdict / minimal integration

All three are source-verified; nothing executed (report only — no messages/jobs/panes). Minimal test: (a) in a live stock-edxeth child, `intercom({action:"list"})` from parent and send to the child's listed ID while idle and while thinking; confirm no draft/Enter artifacts; (b) `schedule_prompt` add (inline, no model) → list → remove in the parent session, then close/reopen to confirm no double-fire and disabled-job sweep. Use intercom for live steering (child pane open), `subagent_resume` for follow-ups after close; prefer a small script/prototype over framework.
