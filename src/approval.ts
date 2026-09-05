import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const GOAL_LINE = /^\s*(?:\d+\.|[-*])\s*\[([ xX/-])\]\s*goal:\s*(.*)$/i;

export interface ApprovalRecord {
	version: 1;
	verdict: "accept";
	goal: string;
	planPath: string;
	goalBlockHash: string;
	repoRoot: string;
	head: string;
	tree: string;
	cleanWorktree: true;
	inspected: { plan: true; repository: true; evidence: true; verifyOutput: true };
	supervisor: { sessionId: string; runId: string | null };
	timestamp: string;
}

function command(repoRoot: string, args: string[]): string {
	return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

export function repositoryState(cwd: string): { repoRoot: string; head: string; tree: string; cleanWorktree: boolean } {
	const repoRoot = command(cwd, ["rev-parse", "--show-toplevel"]);
	const head = command(repoRoot, ["rev-parse", "HEAD"]);
	const tree = command(repoRoot, ["rev-parse", "HEAD^{tree}"]);
	const cleanWorktree = command(repoRoot, ["status", "--porcelain=v1"]) === "";
	return { repoRoot, head, tree, cleanWorktree };
}

export function goalBlock(plan: string, goal: string): string | null {
	const lines = plan.split("\n");
	const wanted = goal.trim().toLowerCase();
	const hits = lines.flatMap((line, index) => {
		const match = GOAL_LINE.exec(line);
		return match && (match[1] === " " || match[1] === "/") && match[2].trim().toLowerCase() === wanted ? [index] : [];
	});
	if (hits.length !== 1) return null;
	const start = hits[0];
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index++) {
		if (GOAL_LINE.test(lines[index])) {
			end = index;
			break;
		}
	}
	return lines.slice(start, end).join("\n");
}

export function hashGoalBlock(block: string): string {
	return createHash("sha256").update(block).digest("hex");
}

export function approvalPath(cwd: string, sessionId: string, goal: string): string {
	const goalId = createHash("sha256").update(goal.trim().toLowerCase()).digest("hex").slice(0, 16);
	return join(cwd, ".pi", "pi-goals", "approvals", `${sessionId}-${goalId}.json`);
}

export function writeApproval(path: string, record: ApprovalRecord): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
		renameSync(temporary, path);
	} finally {
		if (existsSync(temporary)) rmSync(temporary, { force: true });
	}
}

export function readApproval(path: string): ApprovalRecord | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as ApprovalRecord;
	} catch {
		return null;
	}
}

export function approvalMatches(record: ApprovalRecord | null, input: { goal: string; planPath: string; goalBlockHash: string; repoRoot: string; head: string; tree: string; cleanWorktree: boolean }): boolean {
	return record?.version === 1
		&& record.verdict === "accept"
		&& record.goal === input.goal
		&& resolve(record.planPath) === resolve(input.planPath)
		&& record.goalBlockHash === input.goalBlockHash
		&& resolve(record.repoRoot) === resolve(input.repoRoot)
		&& record.head === input.head
		&& record.tree === input.tree
		&& record.cleanWorktree === true
		&& input.cleanWorktree
		&& record.inspected.plan === true
		&& record.inspected.repository === true
		&& record.inspected.evidence === true
		&& record.inspected.verifyOutput === true;
}
