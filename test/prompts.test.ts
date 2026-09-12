import { expect, it } from "vitest";
import { planContext, readyApproved, upkeep, upkeepNudges } from "../src/prompts.js";

it("cycles the curated supervisor nudges without changing the shared upkeep instructions", () => {
	const base = upkeep("/plan.md");
	const variants = upkeepNudges.map((_, round) => upkeep("/plan.md", round));
	expect(new Set(variants).size).toBe(upkeepNudges.length);
	for (const text of variants) expect(text.endsWith(base)).toBe(true);
	expect(upkeep("/plan.md", upkeepNudges.length)).toBe(variants[0]);
	expect(base).toContain("/plan.md");
});

it.each(["## Log", "### Log"])("keeps all current requirements but omits %s history from refreshed and approved context", heading => {
	const requirements = "- > The human's full requested output and conditions.\n".repeat(80);
	const plan = `# Plan\n## User voice\n${requirements}\n- [ ] goal: verify output\n${heading}\nold progress report`;
	const refreshed = planContext("supervising", "/plan.md", plan);
	const approved = readyApproved("goals-worker", "/plan.md", undefined, plan, "pi-session");
	for (const text of [refreshed, approved]) {
		expect(text).toContain(requirements);
		expect(text).toContain("goal: verify output");
		expect(text).not.toContain("old progress report");
	}
});
