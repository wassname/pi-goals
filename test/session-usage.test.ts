import { expect, it } from "vitest";
import { report, summarize } from "../scripts/session-usage.mjs";

const start = "2026-09-10T06:00:00.000Z";
const end = "2026-09-10T07:00:00.000Z";
const request = (timestamp: string, model = "a") => ({
	type: "message", timestamp, message: { role: "assistant", provider: "test", model,
		usage: { input: 10, cacheRead: 100, cacheWrite: 5, output: 20, reasoning: 8, totalTokens: 135 } },
});

it("excludes inherited history and counts repeated cached input without adding reasoning twice", () => {
	const result = summarize([request("2026-09-09T06:00:00.000Z"), request(start), request(end, "b")], start, end);
	expect(result).toMatchObject({ calls: 2, input: 20, cacheRead: 200, cacheWrite: 10, output: 40, totalTokens: 270 });
	expect(result.models.map((m: any) => m.model)).toEqual(["test/a", "test/b"]);
});

it("uses the latest planning start and the same interval for both sessions", () => {
	const supervisor = { entries: [
		{ type: "custom", customType: "pi-goals-main-supervisor-v1", timestamp: start, id: "boundary", data: { mode: "planning", plan: "plan.md" } },
		request(start),
	] };
	const result = report(supervisor, { entries: [request(end)] }, end);
	expect(result.since).toBe(start);
	expect(result.elapsedHours).toBe(1);
	expect(result.sessions.map((s: any) => s.output)).toEqual([20, 20]);
	expect(() => report({ entries: [] }, { entries: [] }, end)).toThrow("No recorded planning start");
});

it("reports missing usage and rejects invalid recorded token counts", () => {
	const missing = { type: "message", timestamp: start, message: { role: "assistant" } };
	expect(summarize([missing], start, end).missingUsage).toBe(1);
	const invalid = request(start); invalid.message.usage.input = Number.NaN;
	expect(() => summarize([invalid], start, end)).toThrow("Invalid usage.input");
});
