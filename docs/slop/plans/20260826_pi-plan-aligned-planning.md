# State-aligned planning mode

Pi-goals will use pi-plan's small phase model. The UI, tool gate, and agent context will read the same persisted phase. Planning still keeps pi-goals' judgeable goals, direct user quotes, and interview record.

- [x] goal: Planning state survives restart and matches the UI and agent context
  - [ ] Replace `isPlanMode` and `skipReadyMenu` with persisted `phase: planning | working`.
  - [ ] Render the planning widget, inject the hidden planning-state snapshot, and restore state from that phase.
  - [ ] Restore the snapshot after restart or compaction without repeating the full drafting prompt every turn.
  - subtle failure mode: the UI says planning but a resumed or compacted agent sees work mode.
  - discriminator: a flow test restores planning and observes the planning snapshot; working has neither.
  - evidence: [goals-flow.test.ts](../../../test/goals-flow.test.ts) restores persisted planning state and observes `[PLANNING MODE]`; [verification](../audit/20260826_pi-plan-aligned-planning.md) records `25 passed`.
- [x] goal: Planning blocks implementation while allowing fact finding
  - [ ] Allow writes only to the active plan file.
  - [ ] Block implementation tools, `CompleteGoal`, and bash write or pipe attempts with a planning-mode explanation.
  - [ ] Allow ordinary read-only inspection commands such as `pwd && ls && git log`.
  - subtle failure mode: an agent marks a goal active or changes project code before approval.
  - discriminator: flow tests reject each work route and allow the inspection command.
  - evidence: [goals-flow.test.ts](../../../test/goals-flow.test.ts) asserts allowed `pwd && ls && git log`, blocked pipe, non-plan write, and `CompleteGoal`; [verification](../audit/20260826_pi-plan-aligned-planning.md) records `25 passed`.
- [x] goal: Planning interviews and revision notes are durable user evidence
  - [ ] Teach the planning prompt to ask each independent, high-impact user-decision frontier with a recommendation, while researching facts itself.
  - [ ] Keep typed answers and `Refine` editor notes verbatim under `## Interview`.
  - [ ] Exempt `## User voice` and `## Interview` from working-set line pressure.
  - subtle failure mode: the plan silently assumes preferences or loses a revision note.
  - discriminator: a flow test opens Refine and finds its exact multiline text in `## Interview`.
  - evidence: [goals-flow.test.ts](../../../test/goals-flow.test.ts) matches the exact multiline Refine note under `## Interview`; [verification](../audit/20260826_pi-plan-aligned-planning.md) records `25 passed`.
- [/] goal: The settled plan review is concise and cannot start work accidentally
  - [ ] Use `agent_settled` to visibly print the full plan, then offer `Ready`, `Refine`, `Edit`, and `Cancel`.
  - [ ] Ready alone sends the work handoff. Refine sends one explicit revision turn. Edit opens Pi's full-plan editor. Cancel leaves planning.
  - subtle failure mode: a review choice queues an unrequested agent turn or hides the plan below the dialog.
  - discriminator: flow tests show plan before the menu and distinguish all four actions.
  - evidence: [goals-flow.test.ts](../../../test/goals-flow.test.ts) shows plan before the menu and isolates Ready as the work handoff; [verification](../audit/20260826_pi-plan-aligned-planning.md) records `25 passed`. Pending human Pi TUI check.
- [x] goal: Planning resolves facts, interpretation, and approval before overnight work
  - [x] Require repository inspection and web search for discoverable facts.
  - [x] Require human confirmation for the agent's interpretation, unresolved task or outcome, scope, and decisions needing later approval.
  - [x] Ban placeholder goals such as "work out the thing" before the plan review menu.
  - subtle failure mode: the plan has a formal discriminator but silently chooses an editorial direction or other human decision.
  - discriminator: [prompts.test.ts](../../../test/prompts.test.ts) locks the research, clarification, approval, and concrete-goal rules in the model prompt.
  - evidence: [prompts.ts](../../../src/prompts.ts) requires research, human confirmation, and approval before Ready. [prompts.test.ts](../../../test/prompts.test.ts) checks those requirements. [verification](../audit/20260826_pi-plan-aligned-planning.md) records `29 passed`.
- [x] goal: Refine waits for text in Pi's real dialog protocol
  - [x] Run Pi in RPC mode against a local no-cost model.
  - [x] Select Refine, observe the editor request, then submit text and observe the revision turn.
  - subtle failure mode: a mocked editor hides a Pi RPC ordering defect, so Refine starts a turn before the human can type.
  - discriminator: [rpc-review.test.ts](../../../test/rpc-review.test.ts) uses Pi's `extension_ui_request` and `extension_ui_response` protocol and observes two model requests before editor input, then the third revision request after it.
  - evidence: [rpc-review.test.ts](../../../test/rpc-review.test.ts) starts the installed Pi executable plus [offline-model.ts](../../../test/fixtures/offline-model.ts), with no credential or network dependency. [verification](../audit/20260826_pi-plan-aligned-planning.md) records its pass.

## UAT / Verification

`npm test`, `npm run typecheck`, and `npm run lint` pass. Read [test/goals-flow.test.ts](../../../test/goals-flow.test.ts): its assertions must show a restored planning phase, visible plan before review, exact recorded refinement, blocked work routes, and a work message only after Ready.

## Appendix (context, not approved)

Accepted: copy pi-plan's persisted phase, `agent_settled` review, and Pi editor. Do not copy its restrictive shell allowlist. Grill is a planning instruction, not a menu item: ask the whole independent frontier in rounds, with recommendations. `Ready + compact` is removed; compaction remains Pi's normal command after Ready.
