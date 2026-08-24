import { describe, expect, it, vi } from "vitest";
import { decideSignOff, type JudgeResult } from "../src/index.js";
import { judgeSystem } from "../src/prompts.js";

// decideSignOff is the fail-forward invariant: judgeModel is NEVER checked pre-emptively, so a null
// model still reaches runJudge (pi's configured default runs it), and the only producers of
// accepted_inconclusive are the judge-error and no-VERDICT paths -- i.e. "the judge ran but failed",
// never "no model". The judge runner is injected so these tests never spawn a real subprocess.
const input = { goal: "x", plan: "# plan\n", planRel: ".pi/plan/s1.md", judgeModel: null };

describe("decideSignOff (fail-forward invariant)", () => {
	it("proceeds to runJudge even when judgeModel is null (no pre-emptive 'no model' inconclusive)", async () => {
		const output = "## checks:\n- evidence.txt: `PASS`; the saved check passed\n\nThe artifact proves the gate passed.\nVERDICT: accept\nmissing:";
		const runJudge = vi.fn().mockResolvedValue({ output });
		const out = await decideSignOff({ ...input, plan: "# plan\n1. [ ] goal: x\n" }, undefined, runJudge);
		expect(runJudge).toHaveBeenCalledOnce(); // reached the judge -- no pre-emptive return on null model
		expect(out.isError).toBe(false);
		expect(out.logEntry).toContain("judge accept");
		expect(out.resultText).toContain("evidence.txt: `PASS`");
	});

	it("rejects an accept verdict without a checked-artifact list", async () => {
		const runJudge = vi.fn().mockResolvedValue({ output: "VERDICT: accept\nmissing:" });
		const out = await decideSignOff(input, undefined, runJudge);
		expect(out.isError).toBe(true);
		expect(out.resultText).toContain("checked-artifact list");
		expect(out.logEntry).toContain("no checked-artifact list");
	});

	it("a judge-subprocess error yields accepted_inconclusive with a 'ran but failed' reason", async () => {
		const runJudge = vi.fn().mockResolvedValue({ output: "", error: "judge subprocess exited 1" } satisfies JudgeResult);
		const out = await decideSignOff(input, undefined, runJudge);
		expect(runJudge).toHaveBeenCalledOnce();
		expect(out.isError).toBe(false); // accepted inconclusive, not a hard error that blocks the agent
		expect(out.resultText.toLowerCase()).toContain("accepted inconclusive");
		expect(out.resultText).toContain("ran but failed"); // inconclusive means ran but failed, not "no model"
		expect(out.logEntry).toContain("ran but failed");
		expect(out.logEntry).toContain("subprocess exited 1");
	});

	it("a judge timeout is also accepted_inconclusive (ran but failed)", async () => {
		const runJudge = vi.fn().mockResolvedValue({ output: "partial", error: "judge timed out after 600s" });
		const out = await decideSignOff(input, undefined, runJudge);
		expect(out.isError).toBe(false);
		expect(out.resultText.toLowerCase()).toContain("accepted inconclusive");
		expect(out.logEntry).toContain("ran but failed");
		expect(out.logEntry).toContain("timed out");
		expect(out.resultText).toContain("partial judge output:\npartial");
	});

	it("no VERDICT line is accepted_inconclusive too (judge ran but didn't answer)", async () => {
		const runJudge = vi.fn().mockResolvedValue({ output: "I looked but forgot the verdict line" });
		const out = await decideSignOff(input, undefined, runJudge);
		expect(out.isError).toBe(false);
		expect(out.resultText).toContain("no VERDICT line");
		expect(out.logEntry).toContain("no VERDICT line");
	});

	it("rejects when the judge returns VERDICT: reject", async () => {
		const runJudge = vi.fn().mockResolvedValue({ output: "VERDICT: reject\nmissing: evidence, tests" });
		const out = await decideSignOff({ ...input, judgeModel: "openrouter/claude" }, undefined, runJudge);
		expect(out.isError).toBe(true);
		expect(out.resultText).toContain("REJECTED");
		expect(out.resultText).toContain("evidence, tests");
		expect(out.logEntry).toContain("reject");
	});

	it("requires a concise checked-artifact review, not private reasoning", () => {
		expect(judgeSystem).toContain("checks:");
		expect(judgeSystem).toContain("not hidden reasoning");
	});

	it("writes nothing when aborted after the judge ran", async () => {
		const runJudge = vi.fn().mockResolvedValue({ output: "VERDICT: accept" });
		const ctrl = new AbortController();
		ctrl.abort();
		const out = await decideSignOff(input, ctrl.signal, runJudge);
		expect(out.logEntry).toBeNull();
		expect(out.isError).toBe(true);
	});
});
