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
