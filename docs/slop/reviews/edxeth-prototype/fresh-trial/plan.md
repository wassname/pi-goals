# Goal plan

## Objective
Exactly two goals in this isolated project: create greeting.txt with exactly hello worker plus one LF newline (13 bytes); create count.mjs, a dependency-free Node CLI accepting exactly one file path and printing its byte length plus newline. Missing/extra arguments and unreadable files must give nonzero exit, nonempty stderr and empty stdout. Save verification scripts and actual stdout/stderr/exit evidence under ignored evidence/. After Ready, delegate each goal sequentially to the interactive goals-worker, resume the same saved worker for goal two, and independently inspect results before signing off. No unrelated projects, panes or settings. Requirements resolved; draft the plan and wait for human Ready.

## Preferences and constraints
- Draft only until human Ready; requirements are resolved.
- Work only in this project. Do not use unrelated projects, panes, live research sessions, or global settings.
- Use dependency-free Node code and verification scripts. Keep verification scripts, fixtures, and captured evidence under ignored `evidence/`; ensure the ignore rule is project-local.
- After Ready, delegate goal one to the interactive `goals-worker`. Inspect its results independently, then resume that same saved worker session for goal two. Do not launch a replacement worker or run goals in parallel.
- The main chat supervises and signs off only after inspecting artifacts and actual verification evidence. Worker reports alone do not prove completion.

## Goals
- [x] goal: Create greeting.txt with exactly hello worker and one LF newline
  - Deliverable: `greeting.txt` containing exactly the 13 bytes `hello worker\n`.
  - Verification: save `evidence/verify-greeting.mjs`; compare the complete file buffer against the expected bytes and assert length 13.
  - Evidence: save actual verifier stdout, stderr, and exit status as `evidence/greeting.stdout`, `evidence/greeting.stderr`, and `evidence/greeting.exit`.
  - Success: exact buffer equality and 13 bytes, with verifier exit 0.
  - Failure modes: missing newline or CRLF; a same-length wrong string that passes a length-only test. Exact byte comparison must reject both.
- [x] goal: Create count.mjs with exact byte-count output and strict CLI errors
  - Deliverable: dependency-free `count.mjs`, invoked as `node count.mjs <file>`, accepting exactly one file path and printing its byte length followed by one LF.
  - Verification: save `evidence/verify-count.mjs`; capture each CLI invocation's stdout, stderr, and exit status separately under `evidence/count/<case>.*` and assert all three.
  - Success cases: greeting prints exactly `13\n`; empty, multibyte UTF-8, and binary fixtures print their known byte lengths. Include a path containing spaces. Each exits 0 with empty stderr.
  - Error cases: missing arguments, extra arguments, nonexistent path, and a reliably unreadable file each exit nonzero, emit nonempty stderr, and emit no stdout. Ensure the unreadable fixture really denies reads to the invoking identity; do not rely on chmod alone when running as root.
  - Failure modes: counting characters instead of bytes, trimming content, extra output, ignoring extra arguments, or printing a count before reporting a read error. Exact stream and status assertions must expose these failures.
  - Evidence: preserve fixtures, per-case captures, and verifier results in `evidence/count/`, including how unreadability was established.

## UAT / Verification
- The supervisor reads `greeting.txt`, `count.mjs`, both saved verification scripts, and actual captures; independently reruns the scripts and saves separate supervisor stdout/stderr/exit captures under `evidence/supervisor/`.
- Confirm `evidence/` is ignored using `git check-ignore`, save its output, and inspect the project diff for unrelated changes.
- If a check fails, inspect its actual streams and status, return the correction to the same worker, and rerun verification. Preserve failed evidence rather than overwriting it.
- Sign off each exact goal subject only after its artifact and verification evidence satisfy the requirements. Keep goal lines and evidence references above this log.

## Log
- Plan drafted; awaiting human Ready. No implementation or worker launch authorized yet.

- Parent review: "Create greeting.txt with exactly hello worker and one LF newline"; "Inspected artifact text and hex: exact hello worker followed by 0a, 13 bytes. Read verifier asserting full Buffer equality and length. Inspected worker captures and independently reran verifier: both PASS, exit 0, empty stderr. git check-ignore confirms evidence ignored; git diff empty, status shows project scaffolding and greeting untracked."; evidence ["/tmp/goals-edxeth-trial-6r8lwu/project/greeting.txt","/tmp/goals-edxeth-trial-6r8lwu/project/evidence/verify-greeting.mjs","/tmp/goals-edxeth-trial-6r8lwu/project/evidence/greeting.stdout","/tmp/goals-edxeth-trial-6r8lwu/project/evidence/greeting.exit","/tmp/goals-edxeth-trial-6r8lwu/project/evidence/supervisor/greeting.stdout","/tmp/goals-edxeth-trial-6r8lwu/project/evidence/supervisor/greeting.exit","/tmp/goals-edxeth-trial-6r8lwu/project/evidence/supervisor/check-ignore.stdout"]

- Parent review: "Create count.mjs with exact byte-count output and strict CLI errors"; "Read CLI and verifier source and inspected actual worker and independent supervisor captures for all nine cases. Success cases emitted exactly 13, 0, 7, 6, 4 plus LF, exit 0 and empty stderr. Missing/extra args, nonexistent and unreadable paths each exited 1 with empty stdout and nonempty stderr. UID 1000 read probe confirmed EACCES. Independent verifier exited 0 with empty stderr. Evidence ignored per git check-ignore; diff empty and status adds count.mjs to previously observed untracked project files. Same saved worker session was resumed sequentially after greeting sign-off."; evidence ["/tmp/goals-edxeth-trial-6r8lwu/project/count.mjs","/tmp/goals-edxeth-trial-6r8lwu/project/evidence/verify-count.mjs","/tmp/goals-edxeth-trial-6r8lwu/project/evidence/count/worker-7pK7Df/verifier.stdout","/tmp/goals-edxeth-trial-6r8lwu/project/evidence/supervisor/count/verifier.stdout","/tmp/goals-edxeth-trial-6r8lwu/project/evidence/supervisor/count/verifier.exit","/tmp/goals-edxeth-trial-6r8lwu/project/evidence/supervisor/count/unreadability.json","/tmp/goals-edxeth-trial-6r8lwu/project/evidence/supervisor/count/unreadable.stderr","/tmp/goals-edxeth-trial-6r8lwu/project/evidence/supervisor/count/check-ignore.stdout"]
