# Functional and formally verifiable agent harnesses

Research by PI/OpenAI, 2026-11-08. Intended reader: wassname, comparing harness designs rather than looking for agents that generate mathematical proofs.

## Finding

The strongest source-level proof-related lead is **Volland/agent.lean**, but it is an early research prototype, not an established harness recommendation: created 2026-11-06, one attributed contributor, five commits and no issues, PRs or releases at the 2026-11-08 audit. Its proofs concern the same pure `step` function called by the runtime's C ABI layer. Host I/O, bindings and tool behavior remain outside those proofs. GitHub reports successful build/proof-check jobs; I have not rerun the build.

There are also runnable functional-language harnesses with substantial contributor histories: Autolith (Common Lisp), ECA/Psi (Clojure), Jido/Jido.AI and Alloy (Elixir), BeamAI/Hayata (Erlang), and haskell-agent (Haskell). Functional language, pure control flow, native compilation, and formal verification are independent properties.

For a small pure loop, inspect **comonadic-harness**. For checked plans, inspect **Guardians**; for multi-agent coordination with formal semantics, inspect **ZipperGen**. The initial search omitted Lisp/Clojure/BEAM implementations and executable Lean cores; the language-specific follow-up corrects that coverage gap.

## GitHub maturity and adoption

Snapshot: **2026-11-08 01:37 UTC**. Sorted by attributed non-bot contributor accounts descending, then stars descending. These account counts do not establish how much code humans wrote, whether AI assistance was used, or whether independent review occurred. “Last push (days)” is elapsed whole days, not project age. Issues exclude PRs; PR totals include author-created PRs.

| Repository | Humans | Stars | Created (UTC) | Last push (days) | Issues open/closed | PRs open/merged | Releases |
|:---|---:|---:|:---|:---|---:|---:|---:|
| [editor-code-assistant/eca](https://github.com/editor-code-assistant/eca) | 47 | 1050 | 2025-06-16 | 2026-11-07 (0) | 75/345 | 0/220 | 417 |
| [agentjido/jido_ai](https://github.com/agentjido/jido_ai) | 31 | 211 | 2024-12-17 | 2026-10-31 (7) | 1/92 | 1/191 | 5 |
| [agentjido/jido](https://github.com/agentjido/jido) | 24 | 1906 | 2024-12-16 | 2026-11-02 (5) | 1/111 | 3/241 | 8 |
| [lambda-symbolics/autolith](https://github.com/lambda-symbolics/autolith) | 22 | 539 | 2026-07-11 | 2026-11-08 (0) | 5/59 | 7/109 | 140 |
| [replikativ/dvergr](https://github.com/replikativ/dvergr) | 4 | 40 | 2026-05-02 | 2026-11-05 (2) | 21/7 | 0/404 | 375 |
| [alloy-ex/alloy](https://github.com/alloy-ex/alloy) | 2 | 92 | 2026-02-26 | 2026-10-13 (25) | 4/4 | 0/32 | 15 |
| [metareflection/guardians](https://github.com/metareflection/guardians) | 1 | 158 | 2026-04-09 | 2026-07-16 (114) | 1/0 | 0/0 | 0 |
| [digitallyinduced/haskell-agent](https://github.com/digitallyinduced/haskell-agent) | 1 | 42 | 2026-08-19 | 2026-10-31 (7) | 0/1 | 40/1371 | 0 |
| [zippergen-io/zippergen](https://github.com/zippergen-io/zippergen) | 1 | 6 | 2026-03-14 | 2026-10-21 (17) | 0/0 | 0/1 | 5 |
| [getmissionctrl/comonadic-harness](https://github.com/getmissionctrl/comonadic-harness) | 1 | 5 | 2026-09-23 | 2026-11-03 (4) | 0/0 | 0/2 | 0 |
| [raymyers/verified-coding-agent-lean](https://github.com/raymyers/verified-coding-agent-lean) | 1 | 2 | 2026-01-21 | 2026-04-28 (193) | 0/0 | 1/0 | 1 |
| [yezhuoyang/CertiClaw](https://github.com/yezhuoyang/CertiClaw) | 1 | 1 | 2026-03-18 | 2026-03-19 (233) | 0/0 | 0/0 | 0 |
| [Volland/agent.lean](https://github.com/Volland/agent.lean) | 1 | 1 | 2026-11-06 | 2026-11-06 (1) | 0/0 | 0/0 | 0 |

Top attributed accounts, with contributor-API commit counts:

- ECA: `ericdallo` (2451), `zikajk` (157), `bombaywalla` (47).
- Jido.AI: `mikehostetler` (496), `pcharbon70` (165), `dannote` (5). Jido: `mikehostetler` (461).
- Autolith: `luciusmagn` (2884), `chakany` (39), `htayj` (33).
- dvergr: `whilo` (391); three other attributed accounts. Alloy: `chrisohalloran` (113), `johns10` (2).
- Guardians: `namin` (15). haskell-agent: `mpscholten` (4057). ZipperGen: `bemibo` (674).
- comonadic-harness: `commandodev` (132). verified-coding-agent-lean: `raymyers` (45). CertiClaw: `yezhuoyang` (28).
- agent.lean: `Volland` (5), whose public profile names Volodymyr Pavlyshyn.

### agent.lean: exact age and validation evidence

Created **2026-11-06 10:31:08 UTC**, about **39 hours** before this audit. All five default-branch commits have author timestamps on November 6, spanning about three hours. There are zero forks, zero open/closed issues, zero PRs and zero GitHub releases. This is little adoption history, not evidence that the proofs are false.

GitHub's [latest CI run](https://github.com/Volland/agent.lean/actions/runs/42227441198), at inspected revision `0cb5752d6e72464d278763945243a618720bc1c6`, reports success. Its job/step API records successful `lake build`, scenario tests, “No sorry, standard axioms only”, golden traces, source-bundle tests and host/binding tests. Two of the three recorded workflow runs succeeded; the earlier one failed. I read these API results, not the full logs, and did not reproduce them locally. Automated CI is useful build evidence, not independent peer review.

### Why PR/release counts need context

The latest 15 merged PRs inspected for haskell-agent were all authored by `mpscholten`, with no recorded non-bot reviews; some had Codex reviews. The latest 15 for dvergr were all authored by `whilo`, with empty review lists. These samples do not establish the review history of every PR, but they show why 1371 or 404 merged PRs must not be counted as that many independent reviews. Release totals can likewise reflect automated publishing frequency.

For practical functional harnesses, ECA, Jido/Jido.AI and Autolith have stronger contributor and issue histories than the proof-oriented prototypes. For proof architecture, agent.lean remains a lead to audit rather than a mature default choice.

The snapshot was collected with `gh api graphql` for issue/PR counts and paginated REST contributor lists, filtering `type == User` and known bot/agent login markers. The skill's referenced `repo_table.py` is absent from this installation, so the equivalent collector and raw snapshot are machine-local under `.local/research/20261108_github_maturity/`.

## Classification

Functional here means either a functional implementation language or an explicit pure state-transition core with effects executed separately. Common Lisp is multiparadigm: Autolith's live mutable image is included as a Lisp implementation, not as a pure functional core. Runnable means executable code, adapters and documented entry points were inspected; I did not build or run the projects.

H = attributed non-bot contributor logins, not independently verified humans. Stars and days since last push are GitHub snapshots on 2026-11-08 Perth time (2026-11-07 UTC). Each group is ordered by H descending, then stars descending. These are adoption indicators, not verification scores. Follow-up contributor counts paginate all results.

### 0. Proofs about core functions used by the runtime

| Repository | What exists | H | Stars | Days | Limit |
|:---|:---|---:|---:|---:|:---|
| [Volland/agent.lean](https://github.com/Volland/agent.lean) | Lean pure state/event/effect core, with budget/termination and temporal-monitor proofs; native C output and host bindings | 1 | 1 | 1 | v0.1 preview. The ABI calls the proved core function, but host effects, FFI, bindings and compiler correctness are trusted. No proof build rerun. |

This is a library/runtime core, not a complete terminal coding product like Autolith. “Proved core” is the source-level classification pending a fresh proof build; it is not a claim that every README guarantee was independently established.

### A. Actual functional harnesses, without a machine-checked harness proof found

| Repository | What exists | H | Stars | Days | Limit |
|:---|:---|---:|---:|---:|:---|
| [pureclaw/pureclaw](https://github.com/pureclaw/pureclaw) | Haskell agent runtime, native loop, CLI/gateway, typed authorization | 2 | 6 | 129 | Authorization types and tests; this does not prove policy sufficiency or tool behavior. |
| [digitallyinduced/haskell-agent](https://github.com/digitallyinduced/haskell-agent) | Independent Haskell coding harness, providers, terminal, tools, sessions, subagents | 1 | 42 | 7 | Pure transformations where practical; the main runtime also uses IO, mutable references and concurrency. No harness proof found. |
| [getmissionctrl/comonadic-harness](https://github.com/getmissionctrl/comonadic-harness) | Pure `step :: S -> HarnessF S`, separate interpreters, live Ollama/tools adapter | 1 | 5 | 4 | Runnable research sketch; Hspec/QuickCheck law tests are not machine-checked universal proofs. |
| [guanhua79/typed-tool-kernel](https://github.com/guanhua79/typed-tool-kernel) | Haskell tool-use loop with validation, policy, traces and staged tool-call types | 1 | 3 | 149 | Small prototype, not a complete coding environment or proven security boundary. |
| [gow720p-jpg/duo-harness](https://github.com/gow720p-jpg/duo-harness) | TypeScript pure reducer returning next state and effect; CLI, session tree and replay | 1 | 0 | 17 | Functional architecture rather than a functional language; runtime checks/tests, no formal proof found. |

### A.1. Lisp, Clojure, BEAM and further functional-language implementations

No machine-checked loop proof was found in the implementations below. Statecharts, immutable data, schema contracts, tests and OTP supervision can improve inspectability or reliability without establishing formal correctness.

| Repository | What exists | H | Stars | Days | Limit |
|:---|:---|---:|---:|---:|:---|
| [editor-code-assistant/eca](https://github.com/editor-code-assistant/eca) | Clojure coding-agent server with editor protocol, providers, tools and subagents | 47 | 1050 | 0 | Actual model/tool implementation; Clojure does not imply purity or proof. |
| [agentjido/jido_ai](https://github.com/agentjido/jido_ai) | Elixir LLM/tool loops and reasoning strategies on Jido | 31 | 211 | 7 | Tools can perform I/O; decision logic is the intended pure boundary. |
| [agentjido/jido](https://github.com/agentjido/jido) | Elixir immutable agent state, `cmd/2`, directives and OTP runtime | 24 | 1906 | 5 | Agent framework core; `jido_ai` supplies LLM integration. Actions may be effectful. |
| [lambda-symbolics/autolith](https://github.com/lambda-symbolics/autolith) | Live, self-modifying Common Lisp terminal agent; providers, tools, image generations and recovery | 22 | 539 | 0 | Actual standalone agent. Mutable Lisp image, not a pure reducer or verified harness. |
| [replikativ/dvergr](https://github.com/replikativ/dvergr) | Clojure functional-reactive agent framework with branching workspace/database state | 4 | 40 | 2 | Real runtime and tools; reactive architecture is not a proof. |
| [alloy-ex/alloy](https://github.com/alloy-ex/alloy) | Elixir completion/tool-call loop with providers and built-in coding tools | 2 | 92 | 25 | Owns the loop, not persistence/UI/sandboxing. Its “pure function” docstring is misleading: loop code reads clocks and executes tools. |
| [fulcrologic/escapement](https://github.com/fulcrologic/escapement) | Clojure/Babashka coding agent controlled by statecharts | 2 | 18 | 4 | Explicit control states and validated event payloads; pre-alpha, no loop theorem found. |
| [deepfates/cantrip](https://github.com/deepfates/cantrip) | Elixir agent runtime with tool boundaries, runtime constraints, durable traces and delegation | 1 | 129 | 107 | Runtime constraints and tests; no proof artifacts found in inspected tree. |
| [samizdat-code/samizdat](https://github.com/samizdat-code/samizdat) | Self-modifying Clojure-on-Jolt harness; loop is an EDN workflow manifest | 1 | 60 | 0 | Graph validation and rollback checks; README explicitly says earlier proof engines were removed. |
| [hugoduncan/psi](https://github.com/hugoduncan/psi) | Clojure, Pi-inspired coding harness; statecharts, event log and live introspection | 1 | 55 | 68 | Stateful runtime and replay; no formal proof found. |
| [TTalkPro/beamai](https://github.com/TTalkPro/beamai) | Erlang/OTP framework with ReAct tool loop, providers, callbacks and interrupts | 1 | 35 | 15 | Actual model/tool loop; no mechanized correctness proof found. |
| [lucasdicioccio/agents-exe](https://github.com/lucasdicioccio/agents-exe) | Haskell multi-agent CLI, sessions, agent-as-tool trees, MCP and tools | 1 | 14 | 7 | Effectful implementation; no loop proof found. |
| [zgbjgg/hayata](https://github.com/zgbjgg/hayata) | Erlang/OTP graph-agent runtime and `hayata_tool_loop:run/4` | 1 | 9 | 1 | Supervision/checkpoints and bounded tool loop, not formal verification. |
| [typednotes/lode](https://github.com/typednotes/lode) | Coding-agent service implemented in Lean, targeting lun/linen programs | 1 | 4 | 27 | Lean implementation with runtime build-contract checks; no substantive loop proof found. |

### B. Proven models or steppers with an unproved executable boundary

| Repository | What exists | H | Stars | Days | Limit |
|:---|:---|---:|---:|---:|:---|
| [raymyers/verified-coding-agent-lean](https://github.com/raymyers/verified-coding-agent-lean) | Lean ReAct relation, pure stepper and `stepWith_sound`; real IO tools/provider runner | 1 | 2 | 193 | IO runs through separately written `stepIO`/`runIO`; no theorem connecting those to the proved stepper found. |
| [yezhuoyang/CertiClaw](https://github.com/yezhuoyang/CertiClaw) | Python LLM loop → typed action → OCaml policy checker; Lean checker/normalization theorems | 1 | 1 | 233 | Lean model is standalone; verified extraction remains open. Rendering/execution remain outside the proof. |
| [Samsssd/formally-verified-llm-orchestration](https://github.com/Samsssd/formally-verified-llm-orchestration) | Python orchestration harness plus Lean state-machine model of accounting, budgets and bounded execution | 1 | 0 | 214 | No mechanized Python-to-Lean correspondence found. Quickstart uses mock model calls. |

### C. Agent plans or workflows compiled/checked before execution

| Repository | What exists | H | Stars | Days | Limit |
|:---|:---|---:|---:|---:|:---|
| [metareflection/guardians](https://github.com/metareflection/guardians) | Structured workflow AST → taint analysis, security automata and Z3 checks → executor | 1 | 158 | 114 | Real static checking of plans; no machine-checked proof of analyzer soundness found. |
| [zippergen-io/zippergen](https://github.com/zippergen-io/zippergen) | Python coordination DSL → participant-local programs; runtime plus Lean projection metatheory | 1 | 6 | 17 | Proofs concern well-formed workflows in the supported calculus; no proof that Python implementation refines Lean definitions found. |

Further functional-language examples:

- [mycelium-clj/mycelium](https://github.com/mycelium-clj/mycelium): Clojure schema-enforced workflow cells and compile-time graph validation. It supplies the workflow substrate used by Samizdat; it is not itself a complete LLM harness. Malli contracts are not universal behavioral proofs.
- [drshade/haskell-agentic](https://github.com/drshade/haskell-agentic): typed `Agentic m i o` flow values interpreted through `Runtime m`. An inspectable typed DSL and effect boundary; no verifier-soundness or interpreter-correctness theorem found.

“Compiled workflow” here means an agent plan or global workflow is transformed into an executable representation. This differs from compiling the harness program itself: Lean→C, SBCL image builds, Jolt/Chez builds or BEAM bytecode do not establish formal correctness or a verified compiler.

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

- [openai/symphony](https://github.com/openai/symphony): spec plus Elixir reference orchestrator over Codex app-server sessions. A runnable orchestration wrapper, not an independent model/tool loop or a machine-checked formal specification.
- [chrisflav/orchestra](https://github.com/chrisflav/orchestra): Lean daemon, queue and sandbox orchestration; adapters launch external Claude/OpenCode/Pi/Vibe agents. Implemented in Lean, but no loop proof found.
- [jlt-commons/writ](https://github.com/jlt-commons/writ): contracts/property testing/proof tooling for agent-written Clojure code. Adjacent generated-code verification, not a proved agent harness; verifier claims were not audited here.
- [mattwfog/harness](https://github.com/mattwfog/harness): OCaml algebraic-effect orchestration wrapper, journaling/replay/policy. `runtime/src/runners.ml` launches Kimi or Codex as a subprocess. The wrapper's effect boundary does not by itself mediate every tool action inside those external agents. Useful functional infrastructure, but distinguish it from owning the model/tool loop.
- [machunter/llmll](https://github.com/machunter/llmll): language/compiler plus Z3-based contract verification and an agent patch loop. It verifies generated program bodies against contracts; it does not establish correctness of the agent harness itself.
- [sunblaze-ucb/vero](https://github.com/sunblaze-ucb/vero): repository-level implementation/proof-generation benchmark. Agents producing verified code are a different subject from verified agent infrastructure.

## Primary evidence and qualifications

These are repository-author statements or source code, not independent verification results. Links are pinned to the inspected repository revisions.

### Executable Lean core: agent.lean

[Runtime definition](https://github.com/Volland/agent.lean/blob/0cb5752d6e72464d278763945243a618720bc1c6/AgentLean/Run.lean):

```lean
def step (env : Env) (r : Run) (e : Event) : Run × Array Effect :=
```

The same file proves `done_sticky`, `final_done` and related budget properties. [Policy.lean](https://github.com/Volland/agent.lean/blob/0cb5752d6e72464d278763945243a618720bc1c6/AgentLean/Policy.lean) proves monitor evaluation agrees with the policy formula's trace semantics. [Abi.lean](https://github.com/Volland/agent.lean/blob/0cb5752d6e72464d278763945243a618720bc1c6/AgentLean/Abi.lean) calls the actual `step h.env h.run ev`, rather than a separately rewritten IO stepper. This is the concrete implementation/proof link missing from the separate-model candidates.

[README](https://github.com/Volland/agent.lean/blob/0cb5752d6e72464d278763945243a618720bc1c6/README.md):

> **Status: v0.1 preview.** The core, codecs, policies, trace, C ABI, Lean driver, bundle, Swift and Kotlin bindings and the llama.cpp adapter are implemented; the guarantees below are proved in Lean or checked by tests. APIs may still change.

[check_proofs.sh](https://github.com/Volland/agent.lean/blob/0cb5752d6e72464d278763945243a618720bc1c6/scripts/check_proofs.sh) attempts build/sorry checks and audits a named theorem list via [Tests/Axioms.lean](https://github.com/Volland/agent.lean/blob/0cb5752d6e72464d278763945243a618720bc1c6/Tests/Axioms.lean). I inspected these files but did not execute them. The product is a very early source-level lead, not an independently validated verified system.

### Actual Lisp/Clojure/BEAM implementations

Autolith's [architecture](https://github.com/lambda-symbolics/autolith/blob/1655f276dfd855b5158b8c54a8da0b945ffd8d67/docs/architecture.org) states:

> Autolith is a terminal agent in a live Common Lisp image. The running system can be inspected and changed by both the agent, and the user.

Its [runtime](https://github.com/lambda-symbolics/autolith/blob/1655f276dfd855b5158b8c54a8da0b945ffd8d67/src/agent/runtime.lisp) contains actual tool planning/execution and model-turn logic, not only prompts or a specification.

Other inspected implementation entry points:

- Jido: [agent command/state/directive code](https://github.com/agentjido/jido/blob/d0bf7c567a91f7b25e8f06a33c5c3ab10d1f1106/lib/jido/agent.ex), with model integration supplied by the [Jido.AI ReAct runner](https://github.com/agentjido/jido_ai/blob/aaf969ebeb7b8c2b7f7c41a171547e83caf56ba7/lib/jido_ai/reasoning/react/runner.ex). Its documentation explicitly permits effectful actions.
- Alloy: [actual loop](https://github.com/alloy-ex/alloy/blob/6fb40886af80d15318bddf9fcdcdb4a5be4d8afa/lib/alloy/agent/turn.ex), which invokes clocks and `Executor.execute_all`; the absence of a GenServer does not make it referentially transparent.
- BeamAI: [Erlang ReAct tool loop](https://github.com/TTalkPro/beamai/blob/4d6181c53f3f9017a64b3d65feae00f84aca47fb/apps/beamai_agent/src/beamai_agent_tool_loop.erl).
- Hayata: [Erlang bounded model/tool loop](https://github.com/zgbjgg/hayata/blob/c811477660bbe026d82de74499cb86fb1b793188/src/hayata_tool_loop.erl).
- Psi: [statechart agent core](https://github.com/hugoduncan/psi/blob/61d2c6e7761892994e1b4ded2a2b8e413bc76684/components/agent-core/src/psi/agent_core/core.clj).
- Haskell additions: [agents-exe session/turn model](https://github.com/lucasdicioccio/agents-exe/blob/78263fef142559329d4f60f71b972ad06f7f3432/src/System/Agents/Session/Base.hs) and [haskell-agentic typed interpreter](https://github.com/drshade/haskell-agentic/blob/043604a28ceb7d2ebba0921856b719b5f5d661b3/agentic/src/Agentic/Interpret.hs). The latter returns `m o` through `Runtime m`; it is not necessarily a pure computation.
- ECA: [chat/model/tool implementation](https://github.com/editor-code-assistant/eca/blob/04946532feb205ac2e0313ad1b94519dcf9bb501/src/eca/features/chat.clj).
- Samizdat: [agent-loop manifest](https://github.com/samizdat-code/samizdat/blob/9411f00c87d5ddb725f46eb8794e0d93a479835f/resources/manifests/loop.edn). Its README says the predecessor's Lean/Z3/Prolog/Octave proof engines were removed; those names do not establish current harness verification.

### Proven stepper versus IO twin: verified-coding-agent-lean

[ReActExecutable.lean](https://github.com/raymyers/verified-coding-agent-lean/blob/d429ed4669f843d4b42904738e66a41efea34302/ReActAgent/ReActExecutable.lean) proves `stepWith_sound`, then defines a separate `stepIO` and recursive `runIO`. This earns the “proved pure stepper” classification, but I found no proof that the IO runner implements that stepper.

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

The follow-up explicitly searched Erlang, Elixir, Clojure, Common Lisp, Haskell and Lean implementations, combining language filters with README/name searches. It found major omissions, including a proved executable Lean core. The initial scan should not be treated as a representative census. Language qualifiers alone also missed relevant mixed/keyword-poor results.

No third-party code was installed or executed, and no proof build was rerun. For agent.lean, the later maturity audit read GitHub CI run/job status records, but not full logs; other projects' CI was not audited. “Proofs present” describes inspected artifacts, not a fresh local kernel-check result. `agent.lean` provides a direct source-level core/proof link; no inspected candidate established correctness of the entire host/tool/FFI product. That is a scoped search finding, not a claim that none exists anywhere.

Raw fetched files, revision IDs and working notes are machine-local under `.local/research/20261108_agent_harness_sources/`, `.local/research/20261108_language_followup/` and the corresponding scout notes. The canonical classification above supersedes scout prose: contributor counts and elapsed days were recomputed, stale-document interpretations corrected, and a monadic interpreter was not labeled pure merely because it has an explicit effect parameter.

— PI/OpenAI
