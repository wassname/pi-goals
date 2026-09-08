import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { IntercomClient } from "pi-intercom/broker/client.ts";
import { expect, it, vi } from "vitest";
import { GoalIntercom } from "../src/intercom.js";

it("exchanges readiness, views and exact advice over a real isolated pi-intercom broker", async () => {
	const directory = mkdtempSync(join(tmpdir(), "goals-intercom-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	const broker = spawn(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), resolve("node_modules/pi-intercom/broker/broker.ts")], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
	const clients: IntercomClient[] = [];
	const shutdowns: Array<() => void> = [];
	try {
		await new Promise<void>((resolveReady, reject) => {
			const timer = setTimeout(() => reject(new Error("Isolated broker did not start.")), 5000);
			broker.stdout.on("data", chunk => { if (String(chunk).includes("Intercom broker started")) { clearTimeout(timer); resolveReady(); } });
			broker.once("exit", code => { clearTimeout(timer); reject(new Error(`Broker exited: ${code}`)); });
		});
		async function endpoint(role: "worker" | "supervisor") {
			const client = new IntercomClient();
			clients.push(client);
			await client.connect({ name: role, cwd: directory, model: "test", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now(), extensions: [{ namespace: "pi-goals", ownerEligible: false }] });
			const entries: any[] = [];
			const api = {
				on: (name: string, callback: () => void) => { if (name === "session_shutdown") shutdowns.push(callback); },
				appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
				events: {
					on() {},
					emit: (_name: string, registration: any) => {
						client.on("extension_message", message => registration.onEvent({ type: "message", fromSessionId: message.fromSessionId, payload: message.payload }));
						client.on("disconnected", () => registration.onEvent({ type: "connection", connected: false, supported: true }));
						client.onBrokerMessage(message => { if (message.type === "session_left") registration.onEvent(message); });
						registration.onReady({
							snapshot: () => ({ connected: client.isConnected(), supported: client.supportsFeature("extension-bus-v1") }),
							publish: (payload: unknown) => client.sendExtensionMessage({ type: "extension_publish", namespace: "pi-goals", audience: "capable", payload }),
						});
					},
				},
			};
			const link = new GoalIntercom(api as unknown as ExtensionAPI);
			link.configure("isolated-binding", role, { sessionManager: { getEntries: () => entries }, ui: { notify() {} } } as any);
			return { link, client };
		}
		const worker = await endpoint("worker");
		const supervisor = await endpoint("supervisor");
		expect(worker.link.connected).toBe(false);
		supervisor.link.markReady();
		await Promise.all([worker.link.waitReady(3000), supervisor.link.waitReady(3000)]);
		const viewed = new Promise<string>(resolveView => { supervisor.link.onView = view => resolveView(view.text); });
		const view = worker.link.view("The worker stopped.\nModal uses a remote GPU.", "settled");
		expect(await viewed).toBe(view.text);
		const advice = "Check the Modal dependency. Keep the local GPU queue paused.";
		const received = new Promise<string>(resolveAdvice => { worker.link.onSteer = resolveAdvice; });
		supervisor.link.steer(advice);
		expect(await received).toBe(advice);
		console.log("Intercom broker: readiness confirmed; exact worker view and supervisor advice received.");
	} finally {
		for (const shutdown of shutdowns) await shutdown();
		for (const client of clients) await client.disconnect();
		if (broker.exitCode === null) { broker.kill("SIGTERM"); await once(broker, "exit"); }
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	}
}, 15_000);
