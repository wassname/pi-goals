import { expect, it } from "vitest";
import { goalBlock, hashGoalBlock } from "../src/approval.js";

it("hashes only the current goal, excluding the log, interview, and their historical goal text", () => {
	const goal = "1. [ ] goal: output\n  - evidence: output.txt\n";
	const before = `${goal}\n## Log\n- first entry\n`;
	const after = `${goal}\n## Log\n- later entry\n\n${goal}\n## Interview\n> new notes\n`;
	expect(goalBlock(before, "output")).toBe(goal.trimEnd());
	expect(hashGoalBlock(goalBlock(before, "output")!)).toBe(hashGoalBlock(goalBlock(after, "output")!));
	expect(goalBlock(`${goal}\n## Interview\n> notes`, "output")).toBe(goal.trimEnd());
	expect(goalBlock(`${goal}2. [ ] goal: second\n  - evidence: second.txt`, "output")).toBe(goal.trimEnd());
	expect(hashGoalBlock(goalBlock(before.replace("output.txt", "changed.txt"), "output")!)).not.toBe(hashGoalBlock(goalBlock(before, "output")!));
});
