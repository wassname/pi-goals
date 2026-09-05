# Goal steward validation

## Observations

- Unit, flow, type, and lint checks passed. [`20260905_validation.log`](20260905_validation.log) says:

  > Test Files  8 passed (8)
  > Tests  36 passed (36)
  > Checked 12 files in 14ms. No fixes applied.

- A real Pi 0.85.0 process loaded pi-subagents 0.65.1, pi-goals, and a runtime `goal-steward` agent. It spawned one review and resumed that run for sign-off. [`20260905_steward-probe.json`](20260905_steward-probe.json) records two distinct run IDs:

  > "runId": "4e9dc0c0-385b-4eb9-a060-ced7dc7cb6cc"

  > "runId": "f6115c82-31de-499f-ab78-145dde0c51c0"

- The second review recalled a token that appeared only in the first review request. This is direct evidence that resume retained the steward conversation:

  > "Persistence lineage token: amber-731."

- The sign-off review read `report.txt` and accepted the evidence:

  > "file exists and contains exactly 'PROBE_PASS' as required. Failure mode (empty report) is ruled out."

## Test environment finding

The repository's older local Pi 0.84.1 install could not launch a pi-subagents background child because it did not include `@earendil-works/chord` and `@earendil-works/pi-server`. The successful probe used an isolated npm install of Pi 0.85.0. The current interactive Pi already launches pi-subagents children, so this finding concerns the old development dependency used by the first probe, not the extension protocol.

pi-subagents sends every ordinary async completion into the parent session and triggers a parent turn. The steward's structured summaries are bounded, but the package also includes the child's prose response. There is no public silent-completion option in pi-subagents 0.65.1. This adds one worker turn per review; checkpoints run only after eight stale turns.

— Pi/Codex
