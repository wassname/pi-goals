# Main-chat supervisor prototype

Prepared by Pi/OpenAI. Separate worktree; do not load into existing research sessions.

- [x] goal: keep planning and supervision in the main chat, with an interactive edxeth worker
  - Retain the plan file, review menu, widget and evidence-based completion.
  - Use edxeth's public tools for launch/resume/kill, not another pairing protocol.
  - Keep parent inspection tools; worker uses normal tools/extensions/skills.
  - Deliver role and plan notices as saved messages; no context-array edits or forced compaction.
  - failure modes: wrong subagent package, inherited supervisor role, duplicate worker, unsigned ticks counted as success.
  - deliverable: `src/prototype.ts`, `prototype/agents/goals-worker.md`, and `prototype/README.md`.
  - evidence: `../reviews/edxeth-prototype/copied-replay.txt` records three accepted requests, zero network and no context hooks; the real runtime changed from planning to supervisor at Ready.
- [x] goal: demonstrate two goals through real interactive Pi in isolated Herdr panes
  - Observe worker launch, artifact creation, parent inspection and both completion records.
  - Exercise parent reload and continuation of the saved worker session.
  - failure modes: tests pass but no visible worker; success claimed from tool receipts rather than files.
  - deliverable: `../reviews/edxeth-prototype/README.md` with artifacts, pane captures, session summaries, interventions and limits.
  - evidence: fresh trial completed both goals after Ready without further nudges; saved launch/resume results share the worker session path, parent and operator verification passed, and reload retained `2/2 reviewed`. Active-worker crash recovery is not claimed.

## UAT / Verification
Success: parent stays in its original session/model, launches a real worker pane, inspects two actual artifacts and signs off both goals.
Likely failure: edxeth tool collision or launch error; inspect the test panes and report exact source/version and error.
Sneaky failure: child does not report, or parent performs the task; inspect session tool history and resulting files, not only final prose.
No existing worker, supervisor, JSONL, installed package or global settings may be changed. Use fresh isolated test sessions, and only copies for encrypted-history replay checks.
