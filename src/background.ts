import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Pi/OpenAI: Adapted from this repo's feature/simple-visible-supervision at cecb1e9.
export async function backgroundState(pi: ExtensionAPI): Promise<{ quiet: boolean; description: string }> {
	const tools = pi.getAllTools();
	const hasProcesses = tools.some(tool => tool.name === "process");
	const hasSubagents = tools.some(tool => tool.name === "subagent");
	let processes: unknown;
	pi.events.emit("processes:request:list", { reply: (value: unknown) => { processes = value; } });
	const rows = Array.isArray(processes) ? processes : !hasProcesses && processes === undefined ? [] : null;
	const known = rows?.every(p => p && ["running", "terminating", "terminate_timeout", "exited", "killed"].includes(p.status));
	const activeProcesses = known ? rows!.filter(p => !["exited", "killed"].includes(p.status)) : null;
	let subagents: number | null = hasSubagents ? null : 0;
	if (hasSubagents) {
		const requestId = randomUUID();
		subagents = await new Promise<number | null>(resolve => {
			let unsubscribe: (() => void) | undefined;
			const finish = (value: number | null) => { clearTimeout(timer); unsubscribe?.(); resolve(value); };
			const timer = setTimeout(() => finish(null), 2000);
			unsubscribe = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (reply: any) => {
				if (reply?.requestId !== requestId) return;
				const count = reply?.success && reply?.data?.fleet?.version === 1 ? reply.data.fleet.totalActive : undefined;
				finish(Number.isSafeInteger(count) && count >= 0 ? count : null);
			});
			pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "status", params: {}, source: { extension: "pi-goals" } });
		});
	}
	return {
		quiet: activeProcesses?.length === 0 && subagents === 0,
		description: `processes: ${activeProcesses?.length ?? "unknown"}${activeProcesses?.length ? ` (${activeProcesses.map(p => p.name || p.id).join(", ")})` : ""}; subagents: ${subagents ?? "unknown"}; unregistered detached work is not tracked`,
	};
}
