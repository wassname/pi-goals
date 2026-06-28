import { describe, expect, it } from "vitest";
import { appendLog, counts, findGoal, parse, recordSignOff, setGoalStatus } from "../src/plan-file.js";

const SAMPLE = `# papers audit

Clean up steering/ metadata and kill empty dirs. Keep it read-only until I approve.

## Goals

1. [/] goal: Implement cache layer
  - discriminator: hit-rate > 0.8 in load-test.log (a bypass reads ~0)
  - subtle failure mode: cache silently bypassed, latency ok by luck
  - verify: pytest tests/cache -q
  - tasks:
    1. [x] wire cache client
    2. [/] eviction policy
    3. ~~[ ]~~ distributed cache, out of scope
  - evidence:
    - > load-test.log: p95=41ms
    - > hit-rate 0.93 (not bypassed)
2. [ ] goal: Document the API
  - discriminator: every public fn has a docstring; sphinx warns on none
  - subtle failure mode: docstrings exist but are stale

# Future work / out of scope

- distributed cache

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

	it("reads the title and both goals (matched by subject)", () => {
		expect(doc.title).toBe("papers audit");
		expect(doc.goals.map((g) => g.subject)).toEqual(["Implement cache layer", "Document the API"]);
	});

	it("reads goal status from the checkbox", () => {
		expect(findGoal(doc, "Implement cache layer")?.status).toBe("active"); // [/]
		expect(findGoal(doc, "Document the API")?.status).toBe("open"); // [ ]
	});

	it("reads discriminator, subtle failure mode, and verify as separate fields", () => {
		const g = findGoal(doc, "Implement cache layer");
		expect(g?.discriminator).toEqual(["hit-rate > 0.8 in load-test.log (a bypass reads ~0)"]);
		expect(g?.failure_modes).toEqual(["cache silently bypassed, latency ok by luck"]);
		expect(g?.verify).toBe("pytest tests/cache -q");
	});

	it("reads subtasks with their checkbox state, strikethrough as cancelled", () => {
		const g = findGoal(doc, "Implement cache layer");
		expect(g?.subtasks).toEqual([
			{ text: "wire cache client", status: "done" },
			{ text: "eviction policy", status: "active" },
			{ text: "distributed cache, out of scope", status: "cancelled" },
		]);
	});

	it("reads the evidence block separate from the other lists", () => {
		const g = findGoal(doc, "Implement cache layer");
		expect(g?.evidence).toEqual(["> load-test.log: p95=41ms", "> hit-rate 0.93 (not bypassed)"]);
		expect(findGoal(doc, "Document the API")?.evidence).toEqual([]); // a goal with no evidence parses to []
	});

	it("keeps a multi-line evidence item together (quote + interpretation)", () => {
		const doc2 = parse(
			`# x\n\n## Goals\n\n1. [ ] goal: G\n  - discriminator: report has non-zero counts\n  - evidence:\n    - > report.txt: counts 52 -> 4\n      remaining 4 = index + 3 notes\n      almost certain the discriminator passes\n    - > second item, single line\n`,
		);
		expect(findGoal(doc2, "G")?.evidence).toEqual([
			"> report.txt: counts 52 -> 4\nremaining 4 = index + 3 notes\nalmost certain the discriminator passes",
			"> second item, single line",
		]);
	});

	it("reads the log verbatim and counts by status", () => {
		expect(doc.log).toEqual(["- 2026-06-15 14:02  cache client wired; eviction next"]);
		expect(counts(doc)).toEqual({ done: 0, open: 1, active: 1 });
	});

	it("ignores the Future work section, does not read it as goals or log", () => {
		expect(doc.goals).toHaveLength(2);
		expect(doc.log).toHaveLength(1);
	});
});

describe("the two CompleteGoal writes (minimal diff)", () => {
	it("setGoalStatus replaces exactly one line, scoped to the right goal", () => {
		const next = setGoalStatus(SAMPLE, "Implement cache layer", "done");
		expect(lineDelta(SAMPLE, next)).toEqual({ added: 1, removed: 1 });
		expect(findGoal(parse(next), "Implement cache layer")?.status).toBe("done");
		expect(findGoal(parse(next), "Document the API")?.status).toBe("open"); // untouched
	});

	it("setGoalStatus keeps the number and goal: prefix, flips only the checkbox", () => {
		expect(setGoalStatus(SAMPLE, "Implement cache layer", "done")).toContain("1. [x] goal: Implement cache layer");
		expect(setGoalStatus(SAMPLE, "Document the API", "cancelled")).toContain("2. [-] goal: Document the API");
	});

	it("setGoalStatus throws on an unknown subject", () => {
		expect(() => setGoalStatus(SAMPLE, "no such goal", "done")).toThrow();
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
		const noLog = "# x\n\n## Goals\n\n1. [ ] goal: y\n  - discriminator: z\n";
		expect(parse(appendLog(noLog, "first entry")).log).toEqual(["- first entry"]);
	});
});

describe("recordSignOff (CompleteGoal's pure record logic)", () => {
	const WHEN = "2026-06-15 16:00";

	it("accept flips status:done and logs a sign-off line", () => {
		const r = recordSignOff(SAMPLE, "Implement cache layer", WHEN, { kind: "accepted" });
		expect(r.isError).toBe(false);
		const doc = parse(r.content);
		expect(findGoal(doc, "Implement cache layer")?.status).toBe("done");
		expect(doc.log.at(-1)).toBe(`- ${WHEN} signed off "Implement cache layer" (judge accept)`);
	});

	it("accepted_inconclusive still marks done and logs the judge failure", () => {
		const r = recordSignOff(SAMPLE, "Implement cache layer", WHEN, {
			kind: "accepted_inconclusive",
			reason: "judge timed out after 120s",
		});
		expect(r.isError).toBe(false);
		const doc = parse(r.content);
		expect(findGoal(doc, "Implement cache layer")?.status).toBe("done");
		expect(doc.log.at(-1)).toBe(`- ${WHEN} signed off "Implement cache layer" (judge inconclusive: judge timed out after 120s)`);
		expect(r.message).toContain("Judge inconclusive: judge timed out after 120s");
	});

	it("verify_failed only logs a reject line, status stays active", () => {
		const r = recordSignOff(SAMPLE, "Implement cache layer", WHEN, { kind: "verify_failed", exitCode: 1, outputTail: "boom" });
		expect(r.isError).toBe(true);
		const doc = parse(r.content);
		expect(findGoal(doc, "Implement cache layer")?.status).toBe("active"); // NOT marked done
		expect(doc.log.at(-1)).toBe(`- ${WHEN} reject "Implement cache layer": verify exit 1`);
	});

	it("rejected logs the (one-lined) missing reason, status stays", () => {
		const r = recordSignOff(SAMPLE, "Implement cache layer", WHEN, { kind: "rejected", missing: "no\nsaved\nbench log" });
		expect(r.isError).toBe(true);
		expect(findGoal(parse(r.content), "Implement cache layer")?.status).toBe("active");
		expect(parse(r.content).log.at(-1)).toBe(`- ${WHEN} reject "Implement cache layer": no saved bench log`);
	});

	it("unknown goal returns an error and does not touch the file", () => {
		const r = recordSignOff(SAMPLE, "nope", WHEN, { kind: "accepted" });
		expect(r.isError).toBe(true);
		expect(r.content).toBe(SAMPLE);
	});
});
