import { describe, expect, it } from "vitest";
import { appendLog } from "../src/index.js";

describe("appendLog (the extension's only plan-file write)", () => {
	it("creates ## Log at EOF when absent", () => {
		const out = appendLog("# Plan\n\n## Goals\n\n1. [ ] goal: x\n", "2026-07-03 10:00 signed off \"x\" (judge accept)");
		expect(out).toContain("## Log\n- 2026-07-03 10:00 signed off");
	});

	it("appends after the last existing log line, before any following header", () => {
		const plan = "# Plan\n\n## Log\n- first\n- second\n\n# Future work\n- later\n";
		const out = appendLog(plan, "third");
		const lines = out.split("\n");
		expect(lines[lines.indexOf("- second") + 1]).toBe("- third");
		expect(out.indexOf("- third")).toBeLessThan(out.indexOf("# Future work"));
	});
});
