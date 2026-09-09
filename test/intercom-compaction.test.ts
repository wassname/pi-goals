import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { GoalIntercom } from "../src/intercom.js";
import { intercomFixture } from "./intercom-fixture.js";

const shutdowns: Array<() => void> = [];
function setup(role: "worker" | "supervisor", entries: any[] = []) {
	const fixture = intercomFixture();
	const hooks = new Map<string, any>();
	const ctx = { isIdle: vi.fn(() => true), hasPendingMessages: vi.fn(() => false), sessionManager: { getEntries: () => entries }, ui: { notify: vi.fn() } };
	const pi = { events: fixture.events, on: (name: string, hook: any) => hooks.set(name, hook), appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }) };
	const link = new GoalIntercom(pi as unknown as ExtensionAPI);
	link.configure("binding", role, ctx as any, true);
	const delivered = vi.fn();
	link.onSteer = delivered;
	link.onView = view => delivered(view.text);
	shutdowns.push(() => hooks.get("session_shutdown")());
	const receive = (id: string, text: string) => fixture.receive({ binding: "binding", role: role === "worker" ? "supervisor" : "worker", kind: role === "worker" ? "steer" : "view", reason: "settled", id, text });
	const accept = (text: string) => hooks.get("message_start")({ message: { role: "user", content: role === "worker" ? `[supervisor] ${text}` : text } });
	return { link, hooks, ctx, entries, fixture, delivered, receive, accept };
}
afterEach(() => { for (const stop of shutdowns.splice(0)) stop(); vi.useRealTimers(); });

it.each(["worker", "supervisor"] as const)("retains %s messages across successful, failed and cancelled manual compaction", async role => {
	vi.useFakeTimers();
	const r = setup(role);
	for (const [id, event] of [["success", "session_compact"], ["failure", "session_compact_failed"], ["cancelled", "session_compact_failed"]]) {
		r.ctx.isIdle.mockReturnValue(false);
		await r.hooks.get("session_before_compact")({});
		r.receive(id, `evidence-${id}`);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(r.delivered).not.toHaveBeenCalledWith(`evidence-${id}`);
		expect(r.fixture.sent.some(m => m.kind === "received" && m.id === id)).toBe(false);
		await r.hooks.get(event)({ aborted: id === "cancelled" });
		await vi.advanceTimersByTimeAsync(0); // Another extension may still be handling session_compact.
		expect(r.delivered).not.toHaveBeenCalledWith(`evidence-${id}`);
		r.ctx.isIdle.mockReturnValue(true);
		await vi.advanceTimersByTimeAsync(1000);
		expect(r.delivered).toHaveBeenCalledWith(`evidence-${id}`);
		await r.accept(`evidence-${id}`);
		expect(r.fixture.sent.some(m => m.kind === "received" && m.id === id)).toBe(true);
	}
});

it("retains distinct deltas through reload and does not duplicate delayed presentation", async () => {
	vi.useFakeTimers();
	const first = setup("supervisor");
	first.ctx.isIdle.mockReturnValue(false);
	await first.hooks.get("session_before_compact")({});
	first.receive("one", "first independent evidence");
	first.receive("two", "second independent evidence");
	await first.hooks.get("session_shutdown")();
	const resumed = setup("supervisor", [...first.entries]);
	await vi.advanceTimersByTimeAsync(0);
	expect(resumed.delivered.mock.calls).toEqual([["first independent evidence"]]);
	resumed.ctx.hasPendingMessages.mockReturnValue(true);
	resumed.link.resumeDelivery();
	resumed.receive("one", "first independent evidence");
	await vi.advanceTimersByTimeAsync(60_000);
	expect(resumed.delivered).toHaveBeenCalledTimes(1);
	resumed.ctx.hasPendingMessages.mockReturnValue(false);
	await resumed.accept("first independent evidence");
	await vi.advanceTimersByTimeAsync(0);
	expect(resumed.delivered.mock.calls).toEqual([["first independent evidence"], ["second independent evidence"]]);
	await resumed.accept("second independent evidence");
	resumed.receive("two", "second independent evidence");
	expect(resumed.delivered).toHaveBeenCalledTimes(2);
});
