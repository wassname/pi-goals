import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { supervisorReady } from "./mailbox.js";

const execFileAsync = promisify(execFile);
const STARTUP_TIMEOUT_MS = 5 * 60_000;

interface LaunchSupervisorInput {
	cwd: string;
	sourceSessionFile: string;
	workerSessionId: string;
	planPath: string;
	approvalId: string;
	mailboxPath: string;
	extensionPath: string;
	model: string | null;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function findPaneId(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	for (const key of ["pane_id", "paneId"]) {
		if (typeof record[key] === "string") return record[key];
	}
	for (const child of Object.values(record)) {
		const found = findPaneId(child);
		if (found) return found;
	}
	return null;
}

async function herdr(args: string[], json = true): Promise<unknown> {
	const bin = process.env.HERDR_BIN_PATH ?? "herdr";
	const { stdout } = await execFileAsync(bin, args, { encoding: "utf8", timeout: 15_000 });
	if (!json) return stdout.trim();
	return stdout.trim() ? JSON.parse(stdout) : {};
}

function stalePaneError(error: unknown): boolean {
	const record = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
	const text = [record.stdout, record.stderr, record.message].filter((value): value is string => typeof value === "string").join("\n");
	return /\b(?:NOT_FOUND|PANE_GONE|PANE_NOT_FOUND)\b/i.test(text);
}

export function supervisorCommand(input: LaunchSupervisorInput): string {
	const env = [
		"PI_GOALS_ROLE=supervisor",
		`PI_GOALS_WORKER_ID=${input.workerSessionId}`,
		`PI_GOALS_PLAN_PATH=${input.planPath}`,
		`PI_GOALS_APPROVAL_ID=${input.approvalId}`,
		`PI_GOALS_OWNER_SESSION_ID=${input.workerSessionId}`,
		`PI_GOALS_MAILBOX_PATH=${input.mailboxPath}`,
	];
	const args = [
		"pi",
		"--no-extensions",
		"-e", input.extensionPath,
		"--fork", input.sourceSessionFile,
		"--name", `goals-supervisor-${input.workerSessionId.slice(0, 8)}`,
	];
	if (input.model) args.push("--model", input.model);
	return `env ${[...env, ...args].map(shellQuote).join(" ")}`;
}

export async function waitForSupervisorReady(mailboxPath: string, timeoutMs = STARTUP_TIMEOUT_MS): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!supervisorReady(mailboxPath)) {
		if (Date.now() >= deadline) throw new Error("The visible supervisor did not become ready.");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

export async function openSupervisorPane(input: LaunchSupervisorInput): Promise<string> {
	if (process.env.HERDR_ENV !== "1") throw new Error("Ready needs a Herdr session so pi-goals can open the supervisor session.");
	await herdr(["--version"], false);
	const split = await herdr(["pane", "split", "--current", "--direction", "right", "--cwd", input.cwd, "--no-focus"]);
	const paneId = findPaneId(split);
	if (!paneId) throw new Error("Herdr did not return the new supervisor pane ID.");
	await herdr(["pane", "run", paneId, supervisorCommand(input)]);
	try {
		await waitForSupervisorReady(input.mailboxPath);
		return paneId;
	} catch (error) {
		throw new Error(`Supervisor startup incomplete in Herdr pane ${paneId}; inspect that pane. ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function closeSupervisorPane(paneId: string): Promise<void> {
	try {
		await herdr(["pane", "close", paneId]);
	} catch (error) {
		if (stalePaneError(error)) return;
		throw error;
	}
}
