export function intercomFixture() {
	let registration: any;
	const sent: any[] = [];
	let connected = true;
	const receive = (payload: any, fromSessionId = "peer") => registration.onEvent({ type: "message", fromSessionId, payload });
	return {
		sent, receive,
		event: (event: any) => registration.onEvent(event),
		connect: (value: boolean) => { connected = value; registration.onEvent({ type: "connection", connected: value, supported: true }); },
		events: {
			on: () => () => {},
			emit: (name: string, value: any) => {
				if (name !== "intercom:extension-register") return false;
				registration = value;
				value.onReady({
					snapshot: () => ({ connected, supported: true }),
					publish: (message: any) => {
						sent.push(message);
						if (message.kind === "hello") queueMicrotask(() => receive({ ...message, role: message.role === "worker" ? "supervisor" : "worker", ready: true }));
					},
				});
				return true;
			},
		},
	};
}
