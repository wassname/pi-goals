import { describe, expect, it } from "vitest";
import { buildJudgeArgs } from "../src/index.js";

describe("buildJudgeArgs", () => {
	it("omits --model when judgeModel is null (pi uses its configured default; never a pre-emptive 'no model' failure)", () => {
		const args = buildJudgeArgs(null);
		expect(args).not.toContain("--model");
		// an empty --model "" would make every sign-off silently inconclusive -- guard against it
		const i = args.indexOf("--model");
		expect(i).toBe(-1);
	});

	it("includes --model <ref> when an explicit/session model is set", () => {
		const args = buildJudgeArgs("openrouter/~anthropic/claude-haiku-latest");
		const i = args.indexOf("--model");
		expect(i).not.toBe(-1);
		expect(args[i + 1]).toBe("openrouter/~anthropic/claude-haiku-latest");
	});

	it("always sets --no-session, --no-extensions, the read-only tool allowlist, and edit/write exclusion", () => {
		for (const m of [null, "some/model"]) {
			const args = buildJudgeArgs(m);
			expect(args).toContain("--no-session");
			expect(args).toContain("--no-extensions"); // a broken global extension must not take down sign-offs
			expect(args).toContain("--tools");
			expect(args.some((a) => a.startsWith("read,bash,grep,find,ls"))).toBe(true);
			expect(args).toContain("--exclude-tools");
			expect(args.some((a) => a.includes("edit") && a.includes("write"))).toBe(true);
		}
	});
});
