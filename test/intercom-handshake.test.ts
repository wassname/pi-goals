import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { GoalIntercom } from "../src/intercom.js";
import { pairedIntercomFixture } from "./paired-intercom-fixture.js";

function endpoint(transport: ReturnType<typeof pairedIntercomFixture>["worker"]) {
	const entries: any[] = [];
	const ctx = { sessionManager: { getEntries: () => entries }, ui: { notify: vi.fn() } };
	const hooks = new Map<string, any>();
	const link = new GoalIntercom({ events: transport.events, on: (name: string, hook: any) => hooks.set(name, hook), appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }) } as unknown as ExtensionAPI);
	return { link, ctx, entries, accept: (text: string) => hooks.get("message_start")({ message: { role: "user", content: text } }) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

it("re-handshakes unchanged peers in either direction without hello ping-pong or lost advice", async () => {
	const wire = pairedIntercomFixture();
	const worker = endpoint(wire.worker);
	const supervisor = endpoint(wire.supervisor);
	worker.link.configure("binding", "worker", worker.ctx as any);
	supervisor.link.configure("binding", "supervisor", supervisor.ctx as any);
	supervisor.link.markReady();
	await settle();
	expect(worker.link.connected && supervisor.link.connected).toBe(true);
	const deliver = vi.fn(); worker.link.onSteer = deliver;
	for (const side of [worker, supervisor, worker]) {
		const before = wire.worker.sent.length + wire.supervisor.sent.length;
		side.link.configure("binding", side === worker ? "worker" : "supervisor", side.ctx as any, true);
		await side.link.waitReady(100);
		await settle();
		expect(worker.link.connected && supervisor.link.connected).toBe(true);
		expect(wire.worker.sent.length + wire.supervisor.sent.length - before).toBe(2);
	}
	const before = wire.worker.sent.length + wire.supervisor.sent.length;
	worker.link.configure("binding", "worker", worker.ctx as any, true);
	supervisor.link.configure("binding", "supervisor", supervisor.ctx as any, true);
	await settle();
	expect(worker.link.connected && supervisor.link.connected).toBe(true);
	expect(wire.worker.sent.length + wire.supervisor.sent.length - before).toBe(4);
	supervisor.link.steer("Read actual output.");
	await settle();
	expect(deliver).toHaveBeenCalledExactlyOnceWith("Read actual output.");
	expect(worker.ctx.ui.notify).not.toHaveBeenCalled();
	expect(supervisor.ctx.ui.notify).not.toHaveBeenCalled();
});

it("replays pending advice and views across either role's own readiness transition", async () => {
	const wire = pairedIntercomFixture();
	const worker = endpoint(wire.worker), supervisor = endpoint(wire.supervisor);
	worker.link.configure("binding", "worker", worker.ctx as any);
	supervisor.link.configure("binding", "supervisor", supervisor.ctx as any, true);
	await settle();
	wire.supervisor.drop = message => message.kind === "steer";
	supervisor.link.steer("Pending advice.");
	wire.supervisor.drop = () => false;
	const deliver = vi.fn(); worker.link.onSteer = deliver;
	supervisor.link.markNotReady(); await settle();
	expect(worker.link.connected).toBe(false);
	supervisor.link.markReady(); await settle();
	expect(deliver).toHaveBeenCalledExactlyOnceWith("Pending advice.");
	await worker.accept("[supervisor] Pending advice.");
	worker.link.markNotReady(); await settle();
	const onView = vi.fn(); supervisor.link.onView = onView;
	worker.link.view("Fresh view.", "settled");
	expect(onView).not.toHaveBeenCalled();
	worker.link.markReady(); await settle();
	expect(onView).toHaveBeenCalledTimes(1);
	await supervisor.accept(onView.mock.calls[0][0].text);
	expect(worker.link.connected && supervisor.link.connected).toBe(true);
	wire.worker.connect(false); wire.worker.connect(true); await settle();
	expect(worker.link.connected && supervisor.link.connected).toBe(true);
	expect(deliver).toHaveBeenCalledTimes(1);
	expect(onView).toHaveBeenCalledTimes(1);
});

it("cancels pending waits immediately on detach or reconfiguration", async () => {
	const wire = pairedIntercomFixture();
	const worker = endpoint(wire.worker);
	worker.link.configure("binding", "worker", worker.ctx as any);
	const cancelled = expect(worker.link.waitReady()).rejects.toThrow("plan detached");
	worker.link.detach(); await cancelled;
	worker.link.configure("next", "worker", worker.ctx as any);
	const replaced = expect(worker.link.waitReady()).rejects.toThrow("reconfiguration");
	worker.link.configure("third", "worker", worker.ctx as any); await replaced;
});
