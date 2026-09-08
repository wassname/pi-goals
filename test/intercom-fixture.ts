export function intercomFixture() {
	let autoHello = true;
	let registration: any;
	const sent: any[] = [];
	let connected = true;
	const receive = (payload: any, fromSessionId = "peer") => registration.onEvent({ type: "message", fromSessionId, payload });
	return {
		sent, receive,
		replyToHello: (value: boolean) => { autoHello = value; },
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
						if (message.kind === "hello" && !message.reply && autoHello) queueMicrotask(() => receive({ ...message, role: message.role === "worker" ? "supervisor" : "worker", ready: true, reply: true }));
					},
				});
				return true;
			},
		},
	};
}
