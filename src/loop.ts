// PI/OpenAI: use installed stock scheduler commands, never its implementation or storage.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { schedulerUnavailable } from "./prompts.js";

const realpath = (p: string) => { try { return realpathSync(p); } catch { return p; } };
export const marker = (token: string) => `pi-goals-loop:${token}`;
export const wakeToken = (text: string) => /^\[Scheduled task [^\]\n]+ fired\][\s\S]*\npi-goals-loop:([\w-]+)\s*$/.exec(text)?.[1];
export function wakeSchedule(text: string): { id: string; schedule: string } {
	const match = /^\[Scheduled task ([^\]\n]+) fired\][\s\S]*?\nSchedule: ([^\n]+)\n/.exec(text);
	if (!match) throw new Error("Scheduler wake has no Schedule line; the pi-scheduler header format changed.");
	return { id: match[1], schedule: match[2] };
}

function compatible(path: string): boolean {
	for (let dir = dirname(path); ; dir = dirname(dir)) {
		const file = join(dir, "package.json");
		if (existsSync(file)) {
			const pkg = JSON.parse(readFileSync(file, "utf8"));
			const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version ?? "");
			return pkg.name === "@jl1990/pi-scheduler" && !!version && (+version[1] > 0 || +version[2] >= 6);
		}
		if (dirname(dir) === dir) return false;
	}
}

export function schedulerCommand(pi: ExtensionAPI, name: string, source?: string): { name: string; source: string } {
	const commands = pi.getCommands().filter(c => c.source === "extension" && c.sourceInfo?.path && (c.name === name || c.name.startsWith(`${name}:`)) && (!source || realpath(c.sourceInfo.path) === source) && compatible(c.sourceInfo.path));
	if (commands.length !== 1) throw new Error(schedulerUnavailable);
	return { name: commands[0].name, source: realpath(commands[0].sourceInfo.path) };
}

export function startLoop(pi: ExtensionAPI, ctx: ExtensionContext, token: string, source: string): void {
	if (!ctx.sessionManager.getSessionFile()) throw new Error("The goals loop needs a saved Pi session.");
	pi.sendUserMessage(`/${schedulerCommand(pi, "schedule", source).name} prompt every 1h :: ${marker(token)}`, { expandPromptTemplates: true, deliverAs: "followUp" });
}

/** PI/OpenAI: only an enabled, recurring, session-bound prompt receipt can authorize work. */
export function loopTaskId(ctx: ExtensionContext, token: string): string | undefined {
	const sessionFile = ctx.sessionManager.getSessionFile();
	let id: string | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom_message" || entry.customType !== "scheduled-task") continue;
		const task = (entry.details as { task?: Record<string, unknown> } | undefined)?.task;
		if (task?.prompt !== marker(token) || task.action !== "prompt" || task.scope !== "session" || !sessionFile || task.sessionFile !== sessionFile) continue;
		id = typeof task.id === "string" && /^[\w-]+$/.test(task.id) && task.type === "interval" && task.schedule === "1h" && task.enabled === true && task.status === "pending" ? task.id : undefined;
	}
	return id;
}

export function stopLoop(pi: ExtensionAPI, ctx: ExtensionContext, token: string, source?: string): void {
	const id = loopTaskId(ctx, token);
	if (!id) throw new Error("Goals loop task not found in this session; inspect /schedules all and remove it by ID.");
	pi.sendUserMessage(`/${schedulerCommand(pi, "schedule-remove", source).name} ${id}`, { expandPromptTemplates: true, deliverAs: "followUp" });
}
