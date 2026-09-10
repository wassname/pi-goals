# Overnight supervision: strong judgment, cheaper execution, visible workers

Research by Pi/OpenAI, 2026-09-10. Read-only investigation; no packages were installed or loaded, no settings were changed, and no existing agent sessions were operated. The earlier isolated edxeth prototype is the only local end-to-end experiment cited here.

## Recommendation

Keep the main-chat supervisor prototype for the next experiment. Give it one cheaper worker, an approved plan, and outcome-based handoffs. Do not add a crew, a third supervisor or a second task database yet.

The strongest alternatives to investigate are:

1. **Codex's native Goal plus subagents**, if changing harness is acceptable. The current release already contains persistent goal continuation, token accounting and an agent-thread picker.
2. **Hermes delegation**, for an integrated strong-parent/cheap-worker setup with compact reports, steering and background-result delivery. Its docs explicitly describe this cost strategy. Unfinished child execution does not survive a process restart.
3. **A separate Pi supervisor over a Codex worker's native Goal**, as implemented by `hao1939/herdr-supervisor`. This is the closest external design to “let the worker continue overnight; ask a smart supervisor only when needed.” Its container setup and current automatic-review tool restrictions are trade-offs.

For our Pi/Herdr implementation, edxeth remains the locally demonstrated launch/resume option. Herdsman is a plausible transport replacement to evaluate, not an established improvement. The much smaller kirel implementation keeps panes open, but its reuse and recovery code has gaps that matter overnight.

## What actually saves money

A cheaper worker does not necessarily use fewer tokens. It can take more attempts, need more corrections, or fail work the stronger model finishes directly. The target should be **cost per verified outcome**, with time and human interventions recorded beside it.

My proposed division:

- The supervisor owns the objective, constraints, choices and final judgment. It can inspect actual files, logs and results rather than being limited to workers' claims.
- The worker owns execution details. It receives a bounded task with the relevant plan section, evidence expectations and scope, not the entire planning transcript.
- Wake the supervisor for a result, a real question, a failure, a material plan change or a genuinely overdue checkpoint. A deterministic watcher can observe unchanged state without an LLM call.
- Return a short account of what changed and what the evidence shows, with paths to raw evidence. Keep raw output out of routine handoffs, but make it available for targeted inspection.
- Preserve the original objective. “The worker produced a plausible summary” is not completion. Equally, a supervisor's own preference to review a step must not become a fabricated human approval gate.

The break-even condition is simply:

`cheap-worker cost + supervisor reviews + retries < strong-agent-alone cost at comparable completion quality`.

Caching, hidden reasoning charges, provider prices and repeated full-profile initialization belong in that measurement. A supervisor that reads every tool result or wakes on every turn can eliminate the saving. Anthropic's research result below is evidence for better breadth, not for lower token use.

## The available designs

| Design | Fit for this request | What the supervisor sees | Main trade-off |
|---|---|---|---|
| Strong main chat → one cheaper interactive worker | Best next experiment | Approved plan, compact reports, targeted raw evidence | Must distinguish waiting for a worker from stopping the whole goal |
| Independent strong observer → standing worker | Good for long continuous runs | Event-triggered bounded worker overview | Adds identity, delivery and recovery between sessions |
| Cheap main worker → occasional strong reviewer | Smallest change to a solo workflow | Milestone/failure review or final artifact check | Less strategic oversight between reviews |
| Durable task engine with worker/reviewer loops | Good for a large coding backlog | Task state, reviews, merge results | More machinery and a stronger prescribed workflow |
| Deep-research fan-out | Good for broad research questions | Compressed independent research findings | More total work/tokens; not inherently overnight execution management |
| Same transcript with alternating cheap/strong models | Simple-looking, poor fit here | Both models inherit the same execution history | Context cost, role confusion and our provider-bound encrypted-history constraints |

These are design judgments, not benchmark rankings.

## Harness comparison

### Codex: native Goal is now relevant

Inspected release `rust-v0.154.0` (published 2026-09-09), not just an old multi-agent tutorial.

The release's [feature registry](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/features/src/lib.rs) marks `goals` and ordinary `multi_agent` stable and enabled by default; `multi_agent_v2` is stable but disabled by default. Its native Goal stores an objective and status, continues across turns, and supports optional token budgets. `/goal` has edit/pause/resume/clear controls. The model can mark a goal complete or blocked; pause/resume and budget changes are not model-owned through that tool. The continuation prompt asks for real progress, verified waits, current-state evidence and preservation of the full objective.

From the [released continuation prompt](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/ext/goal/templates/goals/continuation.md):

> - This goal persists across turns. Ending this turn does not require shrinking the objective to what fits now.
> - Keep the full objective intact. If it cannot be finished now, make concrete progress toward the real requested end state, leave the goal active, and do not redefine success around a smaller or easier task.
> - Temporary rough edges are acceptable while the work is moving in the right direction. Completion still requires the requested end state to be true and verified.

This is an OpenAI-shipped model instruction, not an independent semantic verifier. The model still has to apply the judgment correctly. Its three-turn blocked audit is a product policy, not a law we need to copy.

The [released subagent tool definitions](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tools/handlers/multi_agents_spec.rs) distinguish sending a message from triggering more work. In the opt-in V2 interface, `send_message` says “Does not trigger a new turn”; `followup_task` explicitly triggers an idle target. This is the same distinction our prototype's Ready bug exposed: transport acceptance and continuation are separate facts.

Children inherit the current model by default; explicit model/reasoning overrides exist but exposure depends on the multi-agent version and available model capabilities. Do not assume every Codex model/UI combination exposes every source-level control. [Goal accounting](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/ext/goal/src/accounting.rs) includes descendant token usage. [The agent picker](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/tui/src/app/agent_picker.rs) queries descendant threads and tracks whether they accept direct input; some remain parent-owned. This is a native thread UI, not necessarily a separately attached Herdr terminal for each child.

**Assessment:** a credible alternative needing less custom goal-runtime code. Test the released UI, model override and restart behaviour on the intended account before migrating. The source does not by itself prove unattended completion or cheap-worker quality.

### Hermes: explicit frontier-planner/inexpensive-worker design

The [delegation documentation](https://github.com/NousResearch/hermes-agent/blob/v2026.9.7/website/docs/user-guide/features/delegation.md) describes fresh child contexts whose final summaries return to the parent:

> The `delegate_task` tool spawns child AIAgent instances with isolated context, inherited tool access, and their own terminal sessions. Each child gets a fresh conversation and works independently — only its final summary enters the parent's context.
>
> Top-level model calls run in the background automatically. Hermes returns a handle immediately so the conversation can continue, then posts the result back as a new message. An orchestrator subagent waits for its own workers so it can synthesize their results before returning.

It has a section literally called “Cost strategy: frontier planner, inexpensive workers.” `delegation.model` selects the cheaper child model while the main model stays strong. This is a configuration-wide delegation pin, not a per-task model field. A separate `auxiliary.review` can select the reviewer model.

The important durability qualification is explicit:

> This does not resume child execution after a crash. A delegation whose owner process disappears while it is still running is recorded as `unknown`, because Hermes cannot prove whether its external side effects happened. Pending and delivered records are bounded and profile-local.

Completed-but-undelivered results are persisted. That is different from resuming unfinished execution. [Cron](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/cron.md) offers scheduled separate runs and a no-agent/script-only mode; neither should be described as transparently restoring an interrupted child.

Users can inspect subagent history and control workers through the TUI. Current `main` adds more detailed CLI/Desktop live rosters and steering, but I checked the release delta: those additions are not all in `v2026.9.7`. Likewise `main` changes documented defaults from 3 to 10 concurrent children and from 50 to 250 iterations. Do not copy current-site defaults into an older release configuration.

The released docs distinguish progress-based stall detection from a wall-clock cap and default to no child wall-clock timeout. That is relevant to our slow-Copilot failure: a busy provider request should not be declared dead merely because a short observation deadline expired.

**Assessment:** strongest integrated match outside our current Pi setup. Its child terminal sessions are AIAgent execution environments, not automatically independent full CLI panes. A TUI viewer with steering is useful, but differs from your preferred full interactive Pi worker.

### OpenCode: configurable primary/subagent roles, inspectable child sessions

[Agent docs](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/agents.mdx) expose per-agent models, prompts and permissions. A custom primary supervisor can delegate to a cheaper coding subagent and remain the user's main conversation. Built-in Plan and Build are alternate primary roles; switching Plan → Build alone is not a supervising pair.

> When subagents create child sessions, use `session_child_first` (default: **\<Leader>+Down**) to enter the first child session from the parent.

The following documented controls navigate child siblings and return to the parent. This gives real child-session inspection inside OpenCode without another terminal package.

In [release v1.18.30's Task implementation](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/tool/task.ts), `task_id` continues a saved child session. The child uses its configured model or inherits the parent's model. The tool returns the child's final text rather than its entire execution trace. Foreground is the default. Background tasks exist but require `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` in this release, so async support is not an unconditional default.

**Assessment:** an economical built-in hierarchy with useful child navigation. A plan-driven overnight continuation and completion policy still needs to be supplied. I did not establish crash-resumable execution from the Task source; a saved session ID alone is insufficient proof.

### Pi: choose the runtime; keep goal policy small

The installed Pi README is explicit:

> **No sub-agents.** There's many ways to do this. Spawn pi instances via tmux, or build your own with [extensions](https://github.com/earendil-works/pi), or install a package that does it your way.

Pi intentionally leaves plan mode and subagent policy to extensions. Our [earlier functional report](edxeth-prototype/README.md) demonstrates the main-chat design with edxeth: two goals, one saved worker session, real Herdr Pi interface, parent evidence checks, and no operator nudge after Ready in the corrected run. Both roles used the same model. **It does not demonstrate the proposed cost saving or an overnight run.**

Nicobailon's [v0.66.0 extension API](https://github.com/nicobailon/pi-subagents/blob/v0.66.0/docs/extension-api.md) confirms the visibility distinction:

> The inspector is a raw dashboard pane, not the child session and not a literal attach. It reads lifecycle/status/output/mission artifacts and sends `steer` or `stop` through pi-subagents' existing control inbox. Closing it never stops the run.
>
> Herdr remains optional. Ordinary launches stay headless, and missing/older Herdr versions affect only Herdr-specific inspector and project-pane actions.

Its `project.open` API creates a full independent project peer, but the same documentation says existing headless runs are not moved into that pane and the caller does not own the peer's nested subagents. The extension API is useful; it does not remove that architectural distinction.

### Deep research and Claude-style teams: borrow compression, not automatic fan-out

Anthropic describes an Opus lead with Sonnet research subagents and reports a 90.2% improvement over single-agent Opus on its own internal research evaluation. It also states:

> In our data, agents typically use about 4× more tokens than chat interactions, and multi-agent systems use about 15× more tokens than chats. For economic viability, multi-agent systems require tasks where the value of the task is high enough to pay for the increased performance.

Source: [Anthropic, How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system). These are vendor-reported research results. The 15× denominator is ordinary chats, not a matched overnight coding task, and the 90.2% figure is not a money-saving result.

The transferable idea is independent context windows that compress findings into evidence-backed handoffs. Parallelism helps questions that genuinely divide into independent searches. It can waste money on a serial implementation task or cause several agents to duplicate investigation.

OpenAI's [Deep Research API](https://developers.openai.com/api/docs/guides/deep-research) takes web/file/MCP data sources and can use code interpreter for analysis. Its asynchronous/background execution is useful for long research requests; it is not itself a persistent plan/worker/Herdr supervisor. Claude Code's [agent teams](https://code.claude.com/docs/en/agent-teams) likewise document coordination overhead and significantly more tokens than a single session. Prefer a manager with one bounded helper before adopting a team.

## Pi and Herdr packages worth distinguishing

Ranked by usefulness for this particular next decision, not by stars or breadth.

| Package | Verdict | What to borrow or test | Main reservation |
|---|---|---|---|
| [edxeth/pi-subagents](https://github.com/edxeth/pi-subagents) | Continue our prototype | Full Pi workers, async reports, exact saved-session resume | Auto-exit versus pane persistence; full profiles multiply MCP/process overhead |
| [hao1939/herdr-supervisor](https://github.com/hao1939/herdr-supervisor) | Closest external overnight design | Native Codex Goal keeps the worker moving; event-driven Pi judgment | Container-first, Node ≥26 locally; automatic reviews narrow supervisor tools |
| [boadij/pi-herdsman](https://github.com/boadij/pi-herdsman) | Evaluate as a transport alternative | Durable assignment/mailbox state, identity-aware recovery and active steering | Very young; chief mode strips ordinary tools/skills and adds ephemeral context |
| [monotykamary/pi-supervisor](https://github.com/monotykamary/pi-supervisor) | Useful observer/reference | Algorithmic VCC-style overview; reviews at idle/errors/selected mid-run points | In-memory observer has no inspection tools; not a full supervisor pane |
| [HenryLach/taskplane](https://github.com/HenryLach/taskplane) | For a backlog, not our first pair | Persistent task state, worker/reviewer loops, dashboard, recovery | Worktrees, merges and review gates add a prescribed workflow |
| [kirel/herdr-subagents](https://github.com/kirel/herdr-subagents) | UX reference, not overnight-ready | Completion tool reports while keeping the full Pi pane open | Name reuse can create another process for the same session; no watcher restart state |

### What makes the alternatives different

**Herdr Supervisor** states its division of responsibility directly:

> The model decides what current evidence means. Small deterministic code records goals, observes events, validates identity, and applies the chosen action. Herdr hosts the sessions and events; it is runtime plumbing for this model.

Its [README](https://github.com/hao1939/herdr-supervisor#how-it-works) says Codex owns the ordinary work/check/continue loop. The Pi supervisor wakes on Herdr events or review deadlines and chooses leave, steer, ask_human or accept. The default safety/global review interval is an hour, while real events wake immediately. An external watcher performs provider scans without model turns. This avoids paying for “nothing changed” reviews every minute.

Recent [PR #92](https://github.com/hao1939/herdr-supervisor/pull/92) fixes a supervisor treating its own step limit as a human stop; [#88](https://github.com/hao1939/herdr-supervisor/pull/88) stops unjustified short rechecks of unchanged watched PRs. Those are author-reported live lessons closely matching our earlier failures. They are not independent proof that this package is more stable. Its `stop` semantics also differ: stopping supervision does not stop the worker.

**Herdsman** documents reconstruction of exact live managed identities from durable mailbox state after controller restart. Unknown state stays unknown, and an active/unresolved saved session cannot be activated concurrently. It has a public `agent` coordination API and human `/agents` UI. That is a more relevant API candidate than trying to make a headless inspector behave as an interactive worker.

However, its [chief mode](https://github.com/boadij/pi-herdsman/blob/main/docs/concepts/supervision.md) “exposes exactly the `staff` tool and excludes project/workspace context files and skills.” It also documents ephemeral `<supervision_state>` provider context. Neither fits our full-inspection supervisor or our native encrypted-replay constraint without further checks. Normal lead/worker delegation may be the appropriate subset. Completed generations are cleaned up; continuation uses the saved session, not a permanent live pane.

**pi-supervisor** compiles a structured overview without an LLM summary call. That zero-API-cost claim refers to context construction, not to the supervisor's analysis call. The [actual session source](https://github.com/monotykamary/pi-supervisor/blob/master/src/session/supervisor-session.ts) constructs an in-memory session with `noExtensions: true`, `noSkills: true`, and `tools: []`. It cannot independently open a cited artifact. The reusable supervisor session also accumulates analyses; “stateless summary” should not be read as zero retained model history. Its prompt's sensible-default/“speaks AS the user” instructions should not be copied into a system where permission and explicit human pauses matter.

**kirel** genuinely implements the keep-open completion callback. But [index.ts](https://github.com/kirel/herdr-subagents/blob/main/index.ts) derives global session/exit paths from a name, deletes the old exit file and unconditionally creates a new pane on each call. There is no corresponding live-occupant reuse check. Reusing the same name can therefore start two Pi processes on the same JSONL if the first pane is still open. Its completion watcher is an in-memory polling loop with a default 1,800,000 ms deadline and no persisted restart handler. [child.ts](https://github.com/kirel/herdr-subagents/blob/main/child.ts) writes the completion file without closing Pi. These are source-level observations, not a live reproduction. Borrow the report-without-exit idea; do not mistake the small implementation for a durable overnight runtime.

Other candidates found in the scan:

- [Pi Messenger](https://github.com/nicobailon/pi-messenger): separate peer messaging and Crew plan/work/review waves. `autonomous:true` works through ready tasks until done or blocked; model configuration can make workers cheap. Useful, but it adds a task graph/reservation/workflow layer rather than just a visible worker launcher.
- [pi-fleet](https://github.com/picassio/pi-fleet): remote RPC workers and bundle provisioning over a tailnet. This solves cross-device control, not goal judgment. Its README still labels status “Pre-implementation” despite describing commands; readiness needs independent verification.
- [pier](https://github.com/July24/pier): todo loop plus interactive Pi panes and a Herdr workbench plugin, with human takeover, locks and lifecycle handling. Closer to a full workspace product; it changes more of the current setup and documents tool/hook conflicts. Not inspected deeply enough to recommend installation.
- [holistic-subagents](https://github.com/leoszr/holistic-subagents): keeps reusable agent sessions distinct from bounded delegation runs and offers persistent authenticated callbacks. That separation is worth examining for keep-open workers. Its model policy and broader coordination layer need review before adoption.
- [pi-goal-list-loop-audit](https://github.com/DraconDev/pi-goal-list-loop-audit): goal/list/loop continuation with a separate detached completion auditor. Good comparison for worker-plus-auditor, but its intentionally extension-free audit session is not the full visible supervisor requested here.
- [pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows): scripted fan-out, model tiers, real usage accounting and `/deep-research`. It keeps intermediate results in workflow variables. Its 3.x notes say subagents do not load host extensions by default; fresh in-memory workers and a workflow navigator do not satisfy the full interactive-worker requirement.

## Package maturity and compatibility

Snapshot from GitHub APIs, using the repository-metrics skill script. `humans*` counts non-bot GitHub contributor accounts, not a promise of active maintainers; fork ancestry can inflate that number. Issues exclude PRs. Repository age, stars and test counts did not determine the recommendation. All rows below are dedicated repos; edxeth and monotykamary are forks.

| Package | Fit | Pi/runtime declaration | humans* | stars | Created | Last code | Issues open/closed |
|---|---|---|---:|---:|---|---|---:|
| edxeth | Local prototype works | Pi ≥0.85.0; v2.9.0 inspected | 5 | 121 | 2026-04-16 | 2026-09-07 | 0/9 |
| hao1939 | Compare overnight design | Node ≥26; container-first v0.5.0 | 1 | 1 | 2026-08-29 | 2026-09-06 | 0/0 |
| Herdsman | Evaluate transport | README tested Pi ≥0.84.2 <0.86.0; peers `*`; v0.3.0 | 1 | 3 | 2026-09-07 | 2026-09-09 | 0/0 |
| monotykamary | Observer/reference | Pi ≥0.80.8; v0.5.19 | 2 | 4 | 2026-03-12 | 2026-09-05 | 0/0 |
| Taskplane | Backlog engine | Node ≥22; model defaults inherit | 2 | 214 | 2026-03-12 | 2026-09-08 | 24/137 |
| kirel | Keep-open UX only | Pi peer `*`; v1.0.0 | 1 | 3 | 2026-06-10 | 2026-06-19 | 0/0 |

Recent issue bodies were inspected, not only counted. Edxeth has an open Windows shell-launch PR [#25](https://github.com/edxeth/pi-subagents/pull/25), and closed manual-lifecycle clarification [#24](https://github.com/edxeth/pi-subagents/pull/24). Its full-process/MCP overhead report [#17](https://github.com/edxeth/pi-subagents/issues/17) supports starting with one worker. Taskplane has recent Windows argv-length and scheduler-wave reports; its machinery has real costs as well as recovery benefits. Herdsman has an open native-contract consolidation PR and is only days old. No open issues is weak evidence when a project is young or lightly used.

## Smallest next experiment

Do not migrate again based on README claims. Compare three configurations on the same representative, bounded task: strong agent alone; cheap agent alone; strong supervisor plus cheap worker. Add a worker-plus-periodic-critic variant only if it answers a remaining question.

Use the current prototype and an explicitly selected cheaper worker model. Keep one writer. Record verified outcomes, total input/cache/output/reasoning usage by role where exposed, actual provider charges or quota use, elapsed time, supervisor interventions, human interventions and recovery gaps. A cheaper failed attempt is not a saving.

For overnight acceptance, include a real multi-hour run and controlled failures in an isolated project: provider latency, a failed command, parent reload while the worker is active, worker exit, lost delivery, and a user pause. Verify the exact same worker/session resumes without duplicating side effects, the pause remains respected, and the next-morning report names actual evidence and unresolved work. Let budget and destructive-action permissions come from the user, not arbitrary package defaults.

The supervisor needs enough freedom to diagnose and improve the plan. Keep runtime rules about identity, delivery, persistence and user authority; leave the meaning of progress and completion to model judgment backed by inspectable evidence.

## Evidence limits

- Primary source and code inspection establish available mechanisms, not end-to-end reliability or token savings. The external packages were not executed in this research pass.
- Official-site direct fetches and the Pi gallery failed here with TLS connection resets. GitHub source, npm metadata and hosted web-search quotations supplied the evidence instead. Some recommendations remain intentionally at “evaluate.”
- [Inspected revision IDs](overnight-supervision-sources/source-revisions.jsonl) and [maintenance metadata](overnight-supervision-sources/maintenance.json) are saved beside this note. Downloaded public-source snapshots remain in `/tmp/pi-supervision-research`; use the linked upstream files and recorded revisions to reproduce the inspection. Codex and OpenCode code findings use named releases. Hermes release/main differences are explicitly separated. Other package findings refer to the inspected repository revisions.
- Confidence is high in the architecture distinctions and the source-level kirel/nicobailon observations; lower in comparative overnight stability and financial benefit. A matched cheaper-worker trial, not more package features, is the quickest way to change the recommendation.
