// Wire two real GoalIntercom adapters. This router never invents hello replies.
export function pairedIntercomFixture() {
	const receivers = new Map<string, (event: any) => void>();
	const endpoint = (id: string, peer: string) => {
		const sent: any[] = [];
		let connected = true;
		const transport = {
			sent,
			drop: (_message: any) => false,
			connect: (value: boolean) => { connected = value; receivers.get(id)?.({ type: "connection", connected: value, supported: true }); },
			events: {
				on: () => () => {},
				emit: (name: string, registration: any) => {
					if (name !== "intercom:extension-register") return false;
					receivers.set(id, registration.onEvent);
					registration.onReady({
						snapshot: () => ({ connected, supported: true }),
						publish: (message: any) => {
							sent.push(message);
							if (sent.length > 200) throw new Error("Handshake did not settle; possible hello loop.");
							if (connected && !transport.drop(message)) queueMicrotask(() => receivers.get(peer)?.({ type: "message", fromSessionId: id, payload: message }));
						},
					});
					return true;
				},
			},
		};
		return transport;
	};
	return { worker: endpoint("worker", "supervisor"), supervisor: endpoint("supervisor", "worker") };
}
