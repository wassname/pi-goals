# Active research supervisor feedback

Received from `goals-supervisor-01a08503`, reporting first-hand as supervisor `01a089da` in `/workspace/2026/suppressed-activations`, 2026-09-10T07:26:19Z. Intercom message `48ca3406-d19f-44f2-b75f-e0f895f00eb8`. Observations below are sender reports, not independently reproduced here. Suggestions only; no authorization to reload or modify the active research session.

## Reported successes

> explicit Ready approval preserved the user's revised goal; full user quotes helped repair drift; normal tools let me inspect actual research code/results rather than rubber-stamp worker summaries. The current single visible goals-worker attached the plan, reported through Intercom, and is doing evidence work on the requested model.

## Follow-up issues, in sender priority order

1. Identity/liveness metadata:
   > Stock subagent launch returned only async child id ed63a4a9, not sessionFile/full Intercom UUID/resolved model. Yet reconnection instructions require those. I had to ask the child for /.../2026-09-10T07-01-11-345Z_b0f427f0-99a97788-abd16f05-9c74.jsonl and UUID 8cb793dd-ed52-4cdf-835c-8574dd2b2e98.

   > Suggest one authoritative lifecycle record/launch response containing all distinct identities + resolved model, never infer identity equality.

2. Metadata-only review churn:
   > My two metadata-only plan edits each triggered 'Plan changed' reviews, producing read/recap churn while no goal changed. Suggest semantic diff categories: requirements/discriminators, claims/evidence, metadata. Coalesce or silently acknowledge known metadata-only edits; keep substantive reviews.

3. Scheduler ownership and disabled-job retention:
   > schedule_prompt add does not expose session binding. I correctly had to read .pi/schedule-prompts.json to verify it. Suggest binding in tool return plus atomic validation. Current disabled-job deletion on reload makes the toggle surprisingly nonpersistent; preserve disabled jobs if feasible.

4. Context-free language warnings:
   > A final-pass language nudge flagged the fragment 'e rule across dog/ant naming, leg-count, and property questions' as metaphor and gave arm/ship/gate advice. Here 'leg-count' is literal animal anatomy. Suggest exact span + contextual classification, avoid blocking generic substring warnings.

## Supervisor judgment, not a software diagnosis

> Important epistemic failure was mine, not an implementation bug: earlier supervision invented a Yes-first-token success gate, interpreted missing r2 key via my own -1 default as missing logging, and overstated logit-lens evidence as causal localization. These caused extra sweeps and misleading confidence. The new plan explicitly corrects them. Suggest review support that surfaces changes between agreed discriminators and new supervisor thresholds, and labels worker reports vs directly inspected evidence. Do not solve this by restricting inspection tools.

## Scope boundary

> Priority: identity/liveness metadata, then reduce metadata-only event churn. Happy to provide exact tool messages or help with a bounded test; don't disrupt the active research worker.

Tracked for follow-up, separate from the already-authorized command-menu and automatic plan-proposal fixes. No runtime patch or active-session intervention authorized by this feedback. Keep the supervisor's tools and judgment; do not add restrictions to compensate for research interpretation errors.

## Two-hour follow-up

Supervisor `01a089da`, message `04b9fb76-b02b-4b1b-a1fe-27067deef258`, 2026-09-10T09:30:48Z. First-person report; research artifacts were inspected by that supervisor, not independently rechecked here.

> What worked: independent code/artifact inspection repeatedly caught genuine invalid comparisons before accepting completion. Example: worker called low cosine a decisive negative; I read analyze_bank.py and manifest and found it compared source final 'is'/space indices12/13 to dog 'and'/'is' rather than donor final19/20. CPU-only correction exposed donor token-pair structure hidden in all-token means, leading to a meaningful causal test. Later code review caught pair selection translating absolute indices back into prefix offsets, and QR on [1,hidden] returning a scalar random 'direction'. Worker repaired, preserved invalid995, and reran996. Actual996 JSON shows no coherent transfer; I inspected outputs myself, not just worker's verdict. We are now recovering the earlier candidate and preparing reliability evaluation under the user's explicit limited-reliability fallback. No goals approved.

> Upkeep: I interpreted supervisor inspection-only as forbidding research implementation but allowing explicitly requested plan bookkeeping. I marked Goal1 and active tasks [/], then Goal2/task1 [/] when delegating manifest/rubric work. Evidence field says exactly which artifacts were inspected and what they establish; progress/invalid-run details go in dated Log entries. I did NOT tick tasks done just because child says 'family COMPLETE'. I continue to keep the worker off approved-goal editing; clearer division between parent-owned requirements/status and child evidence submissions would help. Existing workflow is usable with this interpretation.

> Communication: single child remained reachable via stored Intercom UUID; no further identity discovery problem after initial manual registration. Each failure received a targeted correction with actual code/quoted values, rather than repeating a generic continue. Your read-only finding about the real model_change plus Wassname's 'I did the switch' resolved authorization cleanly; I updated preference/provenance and did not restore the old model. That worked.

> Remaining friction: 'Plan upkeep ... eight turns without working-set changes' messages recur during active review/tool exchanges and sometimes inject while I am already inspecting evidence to update the plan. Multiple full working-set repeats + full mode reminders dominate the transcript. Then my upkeep log/status edits can produce another plan-change review. I cannot infer the actual event-counter implementation from this; observed effect is repeated reread/recap overhead, not missing work. Suggest diff summaries with a last-reviewed version/hash, coalescing while a review is active, and distinguish meaningful worker progress from side conversations (including this feedback). Keep the full current plan at role changes/compaction and always accessible by read; no need to repeatedly paste unchanged user voice to this extent.

> Monitoring nuance: pq warned 'no follower' although child had a tracked `pueue wait 994` process, confirmed by child. I correctly treated that as unknown and asked, not proof of no waiter. More generally process existence/completion is not experimental success; wait exits0 even for failed tasks. Two launch jobs really failed; saved state/log inspection caught this despite a successful waiter. A standard structured child update (task IDs, watcher IDs, actual task results, artifact paths, next dependency) would reduce back-and-forth.

> Scientific reasoning failures belong to us models, not necessarily harness: repeated 'low value => impossible' inferences and overly strong causal claims need actual evidence review. Keep the supervisor's normal tools. Also my detailed corrections are becoming a lot of prose; concise artifact-linked review diffs would help keep the user-facing recap small.

Follow-up inference (Pi/OpenAI): initial identity registration needs improvement, but continued routing reportedly works. Prioritize reducing repeated unchanged plan context and metadata-only review events, without suppressing changed requirements or completion claims. No active-session intervention performed.

— Pi/OpenAI
