import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PAIR_EVENT = "pi-supervise:pair:v1";
const WORKER_STATE_EVENT = "pi-supervise:worker-state:v1";
const WORKER_PAIRED_EVENT = "pi-supervise:worker-paired:v1";
const API_READY_EVENT = "pi-supervise:api-ready:v1";
const TIMEOUT_MS = 15_000;

type Events = { emit(name: string, value: unknown): boolean; on(name: string, handler: (value: any) => void): void };

function wait<T>(start: (resolve: (value: T) => void, reject: (error: Error) => void) => void, message: string, timeoutMs = TIMEOUT_MS): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
		start((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
	});
}

export function pairWithPiSupervise(pi: ExtensionAPI, workerIntercomId: string, goal: string): Promise<void> {
	const events = (pi as unknown as { events: Events }).events;
	return wait((resolve, reject) => events.emit(PAIR_EVENT, { version: 1, workerIntercomId, goal, resolve, reject }), "pi-supervise did not accept the visible-supervisor pairing request.");
}

export interface WorkerPiSupervise {
	intercomId: string;
	waitForPair(): Promise<void>;
}

export function workerPiSupervise(pi: ExtensionAPI, timeoutMs = TIMEOUT_MS): Promise<WorkerPiSupervise> {
	const events = (pi as unknown as { events: Events }).events;
	let paired = false;
	let resolvePair: (() => void) | undefined;
	events.on(WORKER_PAIRED_EVENT, () => {
		paired = true;
		resolvePair?.();
	});
	return wait((resolve, reject) => {
		let resolved = false;
		const request = () => events.emit(WORKER_STATE_EVENT, (state: { intercomId?: string; paired?: boolean }) => {
			if (resolved) return;
			if (!state.intercomId) return reject(new Error("pi-supervise returned no worker intercom ID."));
			if (state.paired) return reject(new Error("This worker is already paired with a supervisor. Stop that supervision before selecting Ready."));
			resolved = true;
			resolve({
				intercomId: state.intercomId,
				waitForPair: () => paired ? Promise.resolve() : wait((pairResolve) => { resolvePair = pairResolve; }, "The visible supervisor did not pair with this worker.", timeoutMs),
			});
		});
		events.on(API_READY_EVENT, request);
		request();
	}, "pi-supervise did not publish this worker's intercom state.", timeoutMs);
}
