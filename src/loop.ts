// PI/OpenAI: use stock scheduler commands; no private continuation timer or task store.
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SOURCE = fileURLToPath(import.meta.resolve("@jl1990/pi-scheduler/extensions/scheduler/index.ts"));
export const marker = (token: string) => `pi-goals-loop:${token}`;
// Scheduler wakes are "[Scheduled task <id> fired]", header lines, a blank line, then the stored prompt.
export const wakeToken = (text: string) => /^\[Scheduled task [^\]\n]+ fired\][\s\S]*\npi-goals-loop:([\w-]+)\s*$/.exec(text)?.[1];

export function schedulerCommand(pi: ExtensionAPI, name: string): string {
	const command = pi.getCommands().find(c => c.source === "extension" && c.sourceInfo?.path === SOURCE && (c.name === name || c.name.startsWith(`${name}:`)));
	if (!command) throw new Error(`Load @jl1990/pi-scheduler before using goals (/${name} unavailable).`);
	return command.name;
}

/** Commands sent while Pi settles are deferred, so creation is fire-and-forget; the receipt is read later. */
export function startLoop(pi: ExtensionAPI, ctx: ExtensionContext, token: string): void {
	if (!ctx.sessionManager.getSessionFile()) throw new Error("The goals loop needs a saved Pi session.");
	pi.sendUserMessage(`/${schedulerCommand(pi, "schedule")} prompt every 1h :: ${marker(token)}`, { expandPromptTemplates: true, deliverAs: "followUp" });
}

/** Task ID from the scheduler's creation receipt in this session branch. */
export function loopTaskId(ctx: ExtensionContext, token: string): string | undefined {
	const sessionFile = ctx.sessionManager.getSessionFile();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom_message" || entry.customType !== "scheduled-task") continue;
		const task = (entry.details as { task?: { id: string; prompt?: string; scope?: string; sessionFile?: string; action?: string } } | undefined)?.task;
		if (task?.prompt === marker(token) && task.action === "prompt" && task.scope === "session" && task.sessionFile === sessionFile) return task.id;
	}
}

export function stopLoop(pi: ExtensionAPI, ctx: ExtensionContext, token: string): void {
	const id = loopTaskId(ctx, token);
	if (!id || !/^[\w-]+$/.test(id)) throw new Error("Goals loop task not found in this session; inspect /schedules all and remove it by ID.");
	pi.sendUserMessage(`/${schedulerCommand(pi, "schedule-remove")} ${id}`, { expandPromptTemplates: true, deliverAs: "followUp" });
}
