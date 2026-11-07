# Functional and formally verifiable agent harnesses

Research by PI/OpenAI, 2026-11-08. Intended reader: wassname, comparing harness designs rather than looking for agents that generate mathematical proofs.

## Finding

There are runnable functional harnesses, and there are runnable harnesses accompanied by Lean models. In the candidates inspected, I did not find an end-to-end machine-checked link from the running harness implementation to its formal specification. A compiled workflow is a separate category: verifying an agent's plan does not prove the verifier or runtime correct.

Start with **haskell-agent** for a usable functional coding agent, **comonadic-harness** for a small pure agent-loop design, **CertiClaw** for typed actions checked against policy, **Guardians** for plans checked before execution, and **ZipperGen** for multi-agent coordination with formal semantics.

## Classification

Functional here means either a functional implementation language or an explicit pure state-transition core with effects executed separately. The distinction is stated below. Runnable means executable code, adapters and documented entry points were inspected; I did not build or run the projects.

H = attributed non-bot contributor logins, not independently verified humans. Stars and days since last push are GitHub snapshots at 2026-11-07 23:05 UTC. Each group is ordered by H descending, then stars descending. These are adoption indicators, not verification scores.

### A. Actual functional harnesses, without a machine-checked harness proof found

| Repository | What exists | H | Stars | Days | Limit |
|:---|:---|---:|---:|---:|:---|
| [pureclaw/pureclaw](https://github.com/pureclaw/pureclaw) | Haskell agent runtime, native loop, CLI/gateway, typed authorization | 2 | 6 | 129 | Authorization types and tests; this does not prove policy sufficiency or tool behavior. |
| [digitallyinduced/haskell-agent](https://github.com/digitallyinduced/haskell-agent) | Independent Haskell coding harness, providers, terminal, tools, sessions, subagents | 1 | 42 | 7 | Pure transformations where practical; the main runtime also uses IO, mutable references and concurrency. No harness proof found. |
| [getmissionctrl/comonadic-harness](https://github.com/getmissionctrl/comonadic-harness) | Pure `step :: S -> HarnessF S`, separate interpreters, live Ollama/tools adapter | 1 | 5 | 4 | Runnable research sketch; Hspec/QuickCheck law tests are not machine-checked universal proofs. |
| [guanhua79/typed-tool-kernel](https://github.com/guanhua79/typed-tool-kernel) | Haskell tool-use loop with validation, policy, traces and staged tool-call types | 1 | 3 | 149 | Small prototype, not a complete coding environment or proven security boundary. |
| [gow720p-jpg/duo-harness](https://github.com/gow720p-jpg/duo-harness) | TypeScript pure reducer returning next state and effect; CLI, session tree and replay | 1 | 0 | 17 | Functional architecture rather than a functional language; runtime checks/tests, no formal proof found. |

### B. Runnable harness or checker plus a separate formal model

| Repository | What exists | H | Stars | Days | Limit |
|:---|:---|---:|---:|---:|:---|
| [yezhuoyang/CertiClaw](https://github.com/yezhuoyang/CertiClaw) | Python LLM loop → typed action → OCaml policy checker; Lean checker/normalization theorems | 1 | 1 | 233 | Lean model is standalone; verified extraction remains open. Rendering/execution remain outside the proof. |
| [Samsssd/formally-verified-llm-orchestration](https://github.com/Samsssd/formally-verified-llm-orchestration) | Python orchestration harness plus Lean state-machine model of accounting, budgets and bounded execution | 1 | 0 | 214 | No mechanized Python-to-Lean correspondence found. Quickstart uses mock model calls. |

### C. Agent plans or workflows compiled/checked before execution

| Repository | What exists | H | Stars | Days | Limit |
|:---|:---|---:|---:|---:|:---|
| [metareflection/guardians](https://github.com/metareflection/guardians) | Structured workflow AST → taint analysis, security automata and Z3 checks → executor | 1 | 158 | 114 | Real static checking of plans; no machine-checked proof of analyzer soundness found. |
| [zippergen-io/zippergen](https://github.com/zippergen-io/zippergen) | Python coordination DSL → participant-local programs; runtime plus Lean projection metatheory | 1 | 6 | 17 | Proofs concern well-formed workflows in the supported calculus; no proof that Python implementation refines Lean definitions found. |

“Compiled” here means an agent plan or global workflow is transformed into an executable representation. It is not a claim of a verified compiler.

### D. Formal specifications or runtime substrates, not complete LLM harnesses

| Repository | What exists | H | Stars | Days | Limit |
|:---|:---|---:|---:|---:|:---|
| [ohdearquant/LNkernel](https://github.com/ohdearquant/LNkernel) | Rust capability/runtime kernel plus Lean model and security theorems | 1 | 15 | 29 | Not a model/tool coding harness; explicitly excludes implementation refinement proofs and has stated axioms. |
| [privatedick/evoecos-formal](https://github.com/privatedick/evoecos-formal) | Lean specifications of supervisory safety gates for layered agents | 1 | 1 | 7 | Public artifact is the formal model, not a runnable LLM agent harness. |

### E. Claims or unfinished verification that should not be counted as verified harnesses

| Repository | What exists | H | Stars | Days | Limit |
|:---|:---|---:|---:|---:|:---|
| [agenticsorg/lean-agentic](https://github.com/agenticsorg/lean-agentic) | Rust language/runtime crates, proof-related features, three Lean example files | 1 | 62 | 1 | Inspected artifacts do not substantiate the README's broad “formally verified” harness claim. Signing a proof term is not proof checking. |
| [e6qu/rust-lean-aeneas](https://github.com/e6qu/rust-lean-aeneas) | Rust tutorials and partial Rust→Lean translation infrastructure | 1 | 9 | 230 | Its own status file says proofs are axioms and do not use the real generated code. |

### Adjacent projects

- [mattwfog/harness](https://github.com/mattwfog/harness): OCaml algebraic-effect orchestration wrapper, journaling/replay/policy. `runtime/src/runners.ml` launches Kimi or Codex as a subprocess. The wrapper's effect boundary does not by itself mediate every tool action inside those external agents. Useful functional infrastructure, but distinguish it from owning the model/tool loop.
- [machunter/llmll](https://github.com/machunter/llmll): language/compiler plus Z3-based contract verification and an agent patch loop. It verifies generated program bodies against contracts; it does not establish correctness of the agent harness itself.
- [sunblaze-ucb/vero](https://github.com/sunblaze-ucb/vero): repository-level implementation/proof-generation benchmark. Agents producing verified code are a different subject from verified agent infrastructure.

## Primary evidence and qualifications

These are repository-author statements or source code, not independent verification results. Links are pinned to the inspected repository revisions.

### Functional loop: comonadic-harness

[README](https://github.com/getmissionctrl/comonadic-harness/blob/267d074311661fe40ac635ec0082c749aa221ef9/README.md):

> Nothing here is production code. It is a sketch that compiles, runs, and has been checked against two real harnesses.

[Actual control-flow code](https://github.com/getmissionctrl/comonadic-harness/blob/267d074311661fe40ac635ec0082c749aa221ef9/src/Harness/Coalgebra.hs) has `step :: S -> HarnessF S` and emits `Ask`, `Perform` or `Halt`. [Law tests](https://github.com/getmissionctrl/comonadic-harness/blob/267d074311661fe40ac635ec0082c749aa221ef9/test/LawsSpec.hs) use QuickCheck with bounded walks. This is a concrete pure functional loop, with empirical law testing rather than theorem-prover verification.

For comparison, [haskell-agent's runtime](https://github.com/digitallyinduced/haskell-agent/blob/907e57d96cd0b327d4aeb0811de0a2f8252df95c/packages/agent-core/src/Agent/Loop/Internal.hs) uses `IORef`, `MVar` and asynchronous workers. Haskell implementation should not be confused with a wholly pure loop.

### Separate proof model: CertiClaw

[formal/README.md](https://github.com/yezhuoyang/CertiClaw/blob/e7563266ffed230b8df973095948481c7d3f6d1e/formal/README.md) correspondence table:

> | Verified extraction | **Open** | Lean model is standalone |

The same file contains stale earlier sections about unmodeled normalization, followed by later normalization proofs. The inspected [theorem file](https://github.com/yezhuoyang/CertiClaw/blob/e7563266ffed230b8df973095948481c7d3f6d1e/formal/CertiClaw/Theorems.lean) and [checker implementation](https://github.com/yezhuoyang/CertiClaw/blob/e7563266ffed230b8df973095948481c7d3f6d1e/lib/check.ml) are better evidence of current scope. The later documentation still explicitly leaves extraction open. Do not describe this as a proven OCaml executable.

### Plan checking: Guardians

[README](https://github.com/metareflection/guardians/blob/59e52d9f1cbefdb344245304e260e647489a647b/README.md):

> Instead of letting the LLM call tools one at a time and decide what to do after each result, the LLM generates a structured plan upfront using symbolic references (placeholders, not real data). A static verifier checks the plan against a security policy before any tool runs. Only verified plans execute.

The [verifier](https://github.com/metareflection/guardians/blob/59e52d9f1cbefdb344245304e260e647489a647b/src/guardians/verify.py) and [executor](https://github.com/metareflection/guardians/blob/59e52d9f1cbefdb344245304e260e647489a647b/src/guardians/execute.py) implement that architecture. Z3 checking a plan's obligations does not establish soundness of the surrounding Python analyzer.

### Coordination metatheory: ZipperGen

[README, Formal foundation](https://github.com/zippergen-io/zippergen/blob/349e0c05b150139a1e1b25243eaf0f9edcb3baad/README.md#formal-foundation):

> The formal results establish two properties for well-formed workflows in the supported model. Complete executions of the projected local programs match executions of the global workflow, up to generated control messages. Every finite projected execution can also be extended to a complete one. The second property is the paper's precise sense of freedom from deadlock.

This is stronger evidence than a generic “compiled graph” claim, but its conditions and model boundary matter. It does not guarantee meaningful answers from the participating models or correctness of arbitrary tool implementations.

### Explicit specification boundary: LNkernel

[TCB.md](https://github.com/ohdearquant/LNkernel/blob/64eeaba70daaf0d797a66787972667f8d9f885ae/TCB.md):

> **Open Source Release**: This is the abstract specification layer. Refinement proofs connecting to implementation are not included.

“Refinement” here means proving that the executable implementation follows the abstract model. Matching Rust and Lean module names do not supply that proof.

### Failed verification claim: rust-lean-aeneas

[STATUS.md](https://github.com/e6qu/rust-lean-aeneas/blob/146e06a1a78cf580f430163633ae2e75ea022ca8/STATUS.md):

> 1. **No real proofs exist.** All theorems are `axiom` declarations — they assert properties without proof. Lean accepts them but verifies nothing about correctness.

> 3. **The tutorial Lean files don't use the real generated code.** The hand-written `Funs.lean` files are approximations of what Aeneas generates. The real output lives in `lean/generated/` but isn't used by the proof files.

The README calls the final tutorial a fully verified harness. The more specific status file contradicts that claim; classify this as unfinished verification infrastructure.

## Search and verification scope

Used authenticated `gh search repos --match name,description,readme`, with short queries for functional agent harnesses, Haskell/OCaml runtimes, Lean, TLA+, Coq, Dafny, verified runtimes and compiled agent languages. A discovery scout reviewed roughly 150 raw search hits; this is not a deduplicated project count. Primary checks used `gh repo view` and `gh api` to read trees, implementation files, proof files and repository metadata. Later search queries encountered Search API HTTP 403 rate limits, so this is a bounded shortlist, not an exhaustive census.

No third-party code was installed or executed, no proof build was rerun, and CI success was not independently audited. “Proofs present” describes inspected artifacts, not a fresh kernel-check result. No candidate in this scan established an end-to-end verified harness implementation; that is a search finding, not a claim that none exists anywhere.

Raw fetched files, repository revision IDs and the scout's unedited working notes are machine-local under `.local/research/20261108_agent_harness_sources/` and `.local/research/20261108_agent_harness_scout.md`. The scout notes contain stale-document interpretations and incorrect repository-age phrases; the classification above supersedes those.

— PI/OpenAI
