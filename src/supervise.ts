import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PAIR_EVENT = "pi-supervise:pair:v1";
const PAIR_TIMEOUT_MS = 15_000;

export function pairWithPiSupervise(pi: ExtensionAPI, workerIntercomId: string, goal: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("pi-supervise did not accept the visible-supervisor pairing request.")), PAIR_TIMEOUT_MS);
		const settle = (callback: () => void) => {
			clearTimeout(timer);
			callback();
		};
		(pi as unknown as { events: { emit(name: string, value: unknown): void } }).events.emit(PAIR_EVENT, {
			version: 1,
			workerIntercomId,
			goal,
			resolve: () => settle(resolve),
			reject: (error: Error) => settle(() => reject(error)),
		});
	});
}
