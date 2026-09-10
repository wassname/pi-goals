# Goal plan

## Objective
In this isolated project, plan exactly two goals. First create greeting.txt containing exactly hello worker followed by one newline (13 bytes). Second create count.mjs, a dependency-free Node CLI that accepts exactly one file path and prints its byte length followed by a newline; missing arguments, extra arguments and unreadable files must produce stderr, no stdout and a nonzero exit. Save actual verification of valid and invalid cases under ignored evidence/. Use the goals-worker interactive agent for implementation after Ready, then inspect its outputs yourself before sign-off. No other projects or panes. No unresolved requirements; draft and show the plan, but wait for human Ready.

## Approval and scope
Draft only. Wait for human `Ready` before any implementation or verification runs.
After Ready, use the `goals-worker` interactive agent for implementation of both goals.
Work only in this project; do not use other projects, panes, or live research sessions, or change global settings.
Requirements are resolved. The main chat supervises and inspects artifacts and saved verification before sign-off.

## Goals
- [x] goal: Create greeting.txt with exactly the required 13 bytes
  - Worker writes `hello worker` followed by one LF newline, with no BOM or other bytes.
  - Failure modes: missing newline, CRLF, extra whitespace, or a same-length wrong string.
  - Deliverable: `greeting.txt` and actual byte-equality and length verification under `evidence/`.
- [x] goal: Create count.mjs with the required CLI behavior
  - Worker uses Node built-ins only; invoke as `node count.mjs <file-path>`.
  - Accept exactly one path; print its byte length and one LF newline, with exit 0 and empty stderr.
  - Missing arguments, extra arguments, and unreadable files must give nonempty stderr, empty stdout, and a nonzero exit.
  - Worker ensures `/evidence/` is Git-ignored using project-local ignore rules and preserves all verification files.
  - Failure modes: counting characters, accepting extra arguments, printing errors to stdout, or returning success after an error.
  - Deliverable: `count.mjs`, local ignore configuration, and captured verification for every case below.

## UAT / Verification
- After Ready, worker saves the test commands or test script, fixtures, actual stdout and stderr, exit codes, and assertions under `evidence/`.
- Greeting success: compare its full byte buffer with `Buffer.from('hello worker\n')` and assert length 13.
- Greeting likely failure: length detects missing or extra newline bytes; full equality also detects same-length substitutions or CRLF changes.
- CLI success: greeting prints exactly `13\n`; an empty file prints `0\n`; both exit 0 with no stderr.
- CLI sneaky failure: a multibyte UTF-8 fixture and a binary fixture print independently known byte lengths, not character counts.
- CLI likely failure: run with zero arguments, two arguments, and a nonexistent file; assert nonzero exit, nonempty stderr, and zero stdout bytes separately for each.
- Also test a permission-denied file under an unprivileged identity if the worker runs as root; record the identity and actual read denial so root bypass cannot pass this test.
- Save `git check-ignore` output for evidence files and confirm evidence remains untracked.
- If any assertion fails, worker inspects the captures, fixes the cause, and reruns checks while preserving failed evidence.
- Main chat reads both artifacts and saved verification, independently reruns the checks and saves its results under `evidence/`, then signs off each exact goal only if all checks pass.

## Log
- Draft revised by Pi. Awaiting human Ready; no implementation performed.
- User reports the isolated-trial operator disabled sandbox with authorization. This does not approve implementation. No agents launched or other sessions or settings changed.
<!-- Drafted by Pi -->

- Parent review: "Create greeting.txt with exactly the required 13 bytes"; "Read greeting.txt and the worker verification script and captured output. Independently read its raw bytes with Node and asserted exact hex 68656c6c6f20776f726b65720a and length 13. Saved supervisor result reports passed true and exit 0; worker and supervisor stderr are empty. git check-ignore confirms evidence ignored and git ls-files evidence/ is empty. First goal passes; count.mjs is not signed off."; evidence ["/tmp/goals-edxeth-trial-PjLvDi/project/greeting.txt","/tmp/goals-edxeth-trial-PjLvDi/project/evidence/greeting-worker/verify.mjs","/tmp/goals-edxeth-trial-PjLvDi/project/evidence/greeting-worker/stdout.txt","/tmp/goals-edxeth-trial-PjLvDi/project/evidence/greeting-supervisor/stdout.txt","/tmp/goals-edxeth-trial-PjLvDi/project/evidence/greeting-supervisor/exit-status.txt","/tmp/goals-edxeth-trial-PjLvDi/project/evidence/greeting-supervisor/git-check-ignore.txt"]

- Parent review: "Create count.mjs with the required CLI behavior"; "Inspected actual CLI: only node:fs dependency, exact-one-argument check, raw Buffer byte count, stderr and nonzero exit on read failure. After runtime repair independently ran a supervisor-authored verification of eight cases: greeting 13, empty 0, UTF-8 7, binary 6, missing arguments, extra arguments, nonexistent path, and permission denial. All passed exact stdout/newline, stderr and exit assertions; permission denial confirmed EACCES at unprivileged UID 1000. Captured per-case commands, outputs and statuses; runner exit 0 and empty stderr. Git checks confirmed evidence ignored and untracked. Preserved worker artifacts, earlier blocker evidence and first goal sign-off. Second goal passes."; evidence ["/tmp/goals-edxeth-trial-PjLvDi/project/count.mjs","/tmp/goals-edxeth-trial-PjLvDi/project/evidence/count-worker/verify.mjs","/tmp/goals-edxeth-trial-PjLvDi/project/evidence/count-worker/capture-mhlBLh/stdout.txt","/tmp/goals-edxeth-trial-PjLvDi/project/evidence/count-supervisor/verify.mjs","/tmp/goals-edxeth-trial-PjLvDi/project/evidence/count-supervisor/retry.stdout.txt","/tmp/goals-edxeth-trial-PjLvDi/project/evidence/count-supervisor/retry.exit-status.txt","/tmp/goals-edxeth-trial-PjLvDi/project/evidence/count-supervisor/run-HD5Ge1/summary.json","/tmp/goals-edxeth-trial-PjLvDi/project/evidence/count-supervisor/run-HD5Ge1/direct-denial.json"]
