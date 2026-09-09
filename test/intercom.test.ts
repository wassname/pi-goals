import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { GoalIntercom } from "../src/intercom.js";
import { intercomFixture } from "./intercom-fixture.js";

function setup(role: "worker" | "supervisor", entries: any[] = [], autoHello = true, deferReady = false) {
	const fixture = intercomFixture(autoHello, deferReady);
	const hooks = new Map<string, any>();
	const ctx = { isIdle: vi.fn(() => true), hasPendingMessages: vi.fn(() => false), sessionManager: { getEntries: () => entries }, ui: { notify: vi.fn() } };
	const api = { events: fixture.events, on: (name: string, hook: any) => hooks.set(name, hook), appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }) };
	const link = new GoalIntercom(api as unknown as ExtensionAPI);
	link.configure("binding", role, ctx as any);
	if (deferReady) fixture.ready();
	return { link, fixture, entries, ctx, hooks };
}

describe("pi-intercom transport", () => {
	it("receives exact advice once, acknowledges it and rejects unrelated peers", async () => {
		const runtime = setup("worker");
		await runtime.link.waitReady();
		const instruction = "Check the Modal dependency.\nKeep the local queue paused.";
		const delivered = vi.fn();
		runtime.link.onSteer = delivered;
		const message = { binding: "binding", role: "supervisor", kind: "steer", id: "instruction", text: instruction };
		runtime.fixture.receive({ ...message, binding: "other" });
		runtime.fixture.receive(message, "wrong-peer");
		expect(delivered).not.toHaveBeenCalled();
		runtime.fixture.receive(message);
		expect(runtime.fixture.sent.filter(message => message.kind === "received")).toHaveLength(0);
		await runtime.hooks.get("message_start")({ message: { role: "user", content: `[supervisor] ${instruction}` } });
		runtime.fixture.receive(message);
		expect(delivered).toHaveBeenCalledExactlyOnceWith(instruction);
		expect(runtime.fixture.sent.filter(message => message.kind === "received")).toHaveLength(2);
		await runtime.hooks.get("session_shutdown")();
		runtime.fixture.receive({ ...message, id: "late" });
		expect(delivered).toHaveBeenCalledTimes(1);
	});

	it("restores an unacknowledged steer on reconnect and stops replay after acknowledgment", async () => {
		const first = setup("supervisor");
		first.link.markReady();
		await first.link.waitReady();
		const { id } = first.link.steer("Read the full output.");
		await first.hooks.get("session_shutdown")();
		const resumed = setup("supervisor", [...first.entries]);
		resumed.link.markReady();
		await resumed.link.waitReady();
		const retries = resumed.fixture.sent.filter(message => message.kind === "steer");
		expect(retries.length).toBeGreaterThan(0);
		for (const retry of retries) expect(retry).toMatchObject({ id, text: "Read the full output." });
		resumed.fixture.receive({ binding: "binding", role: "worker", kind: "received", id });
		resumed.fixture.connect(false);
		expect(resumed.link.connected).toBe(false);
		const queued = resumed.link.steer("Must wait for reconnect.");
		expect(queued.queued).toBe(true);
		resumed.fixture.connect(true);
		await resumed.link.waitReady();
		expect(resumed.fixture.sent.filter(message => message.kind === "steer")).toHaveLength(retries.length + 1);
	});

	it("advances the incremental overview only after acknowledgment", async () => {
		const runtime = setup("worker");
		await runtime.link.waitReady();
		const view = runtime.link.view("The worker stopped.", "settled", "entry-1", true);
		expect(runtime.link.acknowledgedEntry).toBeUndefined();
		runtime.fixture.receive({ binding: "binding", role: "supervisor", kind: "received", id: view.id });
		expect(runtime.link.acknowledgedEntry).toBe("entry-1");
		const resumed = setup("worker", [...runtime.entries]);
		expect(resumed.link.acknowledgedEntry).toBe("entry-1");
	});

	it("cancels a readiness wait on shutdown", async () => {
		const runtime = setup("worker");
		await runtime.link.waitReady();
		runtime.fixture.connect(false);
		const wait = runtime.link.waitReady();
		const rejection = expect(wait).rejects.toThrow("Session ended");
		await runtime.hooks.get("session_shutdown")();
		await rejection;
	});
});

it("does not carry a completed compaction deferral into a new worker binding", async () => {
	const runtime = setup("worker");
	await runtime.link.waitReady();
	await runtime.hooks.get("session_before_compact")();
	runtime.link.configure("replacement", "worker", runtime.ctx as any);
	await runtime.link.waitReady();
	runtime.ctx.isIdle.mockReturnValue(false);
	const delivered = vi.fn();
	runtime.link.onSteer = delivered;
	runtime.fixture.receive({ binding: "replacement", role: "supervisor", kind: "steer", id: "first-steer", text: "Start with the highest-risk task." });
	expect(delivered).toHaveBeenCalledExactlyOnceWith("Start with the highest-risk task.");
	await runtime.hooks.get("session_shutdown")();
});

it("retries an unanswered active-binding hello twice after delayed channel registration", async () => {
	vi.useFakeTimers();
	const runtime = setup("worker", [], false, true);
	await vi.advanceTimersByTimeAsync(6_000);
	expect(runtime.fixture.sent.filter(message => message.kind === "hello" && !message.reply)).toHaveLength(3);
	await vi.advanceTimersByTimeAsync(60_000);
	expect(runtime.fixture.sent.filter(message => message.kind === "hello" && !message.reply)).toHaveLength(3);
	expect(runtime.link.connected).toBe(false);
	await runtime.hooks.get("session_shutdown")();
	vi.useRealTimers();
});

it("rejects an oversize steer before retaining it whether connected or disconnected", async () => {
	const runtime = setup("supervisor");
	runtime.link.markReady();
	await runtime.link.waitReady();
	const oversized = "x".repeat(16_000);
	for (const connected of [true, false]) {
		if (!connected) runtime.fixture.connect(false);
		const entriesBefore = runtime.entries.length;
		const sentBefore = runtime.fixture.sent.length;
		expect(() => runtime.link.steer(oversized)).toThrow("16 KB payload limit; no instruction was retained");
		expect(runtime.entries).toHaveLength(entriesBefore);
		expect(runtime.fixture.sent).toHaveLength(sentBefore);
	}
	await runtime.hooks.get("session_shutdown")();
});

it("retains only the newest disconnected steer across a supervisor reload", async () => {
	const first = setup("supervisor");
	first.link.markReady();
	await first.link.waitReady();
	first.fixture.connect(false);
	const old = first.link.steer("Inspect the old output.");
	const latest = first.link.steer("Inspect the replacement output.");
	await first.hooks.get("session_shutdown")();
	const resumed = setup("supervisor", [...first.entries]);
	resumed.link.markReady();
	await resumed.link.waitReady();
	const replayed = resumed.fixture.sent.filter(message => message.kind === "steer");
	expect(replayed.length).toBeGreaterThan(0);
	for (const message of replayed) expect(message).toMatchObject({ id: latest.id, text: "Inspect the replacement output." });
	expect(replayed).not.toContainEqual(expect.objectContaining({ id: old.id }));
});

it("does not acknowledge a synchronous handoff failure, and retries the instruction", async () => {
	vi.useFakeTimers();
	const runtime = setup("worker");
	await runtime.link.waitReady();
	const delivery = vi.fn().mockImplementationOnce(() => { throw new Error("Delivery unavailable"); });
	runtime.link.onSteer = delivery;
	const message = { binding: "binding", role: "supervisor", kind: "steer", id: "retry", text: "Inspect evidence." };
	runtime.fixture.receive(message);
	expect(runtime.fixture.sent.filter(m => m.kind === "received")).toHaveLength(0);
	expect(runtime.entries.filter(e => e.data.direction === "in")).toHaveLength(0);
	runtime.link.resumeDelivery();
	await vi.advanceTimersByTimeAsync(0);
	expect(delivery).toHaveBeenCalledTimes(2);
	await runtime.hooks.get("message_start")({ message: { role: "user", content: "[supervisor] Inspect evidence." } });
	expect(runtime.fixture.sent.filter(m => m.kind === "received")).toHaveLength(1);
	await runtime.hooks.get("session_shutdown")();
	vi.useRealTimers();
});

it("reports a peer startup failure immediately and recovers on its next ready hello", async () => {
	const runtime = setup("worker");
	await runtime.link.waitReady();
	runtime.fixture.receive({ binding: "binding", role: "supervisor", kind: "hello", id: "hello", reply: true, ready: false, failure: "Compaction cancelled; use /goals supervise." });
	await expect(runtime.link.waitReady()).rejects.toThrow("Compaction cancelled");
	runtime.fixture.receive({ binding: "binding", role: "supervisor", kind: "hello", id: "hello", reply: true, ready: true });
	await runtime.link.waitReady();
	expect(runtime.link.connected).toBe(true);
	await runtime.hooks.get("session_shutdown")();
});

it("detaches a completed binding and ignores its late advice without replay errors or false acceptance", async () => {
	const runtime = setup("worker");
	await runtime.link.waitReady();
	const delivery = vi.fn();
	runtime.link.onSteer = delivery;
	runtime.link.detach();
	runtime.fixture.receive({ binding: "binding", role: "supervisor", kind: "steer", id: "late", text: "Obsolete advice." });
	expect(runtime.link.connected).toBe(false);
	expect(delivery).not.toHaveBeenCalled();
	expect(runtime.ctx.ui.notify).not.toHaveBeenCalled();
	expect(runtime.fixture.sent.filter(m => m.kind === "received")).toHaveLength(0);
	expect(runtime.fixture.sent.at(-1)).toMatchObject({ kind: "hello", ready: false });
});
