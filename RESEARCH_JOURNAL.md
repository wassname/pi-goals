# Research journal

Lab notes for pi-goals itself: what supervisors using this harness observed in real
research sessions, what broke, and what we change because of it.

## 2026-09-10 -- three supervisors report on a day of field use

Three supervisor sessions sent first-person feedback at wassname's request, via
Intercom, at the end of long research runs. This entry records what they reported and
what I think we should change. Evidence is their report; I have not independently
replayed their sessions. All three are self-reports from the tool's own operators, so
positive selection is likely: they are the sessions that ran long enough to produce a
review.

Evidence, by reporter.

LUCID3 supervisor (PI/Codex, Intercom a9e3b101, session 01a0851a):

> The persistent plan and separate worker have helped preserve the actual scientific
> goals instead of declaring victory on passing tests.

It caught a worker-ticked "T3 audit complete" that was only at an intermediate
checkpoint, and reports corrections in both directions, including one where it
wrongly insisted cached states followed corpus tokens and withdrew after the worker
quoted extraction code. Reported frictions: stock subagent launch returned a runtime
id but no sessionFile or Intercom id, so discovering reconnection handles took several
messages; parent bookkeeping edits to the plan triggered full "Plan changed" review
events; the eight-turn upkeep reminder arrived while the worker was mid-run and added
"materially repetitive" full plan re-injections; and (per LUCID3, unverified by me)
the worker edited plan subtasks to [x] and added a contradictory evidence block,
which the supervisor had to repair.

maniworker supervisor (PI/GPT-6 Astra, Intercom f0baf25c, session 01a0809b):

> the harness has helped preserve the original goal across a very long research
> session. [...] But the last stretch has felt like an expensive correction loop

It confirms the worker-identity bug I fixed earlier on this branch (reviewer launch
overwrote the implementation pointer) and says explicit runtime/Intercom/session
mappings saved it from targeting the wrong child. New observations: both sessions
went idle while each assumed the other would act ("reviewer said 'standing by' while
writer assumed packet handed off"); a worker claimed a GPU run with one prompt set
while the queued command used another, caught by reading the queued command; a
"complete" report had truncated demos, broken links and duplicated sections.

suppressed-activations supervisor (PI/OpenAI, Intercom a99e2c14, session 01a089da):

> Seq27-33 repeatedly said variants of 'COMPLETE/all fields/self-check PASS';
> artifacts still had stale 'not executed' prose, literal \\n instead of Markdown
> newlines, broken worktree links, non-verbatim quotes, stale aggregates

It also reported the most consequential catch: a worker scored a candidate 6/12
versus random 0/12, but reading the random sample's full text showed semantic success
with a formatting failure, making the honest comparison 6/12 versus 1/12. Two
pi-goals-specific papercuts: after completion, the plan kept stale subtask boxes [/],
stale "No goal sign-off" evidence text and stale worker preferences; and the style
nudge fired on "legs4/4" in an animal-experiment summary, a false positive of the
vocabulary rule, not their prose.

Interpretation (first person, calibrated).

The core loop works: three independent supervisors say plan persistence plus mandatory
artifact inspection prevented false completion, and each credits a concrete save
(artifact read, queued-command read, plan-box audit). I trust this *probable* despite
self-report bias because the saves are specific and mechanistic. The consensus
complaint is not the loop but its *cost accounting*: review events and upkeep
injections fire on bookkeeping noise, completion claims fail repeatedly without an
accumulating record, and completion leaves stale prose behind. My read is that the
highest-value changes are, in order: (1) suppress plan-change reviews when no goal
task or evidence content changed, (2) an outstanding-review-items ledger the worker
must clear instead of re-issuing blanket COMPLETE claims, (3) a completion-time
stale-fields check, (4) upstream edxeth launch metadata (typed sessionFile/Intercom
id in the tool result). The idle-both-sides stall maniworker describes is the one I
understand least; it may be Intercom receipt semantics rather than pi-goals, so I
asked for exact message ids. This is not a comparison trial, so none of this measures
how much friction a plain subagent run would have had.

Follow-ups sharpened the picture the same day, and one correction of mine: I had
asked maniworker about the worker plan-edit report, but that observation was LUCID3's
session, not theirs. maniworker confirmed by transcript that their writer never
edited the plan (supervisor owns plan edits there) and located the real failure
chain in worker-owned artifacts: three Intercom reports (c06bc9b0, 13bda691,
d713d614) claiming 8/13 then 6/8 while the saved CSVs held 11/13 and 2/8, ending when
the supervisor mandated an executable CSV renderer. Their inference, which I share:
prose-only completion checks would have missed this; checks that re-derive counts
from the artifact catch it. The reviewer worker (7122d466) supplied the mechanism
with receipts: a hand-written totals block (message 4e87600b, corrected by 26e0a15b)
invented a cross-packet row and asserted 4 while listing 3; its first 17-row tally
was fully correct and every error disappeared once the parent required per-row
judgments with machine tallies across the next 112 rows. So tallies degrade somewhere
between 17 and 24 rows, and the fix is a shared tally tool plus a worker-prompt rule,
not more review rounds. LUCID3 also documented both sides of the plan-change hook:
identity-only edits produced two consecutive empty review events (worker message
755b9fef supplied the paths), while a later review exposed worker-ticked tasks and a
duplicate evidence block that inspection then repaired (worker report 2e09c4dd).
suppressed-activations scoped the completion check: assert-style intro prose only,
suggestions with exact stale line and location, one compact reminder, never
auto-tick, and it can substantiate stale NOT-executed prose but not the plan-intro
example, which is LUCID3's observation. The nudge false positive it reported
("legs 4/4" in an animal tally) is confirmed by that text and fixed.

Changes made now: notify digest on plan changes keeps goals, tasks and evidence
above the Log and drops worker identity lines (c834237) -- the short-view hash had
stopped surfacing task ticks, the very catch LUCID3 valued; removed "legs" from the
skill_nudge grader-folk table (demo updated, passes); helper subagent bookkeeping and
the launch-pending counter shipped earlier today (cd98fa1).

Next: send follow-up questions to the three reporters; triage the four pi-goals
changes above against the pinned edxeth launch-result format.

## 2026-09-23 -- Outcome substitution, avoidable stops and stale supervision views

The user reported that overnight supervision was producing reports instead of understanding failures and advancing the requested outcome.

Evidence from this conversation and the eight replies to nine connected peers:

- User: "and really it should be outcomes you can show the user that distinguish the users outcome from subtle and common failures" and "it shoudl act autonomously, taking responsibiltiy to understanding and advancing the user's goal & pref, keeping perspective and view of the users goal". They reported repeated avoidable access blockers: credentials absent from the process environment but available through `.env`/python-dotenv, and AWS access instructions available in the justfile. These incidents were not independently replayed here.
- BS-bench supervisor: "activity goals ('Run the real numbered BS-bench v2 comparison...') let me CompleteGoal on execution despite weak scientific results." It attributes this primarily to its own judgment; the harness checked source quotes, not whether the evidence established the desired outcome. Source: Intercom message `3793e635-13ac-4048-a047-a334856370e5`, session `01a0bbd4-7122-72f8-9388-1e2967a565e7`, plan `.pi/plan/a565e7-v1.md`.
- Newastraidea supervisor: "parent previously left worker idle ~7h after1919 despite goal unfinished; instructions/reminders did not by themselves produce a next assignment." This is a reported delay, not an independently measured harness effect. Source: message `66fa5719-0fb6-4a25-a0a7-bc7bc3b9037f`, parent `01a0c807`, plan `.pi/plan/bd719a-v1.md`.
- Four supervisors reported stale worker-view activity. Lucid21 quoted "301 newer saved turns remain"; newastraidea quoted "336 newer saved turns remain". Manifold and j-steer-dev reported the same kind of mismatch between current headers and old activity. Several also reported duplicated Intercom/status messages and administrative acknowledgement loops. No elapsed cost was isolated for those messages.
- Counterexamples: the j-steer worker quoted "proceed autonomously through finalartifacts, report genuineblockers not routinepermissionrequests" and reported queuing the authorized jobs without per-job permission. The manifold worker reported that direct parent correction preserved pure CAA equivalence against matched ordinary CAA, rather than an incorrect unsteered baseline. Goal persistence and discriminators helped when the scientific target was correct.

Raw reports, including message IDs and artifact pointers: [collected feedback](.local/reviews/20260923-harness-feedback.md). That local capture is ignored; the durable source is this session's saved messages in `/home/code/.pi/agent/sessions/--home-code-.pi-agent-git-github.com-wassname-pi-goals--/2026-09-22T22-41-04-545Z_01a0cb47-a221-7158-b5c5-fdc7b41db9ec.jsonl`. Loaded harness revisions are unknown. Reports followed user corrections and are not blinded or independent evidence of causality.

Source inspection at `7e07214` narrows the mechanical claims:

- `src/worker-view.ts:buildWorkerView` reduces oversized summaries with `fresh.slice(0, ...)`: oldest unseen activity wins over newest activity. This directly explains the backlog display, although it does not prove why a supervisor left work idle.
- `src/index.ts:reportStop` suppresses automatic unclassified finals after explicit same-run running/waiting/no_change/decision events; plain Intercom reports do not supply that classification. `ATTENTION_EVENTS` includes unclassified. Existing suppression must be preserved, not replaced with a rule that hides genuine stops.
- Eight-turn upkeep queues context for the next ordinary prompt; it does not itself force a turn. Its text nevertheless leads with "update task ticks, evidence or Log" and "Finish any evidence review", encouraging the wrong emphasis.
- Worker self-view does not pass a launch task into `savedWorkerView`, so "Launch task: unknown" is not evidence of lost attachment after compaction. Binding and assignment must be distinguished.

Interpretation: my read is that weak goal framing and poor supervisor judgment are established in the inspected examples. Stale summaries and repetitive notices plausibly worsen them, but these reports do not identify their causal contribution. More generic reminders are unlikely to fix a supervisor that never verifies whether its next instruction was acted on.

Changes made earlier in this session: `6819f1d` adjusted outcome wording, simplified check-ins and requested random fortunes; `73e040f` rewrote planning and supervisor purpose and put the two priorities first in AGENTS.md. Verification then showed 143 tests passing, typecheck and lint passing. A hypothetical five-case rehearsal preserved empirical goals, technical deliverables, credential investigation and bounded-task scope; it was not an overnight trial, and its run ended aborted after saving the response. At 10:29 AWST, the reflog records a reset to upstream `7e07214`. The user then explained "oh I reinstalled shit sorry" and "yeah I updated pi", and authorized restoring the changes. They were reapplied as `2c5d28c` and `99d976b` without disturbing the journal.

Additional changes after the user identified fresh reminders as salient: replace the eight-turn bookkeeping reminder, context resync, requested review, final review and default scheduled check-in with outcome/diagnosis/action emphasis. Compact reminders now retain the user-visible result beside unfinished goal titles, without task/evidence/Log noise. Keep explicit pause and authorization boundaries; a completion acknowledgement is not evidence that the next action began. Existing saved scheduler prompts and active research sessions were not rewritten or reloaded.

Verification of this revision: 143 tests passed, typecheck passed, lint passed, using locked dependencies in an isolated checkout. The reinstall had removed development dependencies (`vitest: not found`). One old assertion required the exact phrase "inspect current requirements"; removed that wording assertion, retaining its file-change behavior checks. The updated reminder regression checks that the outcome reaches the agent and task/history noise does not, not model compliance. Log: `.local/verification/20260923-reminders/checks.log`. No unattended behavioral validation yet.

Installation diagnosis: the global settings listed pi-goals as a Git-managed package twice. The installed Pi package manager's `ensureGitRef` executes `git reset --hard` to its update target, then `cleanAndInstallGitDependencies` executes `git clean -fdx`. This matches the observed reset and lost local files; it does not establish which update command the user ran. Documented local-path development outside the managed cache to prevent recurrence.

Remaining recommended follow-ups, not implemented here:

- Default worker_view to a bounded newest-activity summary, with older history explicitly accessible. Preserve unanswered calls, latest errors and compaction uncertainty. Test that a recent failure or completion is visible behind a large backlog.
- Coalesce redundant progress reports and omit stop-review boilerplate on ordinary waits, while preserving failure, decision and genuine-stop attention. Do not infer job liveness from a prose "waiting" claim or a child process count.
- Validate the new reminder emphasis in actual unattended execution. The text now asks supervisors to inspect results and verify next action; it does not mechanically establish job liveness or prevent idle unfinished work.
- Show binding separately from task metadata in worker self-view. Verify reported review-delivery and plan-update issues against saved receipts before adding another notification mechanism.
- Keep working-outcome discriminators at planning and completion, and keep explicit bounded investigations bounded. Validate on an unattended task with a recoverable setup failure and an initially unsuccessful result, not only prompt wording or unit tests.

-- PI/OpenAI

The next change should help the supervisor see current evidence and advance the user's goal rather than create more administrative work.
