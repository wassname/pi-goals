import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const VERSION = 1;
const VIEWS = "views";
const STEERS = "steers";

export interface SupervisorMailbox {
	path: string;
	workerSessionId: string;
	planPath: string;
	approvalId: string;
}

export interface WorkerView {
	version: 1;
	sequence: number;
	reason: "ready" | "settled" | "turns" | "interval" | "started";
	text: string;
	timestamp: string;
}

export interface WorkerSteer {
	version: 1;
	sequence: number;
	instruction: string;
	timestamp: string;
}

function writeJson(path: string, value: object): void {
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value)}\n`);
	renameSync(temporary, path);
}

function readJson<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function sequence(name: string, prefix: string): number | null {
	const match = new RegExp(`^${prefix}-(\\d+)\\.json$`).exec(name);
	return match ? Number(match[1]) : null;
}

function nextSequence(directory: string, prefix: string): number {
	return Math.max(0, ...readdirSync(directory).flatMap((name) => {
		const value = sequence(name, prefix);
		return value === null ? [] : [value];
	})) + 1;
}

export function createMailbox(cwd: string, workerSessionId: string, approvalId: string, planPath: string): SupervisorMailbox {
	const path = resolve(cwd, ".pi", "goals-supervision", workerSessionId, approvalId);
	mkdirSync(join(path, VIEWS), { recursive: true });
	mkdirSync(join(path, STEERS), { recursive: true });
	return { path, workerSessionId, approvalId, planPath };
}

export function readyMailbox(path: string): void {
	writeJson(join(path, "ready.json"), { version: VERSION, timestamp: new Date().toISOString() });
}

export function supervisorReady(path: string): boolean {
	return readJson<{ version?: number }>(join(path, "ready.json"))?.version === VERSION;
}

export function writeWorkerView(mailbox: SupervisorMailbox, reason: WorkerView["reason"], text: string): WorkerView {
	const directory = join(mailbox.path, VIEWS);
	const sequence = nextSequence(directory, "view");
	const view: WorkerView = { version: 1, sequence, reason, text: `${text}\n\nworker view sequence: ${sequence}`, timestamp: new Date().toISOString() };
	writeJson(join(directory, `view-${view.sequence}.json`), view);
	return view;
}

export function workerViewsAfter(path: string, after: number): WorkerView[] {
	const directory = join(path, VIEWS);
	return readdirSync(directory)
		.flatMap((name) => {
			const value = sequence(name, "view");
			return value !== null && value > after ? [readJson<WorkerView>(join(directory, name))] : [];
		})
		.filter((view): view is WorkerView => view !== null)
		.sort((a, b) => a.sequence - b.sequence);
}

export function writeWorkerSteer(path: string, instruction: string): WorkerSteer {
	const directory = join(path, STEERS);
	const steer: WorkerSteer = { version: 1, sequence: nextSequence(directory, "steer"), instruction, timestamp: new Date().toISOString() };
	writeJson(join(directory, `steer-${steer.sequence}.json`), steer);
	return steer;
}

export function workerSteersAfter(path: string, after: number): WorkerSteer[] {
	const directory = join(path, STEERS);
	return readdirSync(directory)
		.flatMap((name) => {
			const value = sequence(name, "steer");
			return value !== null && value > after ? [readJson<WorkerSteer>(join(directory, name))] : [];
		})
		.filter((steer): steer is WorkerSteer => steer !== null)
		.sort((a, b) => a.sequence - b.sequence);
}
