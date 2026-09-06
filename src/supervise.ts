import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PAIR_EVENT = "pi-supervise:pair:v1";
const WORKER_STATE_EVENT = "pi-supervise:worker-state:v1";
const WORKER_PAIRED_EVENT = "pi-supervise:worker-paired:v1";
const API_READY_EVENT = "pi-supervise:api-ready:v1";
const TIMEOUT_MS = 15_000;

type Events = { emit(name: string, value: unknown): boolean; on(name: string, handler: (value: any) => void): void };

function wait<T>(start: (resolve: (value: T) => void, reject: (error: Error) => void) => void, message: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), TIMEOUT_MS);
		start((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
	});
}

export function pairWithPiSupervise(pi: ExtensionAPI, workerIntercomId: string, goal: string): Promise<void> {
	const events = (pi as unknown as { events: Events }).events;
	return wait((resolve, reject) => events.emit(PAIR_EVENT, { version: 1, workerIntercomId, goal, resolve, reject }), "pi-supervise did not accept the visible-supervisor pairing request.");
}

export function workerPiSupervise(pi: ExtensionAPI): Promise<{ intercomId: string; paired: Promise<void> }> {
	const events = (pi as unknown as { events: Events }).events;
	return wait((resolve, _reject) => {
		const paired = new Promise<void>((pairedResolve) => events.on(WORKER_PAIRED_EVENT, () => pairedResolve()));
		const request = () => events.emit(WORKER_STATE_EVENT, (state: { intercomId: string }) => resolve({ intercomId: state.intercomId, paired }));
		events.on(API_READY_EVENT, request);
		request();
	}, "pi-supervise did not publish this worker's intercom state.");
}
