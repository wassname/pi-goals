import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface LaunchSupervisorInput {
	cwd: string;
	sourceSessionFile: string;
	workerSessionId: string;
	workerIntercomId: string;
	planPath: string;
	approvalId: string;
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
		`PI_GOALS_WORKER_INTERCOM_ID=${input.workerIntercomId}`,
		`PI_GOALS_PLAN_PATH=${input.planPath}`,
		`PI_GOALS_APPROVAL_ID=${input.approvalId}`,
		`PI_GOALS_OWNER_SESSION_ID=${input.workerSessionId}`,
	];
	const args = [
		"pi",
		"--no-extensions",
		"-e", "npm:pi-intercom",
		"-e", process.env.PI_GOALS_SUPERVISE_EXTENSION ?? "npm:@wassname2/pi-supervise@0.0.4",
		"-e", input.extensionPath,
		"--fork", input.sourceSessionFile,
		"--name", `goals-supervisor-${input.workerSessionId.slice(0, 8)}`,
	];
	if (input.model) args.push("--model", input.model);
	args.push("Initialize supervision startup.");
	return `env ${[...env, ...args].map(shellQuote).join(" ")}`;
}

export async function openSupervisorPane(input: LaunchSupervisorInput): Promise<string> {
	if (process.env.HERDR_ENV !== "1") throw new Error("Ready needs a Herdr session so pi-goals can open the supervisor session.");
	await herdr(["--version"], false);
	const split = await herdr(["pane", "split", "--current", "--direction", "right", "--cwd", input.cwd, "--no-focus"]);
	const paneId = findPaneId(split);
	if (!paneId) throw new Error("Herdr did not return the new supervisor pane ID.");
	try {
		await herdr(["pane", "run", paneId, supervisorCommand(input)]);
		return paneId;
	} catch (error) {
		await closeSupervisorPane(paneId);
		throw error;
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
