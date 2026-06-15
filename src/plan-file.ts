/**
 * plan-file.ts — read plan.md, and the two writes CompleteGoal needs. That is all.
 *
 * Pure module, no pi deps, so it unit-tests without a runtime. The file is the canonical store and
 * the agent edits it with its normal Edit tool (create goals, tick subtasks, append log), guided by
 * the format in prompts.tsx and the reminder -- the form guides, it does not gate (spec D3). So this
 * module does NOT render or create goals; the format's single source of truth is the planDrafting
 * prompt. The only programmatic writers are setGoalStatus + appendLog, used by CompleteGoal to
 * record an accepted sign-off; both touch one line so the git diff stays readable.
 *
 * Format (spec §4):
 *
 *   # Plan: <objective>
 *
 *   ## Goal: <subject>
 *   <!-- id: <slug> -->
 *   status: open | active | done | cancelled
 *   done_when: <one falsifiable check>
 *   verify: <shell command, optional>
 *   failure_modes:
 *     - <pre-mortem item>
 *   - [ ] <subtask>
 *
 *   ## Log
 *   - <verbatim append-only line>
 */

export type GoalStatus = "open" | "active" | "done" | "cancelled";

export interface Subtask {
	text: string;
	done: boolean;
}

export interface Goal {
	id: string;
	subject: string;
	status: GoalStatus;
	done_when: string;
	verify?: string;
	failure_modes: string[];
	subtasks: Subtask[];
}

export interface PlanDoc {
	objective: string;
	goals: Goal[];
	/** Verbatim ## Log lines, including the leading "- ". */
	log: string[];
}

const GOAL_HEADER = /^##\s+Goal:\s*(.*)$/;
const ANY_HEADER = /^#{1,6}\s/;
const LOG_HEADER = /^##\s+Log\s*$/i;
const ID_COMMENT = /^<!--\s*id:\s*(.+?)\s*-->$/;
const CHECKBOX = /^- \[([ xX])\]\s+(.*)$/;

export function parse(text: string): PlanDoc {
	const lines = text.split("\n");
	let objective = "";
	const goals: Goal[] = [];
	const log: string[] = [];

	let cur: Goal | null = null;
	let inFailureModes = false;
	let inLog = false;

	const flush = () => {
		if (cur) goals.push(cur);
		cur = null;
		inFailureModes = false;
	};

	for (const line of lines) {
		const objMatch = /^#\s+Plan:\s*(.*)$/.exec(line);
		if (objMatch) {
			objective = objMatch[1].trim();
			continue;
		}

		const goalMatch = GOAL_HEADER.exec(line);
		if (goalMatch) {
			flush();
			inLog = false;
			cur = { id: "", subject: goalMatch[1].trim(), status: "open", done_when: "", failure_modes: [], subtasks: [] };
			continue;
		}

		if (LOG_HEADER.test(line)) {
			flush();
			inLog = true;
			continue;
		}

		// Any other header ends the current goal / log section.
		if (ANY_HEADER.test(line)) {
			flush();
			inLog = false;
			continue;
		}

		if (inLog) {
			if (/^\s*-\s+/.test(line)) log.push(line);
			continue;
		}

		if (!cur) continue;

		const idMatch = ID_COMMENT.exec(line.trim());
		if (idMatch) {
			cur.id = idMatch[1];
			continue;
		}

		// A checkbox (column 0) is a subtask; checked first so it is never read as a failure mode.
		const checkbox = CHECKBOX.exec(line);
		if (checkbox) {
			inFailureModes = false;
			cur.subtasks.push({ done: checkbox[1].toLowerCase() === "x", text: checkbox[2].trim() });
			continue;
		}

		const kv = /^(status|done_when|verify|failure_modes)\s*:\s*(.*)$/.exec(line);
		if (kv) {
			const [, key, value] = kv;
			if (key === "status") cur.status = value.trim() as GoalStatus;
			else if (key === "done_when") cur.done_when = value.trim();
			else if (key === "verify") cur.verify = value.trim() || undefined;
			else if (key === "failure_modes") inFailureModes = true;
			continue;
		}

		// Indented "- " items under failure_modes: (a column-0 checkbox already returned above).
		if (inFailureModes) {
			const fm = /^\s*-\s+(.*)$/.exec(line);
			if (fm) {
				cur.failure_modes.push(fm[1].trim());
				continue;
			}
			if (line.trim() !== "") inFailureModes = false;
		}
	}
	flush();

	return { objective, goals, log };
}

export function findGoal(doc: PlanDoc, id: string): Goal | undefined {
	return doc.goals.find((g) => g.id === id);
}

export function counts(doc: PlanDoc): { done: number; open: number; active: number } {
	const c = { done: 0, open: 0, active: 0 };
	for (const g of doc.goals) {
		if (g.status === "done") c.done++;
		else if (g.status === "active") c.active++;
		else if (g.status === "open") c.open++;
	}
	return c;
}

/** Flip a goal's `status:` line in place (the one write CompleteGoal needs). */
export function setGoalStatus(text: string, id: string, status: GoalStatus): string {
	const lines = text.split("\n");
	let i = lines.findIndex((l) => ID_COMMENT.test(l.trim()) && ID_COMMENT.exec(l.trim())?.[1] === id);
	if (i === -1) throw new Error(`Goal #${id} not found`);
	for (; i < lines.length; i++) {
		if (i > 0 && ANY_HEADER.test(lines[i]) && !GOAL_HEADER.test(lines[i]) && !LOG_HEADER.test(lines[i])) break;
		const kv = /^(status\s*:\s*)(.*)$/.exec(lines[i]);
		if (kv) {
			lines[i] = `${kv[1]}${status}`;
			return lines.join("\n");
		}
	}
	throw new Error(`Goal #${id} has no status: line`);
}

/**
 * The outcome of a sign-off attempt, decided by CompleteGoal (which runs verify + the judge). Kept
 * separate from the I/O so the record logic below is pure and testable.
 */
export type SignOff =
	| { kind: "verify_failed"; exitCode: number; outputTail: string }
	| { kind: "rejected"; missing: string }
	| { kind: "accepted" };

/** Apply a sign-off outcome to plan.md text: accept flips status + logs; reject only logs. Pure. */
export function recordSignOff(
	text: string,
	goalId: string,
	when: string,
	outcome: SignOff,
): { content: string; message: string; isError: boolean } {
	const goal = findGoal(parse(text), goalId);
	if (!goal) return { content: text, message: `No goal #${goalId} in plan.md.`, isError: true };

	if (outcome.kind === "verify_failed") {
		const content = appendLog(text, `${when} reject #${goalId}: verify exit ${outcome.exitCode}`);
		return { content, message: `Sign-off rejected: verify failed (exit ${outcome.exitCode}).\n${outcome.outputTail}`, isError: true };
	}
	if (outcome.kind === "rejected") {
		const oneLine = outcome.missing.replace(/\s+/g, " ").trim().slice(0, 200);
		const content = appendLog(text, `${when} reject #${goalId}: ${oneLine}`);
		return { content, message: `Sign-off rejected. Missing:\n${outcome.missing}`, isError: true };
	}
	const flipped = setGoalStatus(text, goalId, "done");
	const content = appendLog(flipped, `${when} signed off #${goalId}: ${goal.subject} (oracle accept)`);
	return { content, message: `Signed off #${goalId}: ${goal.subject}. Marked done in plan.md.`, isError: false };
}

/** Append one verbatim line to ## Log (creating the section if absent). The other CompleteGoal write. */
export function appendLog(text: string, entry: string): string {
	const lines = text.split("\n");
	const line = `- ${entry}`;
	const header = lines.findIndex((l) => LOG_HEADER.test(l));
	if (header === -1) return `${text.replace(/\n+$/, "")}\n\n## Log\n${line}\n`;

	let insertAt = header + 1;
	for (let i = header + 1; i < lines.length; i++) {
		if (ANY_HEADER.test(lines[i])) break;
		if (/^\s*-\s+/.test(lines[i])) insertAt = i + 1;
	}
	lines.splice(insertAt, 0, line);
	return lines.join("\n");
}
