import { describe, expect, it } from "vitest";
import { appendLog, counts, findGoal, parse, recordSignOff, setGoalStatus } from "../src/plan-file.js";

const SAMPLE = `# Plan: ship the cache layer

## Goal: Implement cache layer
<!-- id: cache-layer-1 -->
status: active
done_when: p95 < 50ms on bench-X. If wrong: timeouts in load-test.log
verify: pytest tests/cache -q
failure_modes:
  - cache silently bypassed (hit-rate ~0, latency ok by luck)
  - bench too small to exercise eviction
- [x] wire cache client
- [ ] eviction policy
- [ ] load test

## Goal: Document the API
<!-- id: document-the-api-1 -->
status: open
done_when: every public fn has a docstring; else sphinx warns
failure_modes:
  - docstrings exist but are stale

## Log
- 2026-06-15 14:02  cache client wired; eviction next
`;

/** Multiset line diff: lines b adds vs removes vs a (order-insensitive, so insertions score added:1). */
function lineDelta(a: string, b: string): { added: number; removed: number } {
	const count = (s: string) => {
		const m = new Map<string, number>();
		for (const l of s.split("\n")) m.set(l, (m.get(l) ?? 0) + 1);
		return m;
	};
	const ma = count(a);
	const mb = count(b);
	let added = 0;
	let removed = 0;
	for (const k of new Set([...ma.keys(), ...mb.keys()])) {
		const d = (mb.get(k) ?? 0) - (ma.get(k) ?? 0);
		if (d > 0) added += d;
		else if (d < 0) removed += -d;
	}
	return { added, removed };
}

describe("parse", () => {
	const doc = parse(SAMPLE);

	it("reads the objective and both goals", () => {
		expect(doc.objective).toBe("ship the cache layer");
		expect(doc.goals.map((g) => g.id)).toEqual(["cache-layer-1", "document-the-api-1"]);
	});

	it("reads goal fields", () => {
		const g = findGoal(doc, "cache-layer-1");
		expect(g?.subject).toBe("Implement cache layer");
		expect(g?.status).toBe("active");
		expect(g?.done_when).toBe("p95 < 50ms on bench-X. If wrong: timeouts in load-test.log");
		expect(g?.verify).toBe("pytest tests/cache -q");
	});

	it("separates failure_modes from subtasks", () => {
		const g = findGoal(doc, "cache-layer-1");
		expect(g?.failure_modes).toHaveLength(2);
		expect(g?.failure_modes[0]).toContain("cache silently bypassed");
		expect(g?.subtasks).toEqual([
			{ text: "wire cache client", done: true },
			{ text: "eviction policy", done: false },
			{ text: "load test", done: false },
		]);
	});

	it("reads the log verbatim and counts by status", () => {
		expect(doc.log).toEqual(["- 2026-06-15 14:02  cache client wired; eviction next"]);
		expect(counts(doc)).toEqual({ done: 0, open: 1, active: 1 });
	});
});

describe("failure_modes vs subtask disambiguation", () => {
	it("a column-0 checkbox right after failure_modes: is a SUBTASK", () => {
		const doc = parse(
			`# Plan: x\n\n## Goal: G\n<!-- id: g-1 -->\nstatus: open\ndone_when: z\nfailure_modes:\n- [ ] first subtask\n- [x] second subtask\n`,
		);
		const g = findGoal(doc, "g-1");
		expect(g?.failure_modes).toEqual([]);
		expect(g?.subtasks).toEqual([
			{ text: "first subtask", done: false },
			{ text: "second subtask", done: true },
		]);
	});

	it("an indented checkbox-shaped item inside failure_modes is a FAILURE MODE", () => {
		const doc = parse(
			`# Plan: x\n\n## Goal: G\n<!-- id: g-2 -->\nstatus: open\ndone_when: z\nfailure_modes:\n  - [ ] prose that looks like a checkbox\n- [ ] real subtask\n`,
		);
		const g = findGoal(doc, "g-2");
		expect(g?.failure_modes).toEqual(["[ ] prose that looks like a checkbox"]);
		expect(g?.subtasks).toEqual([{ text: "real subtask", done: false }]);
	});

	it("a goal with no failure_modes keeps its subtasks", () => {
		const doc = parse(`# Plan: x\n\n## Goal: G\n<!-- id: g-3 -->\nstatus: open\ndone_when: z\n- [ ] only subtask\n`);
		const g = findGoal(doc, "g-3");
		expect(g?.failure_modes).toEqual([]);
		expect(g?.subtasks).toEqual([{ text: "only subtask", done: false }]);
	});
});

describe("the two CompleteGoal writes (minimal diff)", () => {
	it("setGoalStatus replaces exactly one line, scoped to the right goal", () => {
		const next = setGoalStatus(SAMPLE, "cache-layer-1", "done");
		expect(lineDelta(SAMPLE, next)).toEqual({ added: 1, removed: 1 });
		expect(findGoal(parse(next), "cache-layer-1")?.status).toBe("done");
		expect(findGoal(parse(next), "document-the-api-1")?.status).toBe("open"); // untouched
	});

	it("setGoalStatus targets the second goal without touching the first", () => {
		const next = setGoalStatus(SAMPLE, "document-the-api-1", "active");
		expect(findGoal(parse(next), "cache-layer-1")?.status).toBe("active");
		expect(findGoal(parse(next), "document-the-api-1")?.status).toBe("active");
	});

	it("appendLog adds exactly one line under ## Log", () => {
		const next = appendLog(SAMPLE, "2026-06-15 15:00  eviction done");
		expect(lineDelta(SAMPLE, next)).toEqual({ added: 1, removed: 0 });
		expect(parse(next).log).toEqual([
			"- 2026-06-15 14:02  cache client wired; eviction next",
			"- 2026-06-15 15:00  eviction done",
		]);
	});

	it("appendLog creates the section when absent", () => {
		const noLog = "# Plan: x\n\n## Goal: y\n<!-- id: y-1 -->\nstatus: open\ndone_when: z\n";
		expect(parse(appendLog(noLog, "first entry")).log).toEqual(["- first entry"]);
	});
});

describe("recordSignOff (CompleteGoal's pure record logic)", () => {
	const WHEN = "2026-06-15 16:00";

	it("accept flips status:done and logs a sign-off line", () => {
		const r = recordSignOff(SAMPLE, "cache-layer-1", WHEN, { kind: "accepted" });
		expect(r.isError).toBe(false);
		const doc = parse(r.content);
		expect(findGoal(doc, "cache-layer-1")?.status).toBe("done");
		expect(doc.log.at(-1)).toBe(`- ${WHEN} signed off #cache-layer-1: Implement cache layer (oracle accept)`);
	});

	it("verify_failed only logs a reject line, status stays active", () => {
		const r = recordSignOff(SAMPLE, "cache-layer-1", WHEN, { kind: "verify_failed", exitCode: 1, outputTail: "boom" });
		expect(r.isError).toBe(true);
		const doc = parse(r.content);
		expect(findGoal(doc, "cache-layer-1")?.status).toBe("active"); // NOT marked done
		expect(doc.log.at(-1)).toBe(`- ${WHEN} reject #cache-layer-1: verify exit 1`);
	});

	it("rejected logs the (one-lined) missing reason, status stays", () => {
		const r = recordSignOff(SAMPLE, "cache-layer-1", WHEN, { kind: "rejected", missing: "no\nsaved\nbench log" });
		expect(r.isError).toBe(true);
		expect(findGoal(parse(r.content), "cache-layer-1")?.status).toBe("active");
		expect(parse(r.content).log.at(-1)).toBe(`- ${WHEN} reject #cache-layer-1: no saved bench log`);
	});

	it("unknown goal returns an error and does not touch the file", () => {
		const r = recordSignOff(SAMPLE, "nope-1", WHEN, { kind: "accepted" });
		expect(r.isError).toBe(true);
		expect(r.content).toBe(SAMPLE);
	});
});
