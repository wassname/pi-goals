import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const INTERCOM_REGISTER_EVENT = "intercom:extension-register";
const NAMESPACE = "pi-goals/visible-supervisor/v1";
const READY_TIMEOUT_MS = 15_000;

type Channel = {
	snapshot(): { connected: boolean };
	publish(payload: unknown, options?: { audience?: "owner" | "capable"; ownerOnly?: boolean }): void;
	listSessions(): Promise<Array<{ id: string; pid: number }>>;
};

type IntercomEvent = { type: string; connected?: boolean; fromSessionId?: string; payload?: unknown };

type ReadyMessage = { type: "supervisor-ready"; to: string; approvalId: string };

function timeout<T>(promise: Promise<T>, message: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), READY_TIMEOUT_MS);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function isReadyMessage(value: unknown): value is ReadyMessage {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return record.type === "supervisor-ready" && typeof record.to === "string" && typeof record.approvalId === "string";
}

export interface GoalsIntercom {
	workerIntercomId(): Promise<string>;
	waitForSupervisorReady(approvalId: string): Promise<void>;
	announceSupervisorReady(workerIntercomId: string, approvalId: string): Promise<void>;
}

export function registerGoalsIntercom(pi: ExtensionAPI): GoalsIntercom {
	let channel: Channel | undefined;
	let resolveIntercomConnected!: () => void;
	const intercomConnected = new Promise<void>((resolve) => {
		resolveIntercomConnected = resolve;
	});
	const ready = new Map<string, () => void>();
	const announced = new Set<string>();
	let ownId = "";

	const currentId = async (): Promise<string> => {
		await intercomConnected;
		if (ownId) return ownId;
		const sessions = await channel!.listSessions();
		const session = sessions.find((item) => item.pid === process.pid);
		if (!session) throw new Error("pi-goals could not find this Pi session in pi-intercom.");
		ownId = session.id;
		return ownId;
	};

	(pi as unknown as { events: { emit(name: string, value: unknown): void } }).events.emit(INTERCOM_REGISTER_EVENT, {
		namespace: NAMESPACE,
		ownerEligible: false,
		onReady(value: Channel) {
			channel = value;
			if (value.snapshot().connected) resolveIntercomConnected();
		},
		onEvent(event: IntercomEvent) {
			if (event.type === "connection" && event.connected) {
				resolveIntercomConnected();
				return;
			}
			if (event.type !== "message" || !isReadyMessage(event.payload)) return;
			if (event.payload.to !== ownId) return;
			const resolve = ready.get(event.payload.approvalId);
			if (!resolve) {
				announced.add(event.payload.approvalId);
				return;
			}
			ready.delete(event.payload.approvalId);
			resolve();
		},
	});

	return {
		workerIntercomId: () => timeout(currentId(), "pi-goals needs pi-intercom before it can start a visible supervisor."),
		waitForSupervisorReady(approvalId) {
			if (announced.delete(approvalId)) return Promise.resolve();
			return timeout(new Promise<void>((resolve) => ready.set(approvalId, resolve)), "The visible supervisor did not acknowledge pairing with this worker.");
		},
		async announceSupervisorReady(workerIntercomId, approvalId) {
			await timeout(intercomConnected, "pi-goals needs pi-intercom before it can confirm visible-supervisor pairing.");
			channel!.publish({ type: "supervisor-ready", to: workerIntercomId, approvalId }, { audience: "capable" });
		},
	};
}
