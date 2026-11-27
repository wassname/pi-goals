# pi-goals architecture history

<!-- PI/OpenAI: counted historical snapshots and compared published peer packages, 2026-11-27. -->

`pi-goals` started as a Markdown plan and a sign-off judge. In July the prompt defaulted to **one goal**. In September the project tried both automatic continuation and a separate supervisor. It then returned to one working agent, with the stock scheduler and a fresh sign-off judge. Tasks later moved into the goals file and widget.

## Major versions of the design

| Date | Commit | Source lines | What changed |
|---|---|---:|---|
| Jun 15 | [`d97b532`](https://github.com/wassname/pi-goals/commit/d97b532) | 721 | `pi-plan`: one `plan.md`, human Ready menu, widget, sign-off judge. |
| Jul 3 | [`c0f80b8`](https://github.com/wassname/pi-goals/commit/c0f80b8) | 429 | Removed the structured parser. Defaulted to one goal; tasks only for three or more steps. Still kept an optional checklist and a Log. |
| Sep 1 | [`f09d443`](https://github.com/wassname/pi-goals/commit/f09d443) | 932 | Opt-in private timer. On settle, try one immediate wake if the run didn't start background work; otherwise use the interval. It inferred background work from tool calls rather than checking live jobs. Two wakes without a change above the Log paused continuation. |
| Sep 9 | [`b0759fe`](https://github.com/wassname/pi-goals/commit/b0759fe) | 4,046 | Supervisor/worker experiments grew to track pane attachment, recovery, and independent progress. Earlier checkpoints: retained worker (`f87b8aa`), visible supervisor (`d56fc55`). |
| Sep 20 | [`149d27e`](https://github.com/wassname/pi-goals/commit/149d27e) | 1,618 | Supervisor/worker branch: the supervisor chose when a worker stop needed formal review. Routine progress and waiting did not trigger one automatically. |
| Sep 24 | [`0ca344d`](https://github.com/wassname/pi-goals/commit/0ca344d) | 581 | One working agent, stock scheduler, and a fresh read-only pi-subagents judge on `CompleteGoal`. Removed the private timer and its idle continuation. Made the main line on Oct 5 (`d06505f`); the supervisor branch remains in Git. |
| Oct 9 | [`608080e`](https://github.com/wassname/pi-goals/commit/608080e) | 700 | Goals file became the task list. Shows tasks at wakes and in the widget; disables `TaskCreate` during goal work. |
| Nov 7 | [`8f4bac5`](https://github.com/wassname/pi-goals/commit/8f4bac5) | 776 | Shortened wakes to the loop statement, aim, goal status, and open tasks sorted by age. Oct 28 had switched parsing to CommonMark (`30287dd`, 799 lines). |
| Nov 25 | [`6e8c127`](https://github.com/wassname/pi-goals/commit/6e8c127) | 1,076 | Snapshot after scheduler receipt/retry handling and an expandable task widget. Ready starts work even if reminder setup fails (`9ed41d2`). |

The September stock-scheduler design already asked for roughly **50 lines above `## Log`**, excluding User voice. The one-page intent was there; the file still doubled as a task list and history. From that rewrite to the Nov 25 snapshot, source grew by **495** nonblank lines: `index.ts` +220, `goals.ts` +181, prompts +71, scheduler integration +17, judge +6. This counts where code grew, not which additions caused session drift.

### Architecture tags

Dates are the tagged commits' dates. These are history markers, not releases. **Retired** means the execution design was removed from main; the commits are still readable.

| Tag | Status |
|---|---|
| `arch/2026-06-15-plan-md-signoff-judge` | Historical: original Markdown plan and sign-off. |
| `arch/2026-07-03-one-goal-md-signoff-judge` | Historical: smallest one-goal reference. |
| `arch/2026-09-01-retired-private-timer-idle-check` | Retired: opt-in idle continuation with its own timer. |
| `arch/2026-09-09-retired-two-session-supervisor-worker` | Retired: persistent supervisor and separate worker session. |
| `arch/2026-09-20-retired-two-session-selective-stop-review` | Retired as an execution design; selective review is reusable without a supervisor session. |
| `arch/2026-09-24-one-agent-stock-scheduler-fresh-judge` | Basis of main: one worker, stock reminders, fresh completion judge. |
| `arch/2026-10-09-goals-md-replaces-task-tool` | Still on main: the goals file doubles as the task list. |

The [Sep 23 review](https://github.com/wassname/pi-goals/commit/3f88ab4) records a failure of the separate supervisor as a reference judge. The [Oct 5 merge](https://github.com/wassname/pi-goals/commit/d06505f) moved main to the one-agent design.

## Peer packages

This was a size comparison of selected peers. See [how agent harnesses keep working toward a goal](goal-implementations.md) for the broader survey, GitHub metrics, and full prompt wording.

Nonblank production source lines, including comments and inline prompts; excludes tests, declaration files, generated copies, dependencies, and Markdown. Counts use published source where available, otherwise the source at the release commit. `Authors*` counts distinct non-bot Git contributors (package path only for collections). Git attribution does not tell who wrote code with an agent. Local `pi-goals` history shows one identifiable human maintainer account family, wassname/Michael J Clark, and several explicitly credited agents.

| Package | Lines | Authors* | What it does at a stop |
|---|---:|---:|---|
| [`@mrq/pi-goal` 0.1.0](https://github.com/mrq1911/pi-goal) | 366 | 1 | Same model reviews the existing conversation at every stop. Not a fresh point of view. |
| [`@junjiezhou1122/pi-goal` 0.2.4](https://github.com/junjiezhou1122/pi-goal) | 864 | 4 | Fresh verifier process for explicit done/blocked claims. Author count includes fork history; not four maintainers of this variant. |
| `pi-goals` at `6e8c127` | 1,076 | 1 + agents | Periodic wake; fresh judge only for `CompleteGoal`. |
| [`@matthewlam/pi-goal` 0.3.0](https://github.com/minghinmatthewlam/pi-goal) | 1,267 | 1 | Continues at idle without a timer; has stop guards, including a no-progress audit. |
| [`@hheei/pi-goal` 0.1.1](https://github.com/hheei/pi-mono/tree/1c7505b57704/packages/pi-goal) | 2,033 | 2 | Native continuation for one goal; optional completion review through its subagents integration. |
| [`@piex-dev/goal` 0.1.0](https://github.com/piex-dev/piex/tree/0ddf54e9d147e0801c0944c1f6035f19eaf043e8/extensions/goal) | 2,457 | 1 | Native idle continuation with explicit completion/block tools. |
| [`pi-better-goal` 0.17.1](https://github.com/1aboveio/pi-better-harness/tree/main/packages/pi-better-goal) | 4,703 | 1 | Waits for background work reported by registered providers; manages retries and wakes. |
| [`pi-codex-goal` 0.7.11](https://github.com/fitchmultz/pi-codex-goal) | 5,663 | 4 | Distinct waiting state for jobs that deliver their own results; explicit stop/recovery handling. |

For local counts, run `git grep -I -h -e '[^[:space:]]' REV -- ':(glob)src/**/*.ts' ':(glob)src/**/*.mts' ':(glob)src/**/*.mjs' ':!*.d.ts' | wc -l`. For peers, apply the same nonblank count to the package's TypeScript/JavaScript source directories (include the `extensions` entrypoint for `pi-codex-goal`, not compiled `dist` files); no package code was run.

**Reference points for a smaller design:** `c0f80b8` for the one-goal Markdown plan, `f09d443` for distinguishing a quiet agent from background work, `149d27e` for selective stop review, and `0ca344d` for stock scheduling without a separate supervisor. None of these snapshots combines all four choices.
