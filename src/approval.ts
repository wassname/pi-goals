import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, renameSync, rmSync, type Stats, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { foldPlan, GOAL_LINE } from "./plan.js";

export interface WorktreeSnapshot {
	status: string;
	indexHash: string;
	files: Array<{ path: string; kind: "file" | "symlink" | "missing"; mode?: number; contentHash?: string }>;
}

export interface ApprovalRecord {
	version: 3;
	verdict: "accept";
	approvalId: string;
	goal: string;
	planPath: string;
	goalBlockHash: string;
	repoRoot: string;
	head: string;
	tree: string;
	cleanWorktree: boolean;
	force?: { reason: string; worktree: WorktreeSnapshot };
	inspected: { plan: true; repository: true; evidence: true; verifyOutput: true };
	verifyOutputPath: string;
	supervisor: { sessionId: string; runId: string | null };
	timestamp: string;
}

function command(repoRoot: string, args: string[]): string {
	return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

// Capture bytes, not status flags: an edited file can change again while Git still reports M or ??.
function worktreeSnapshot(repoRoot: string, status: string, pathspec: string[]): WorktreeSnapshot {
	const index = execFileSync("git", ["ls-files", "--stage", "-z", "--", ...pathspec], { cwd: repoRoot });
	const paths = status.split("\0").filter(Boolean).map(entry => entry.slice(3)).sort();
	const files = paths.map((path): WorktreeSnapshot["files"][number] => {
		const fullPath = join(repoRoot, path);
		let stat: Stats;
		try { stat = lstatSync(fullPath); }
		catch (error) {
			if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return { path, kind: "missing" };
			throw error;
		}
		const mode = stat.mode & 0o777;
		const hash = createHash("sha256");
		if (stat.isSymbolicLink()) return { path, kind: "symlink", mode, contentHash: hash.update(readlinkSync(fullPath, { encoding: "buffer" })).digest("hex") };
		if (!stat.isFile()) throw new Error(`Cannot fingerprint dirty path ${path}: only regular files and symlinks are supported.`);
		const fd = openSync(fullPath, "r");
		try {
			const buffer = Buffer.alloc(256 * 1024);
			for (;;) {
				const bytes = readSync(fd, buffer, 0, buffer.length, null);
				if (!bytes) break;
				hash.update(buffer.subarray(0, bytes));
			}
		} finally { closeSync(fd); }
		return { path, kind: "file", mode, contentHash: hash.digest("hex") };
	});
	return { status, indexHash: createHash("sha256").update(index).digest("hex"), files };
}

export function repositoryState(cwd: string, captureWorktree = false): { repoRoot: string; head: string; tree: string; cleanWorktree: boolean; worktree?: WorktreeSnapshot } {
	const repoRoot = command(cwd, ["rev-parse", "--show-toplevel"]);
	const head = command(repoRoot, ["rev-parse", "HEAD"]);
	const tree = command(repoRoot, ["rev-parse", "HEAD^{tree}"]);
	const prefix = relative(repoRoot, resolve(cwd)).replaceAll("\\", "/");
	const owned = prefix ? `${prefix}/.pi` : ".pi";
	const pathspec = [".",
		`:(exclude,glob)${owned}/plan/*.md`,
		`:(exclude,glob)${owned}/pi-goals/approvals/*`,
		`:(exclude,glob)${owned}/pi-goals/models/*`,
	];
	// NUL delimiters and no rename folding preserve whitespace/newlines and both sides of renames.
	const raw = execFileSync("git", ["status", "--porcelain=v1", "-z", "--no-renames", ...(captureWorktree ? ["--ignore-submodules=none"] : []), "--untracked-files=all", "--", ...pathspec], { cwd: repoRoot });
	const status = raw.toString("utf8");
	if (captureWorktree && !raw.equals(Buffer.from(status))) throw new Error("Cannot fingerprint non-UTF-8 Git paths.");
	return { repoRoot, head, tree, cleanWorktree: status === "", ...(captureWorktree ? { worktree: worktreeSnapshot(repoRoot, status, pathspec) } : {}) };
}

export function goalBlock(plan: string, goal: string): string | null {
	const lines = foldPlan(plan).split("\n");
	const wanted = goal.trim().toLowerCase();
	const hits = lines.flatMap((line, index) => {
		const match = GOAL_LINE.exec(line);
		return match && (match[1] === " " || match[1] === "/") && match[2].trim().toLowerCase() === wanted ? [index] : [];
	});
	if (hits.length !== 1) return null;
	const start = hits[0];
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index++) {
		if (GOAL_LINE.test(lines[index]) || /^#{1,2}\s/.test(lines[index])) {
			end = index;
			break;
		}
	}
	return lines.slice(start, end).join("\n").trimEnd();
}

export function hashGoalBlock(block: string): string {
	return createHash("sha256").update(block).digest("hex");
}

export function verifyOutputPath(repoRoot: string, path: string): string | null {
	const resolved = resolve(repoRoot, path);
	const relativePath = relative(repoRoot, resolved).replaceAll("\\", "/");
	if (!relativePath || relativePath.startsWith("../") || relativePath === "..") return null;
	try {
		const output = statSync(resolved);
		if (!output.isFile() || output.size === 0) return null;
		command(repoRoot, ["ls-files", "--error-unmatch", "--", relativePath]);
		return relativePath;
	} catch {
		return null;
	}
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

export function approvalMatches(record: ApprovalRecord | null, input: {
	approvalId: string;
	goal: string;
	planPath: string;
	goalBlockHash: string;
	repoRoot: string;
	head: string;
	tree: string;
	cleanWorktree: boolean;
	worktree?: WorktreeSnapshot;
}): boolean {
	return record?.version === 3
		&& record.verdict === "accept"
		&& record.approvalId === input.approvalId
		&& record.goal === input.goal
		&& resolve(record.planPath) === resolve(input.planPath)
		&& record.goalBlockHash === input.goalBlockHash
		&& resolve(record.repoRoot) === resolve(input.repoRoot)
		&& record.head === input.head
		&& record.tree === input.tree
		&& (record.force
			? Boolean(record.force.reason?.trim()) && Boolean(record.force.worktree) && Boolean(input.worktree)
				&& record.cleanWorktree === input.cleanWorktree
				&& JSON.stringify(record.force.worktree) === JSON.stringify(input.worktree)
			: record.cleanWorktree === true && input.cleanWorktree)
		&& record.inspected.plan === true
		&& record.inspected.repository === true
		&& record.inspected.evidence === true
		&& record.inspected.verifyOutput === true
		&& Boolean(record.verifyOutputPath);
}
