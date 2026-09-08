import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { GoalIntercom } from "../src/intercom.js";
import { intercomFixture } from "./intercom-fixture.js";

function setup(role: "worker" | "supervisor", entries: any[] = []) {
	const fixture = intercomFixture();
	const hooks = new Map<string, any>();
	const ctx = { sessionManager: { getEntries: () => entries }, ui: { notify: vi.fn() } };
	const api = { events: fixture.events, on: (name: string, hook: any) => hooks.set(name, hook), appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }) };
	const link = new GoalIntercom(api as unknown as ExtensionAPI);
	link.configure("binding", role, ctx as any);
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
		const id = first.link.steer("Read the full output.");
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
		expect(() => resumed.link.steer("Must not send.")).toThrow("disconnected");
		resumed.fixture.connect(true);
		await resumed.link.waitReady();
		expect(resumed.fixture.sent.filter(message => message.kind === "steer")).toHaveLength(retries.length);
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

it("does not acknowledge a synchronous handoff failure, and retries the instruction", async () => {
	const runtime = setup("worker");
	await runtime.link.waitReady();
	const delivery = vi.fn().mockImplementationOnce(() => { throw new Error("Delivery unavailable"); });
	runtime.link.onSteer = delivery;
	const message = { binding: "binding", role: "supervisor", kind: "steer", id: "retry", text: "Inspect evidence." };
	runtime.fixture.receive(message);
	expect(runtime.fixture.sent.filter(m => m.kind === "received")).toHaveLength(0);
	expect(runtime.entries.filter(e => e.data.direction === "in")).toHaveLength(0);
	runtime.fixture.receive(message);
	expect(delivery).toHaveBeenCalledTimes(2);
	expect(runtime.fixture.sent.filter(m => m.kind === "received")).toHaveLength(1);
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
