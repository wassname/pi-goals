import { EventEmitter } from "node:events";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { workerPiSupervise } from "../src/supervise.js";

const API_READY = "pi-supervise:api-ready:v1";
const WORKER_STATE = "pi-supervise:worker-state:v1";
const WORKER_PAIRED = "pi-supervise:worker-paired:v1";

function pi(events: EventEmitter): ExtensionAPI {
	return { events } as unknown as ExtensionAPI;
}

describe("pi-supervise worker API", () => {
	it("discovers pi-supervise when it loads after pi-goals", async () => {
		const events = new EventEmitter();
		const worker = workerPiSupervise(pi(events));
		events.on(WORKER_STATE, (reply) => reply({ intercomId: "worker-id", paired: false }));
		events.emit(API_READY);
		expect((await worker).intercomId).toBe("worker-id");
	});

	it("discovers an already-loaded pi-supervise and accepts duplicate paired events once", async () => {
		const events = new EventEmitter();
		events.on(WORKER_STATE, (reply) => reply({ intercomId: "worker-id", paired: false }));
		const worker = await workerPiSupervise(pi(events));
		let acknowledgements = 0;
		void worker.paired.then(() => { acknowledgements += 1; });
		events.emit(WORKER_PAIRED, { supervisorIntercomId: "supervisor-id" });
		events.emit(WORKER_PAIRED, { supervisorIntercomId: "supervisor-id" });
		await worker.paired;
		expect(acknowledgements).toBe(1);
	});
});
