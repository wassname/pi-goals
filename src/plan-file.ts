/**
 * plan-file.ts — read plan.md, and the two writes CompleteGoal needs. That is all.
 *
 * Pure module, no pi deps, so it unit-tests without a runtime. The file is the canonical store and
 * the agent edits it with its normal Edit tool (create goals, tick subtasks, append log), guided by
 * the format in prompts.ts and the reminder -- the form guides, it does not gate (spec D3). So this
 * module does NOT render or create goals; the format's single source of truth is the planDrafting
 * prompt. The only programmatic writers are setGoalStatus + appendLog, used by CompleteGoal to
 * record an accepted sign-off; both touch one line so the git diff stays readable.
 *
 * A goal's state lives in a checkbox on its header (single source of truth, renders natively):
 *   [ ] open   [/] active (in progress)   [x] done   [-] cancelled
 * Only CompleteGoal writes [x]; the agent sets [/] when it starts a goal.
 *
 * Format:
 *
 *   # Plan: <objective>
 *
 *   ## Goal: [ ] <subject>
 *   <!-- id: <slug> -->
 *   done_when: <one falsifiable check>
 *   verify: <shell command, optional>
 *   - [ ] <subtask>
 *
 *   failure_modes:
 *     - <pre-mortem item>
 *   evidence:
 *     - <proof the done_when is met; filled at completion, read by CompleteGoal>
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
	/** Pre-mortem: ways a "done" could be wrong. Written at planning. */
	failure_modes: string[];
	/** Proof the done_when is met, pointing at durable artifacts. Written at completion; read by CompleteGoal. */
	evidence: string[];
	subtasks: Subtask[];
}

export interface PlanDoc {
	objective: string;
	goals: Goal[];
	/** Verbatim ## Log lines, including the leading "- ". */
	log: string[];
}

// Goal header carries the state checkbox: `## Goal: [x] subject`. The checkbox is optional so a
// header written without one parses as open (group 1 undefined -> " ").
const GOAL_HEADER = /^##\s+Goal:\s*(?:\[([ xX/-])\]\s+)?(.*)$/;
const ANY_HEADER = /^#{1,6}\s/;
const LOG_HEADER = /^##\s+Log\s*$/i;
const ID_COMMENT = /^<!--\s*id:\s*(.+?)\s*-->$/;
const CHECKBOX = /^- \[([ xX])\]\s+(.*)$/;

const CHAR_TO_STATUS: Record<string, GoalStatus> = { " ": "open", "/": "active", x: "done", "-": "cancelled" };
const STATUS_TO_CHAR: Record<GoalStatus, string> = { open: " ", active: "/", done: "x", cancelled: "-" };

export function parse(text: string): PlanDoc {
	const lines = text.split("\n");
	let objective = "";
	const goals: Goal[] = [];
	const log: string[] = [];

	let cur: Goal | null = null;
	// While inside a `failure_modes:`/`evidence:` block, points at the list the "- " items append to.
	let curList: string[] | null = null;
	let inLog = false;

	const flush = () => {
		if (cur) goals.push(cur);
		cur = null;
		curList = null;
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
			const status = CHAR_TO_STATUS[(goalMatch[1] ?? " ").toLowerCase()] ?? "open";
			cur = { id: "", subject: goalMatch[2].trim(), status, done_when: "", failure_modes: [], evidence: [], subtasks: [] };
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

		// A checkbox (column 0) is a subtask; checked first so it is never read as a list item.
		const checkbox = CHECKBOX.exec(line);
		if (checkbox) {
			curList = null;
			cur.subtasks.push({ done: checkbox[1].toLowerCase() === "x", text: checkbox[2].trim() });
			continue;
		}

		const kv = /^(done_when|verify|failure_modes|evidence)\s*:\s*(.*)$/.exec(line);
		if (kv) {
			const [, key, value] = kv;
			if (key === "done_when") cur.done_when = value.trim();
			else if (key === "verify") cur.verify = value.trim() || undefined;
			// failure_modes/evidence open a "- " block; done_when/verify close any open one.
			curList = key === "failure_modes" ? cur.failure_modes : key === "evidence" ? cur.evidence : null;
			continue;
		}

		// Indented "- " items under failure_modes:/evidence: (a column-0 checkbox already returned above).
		if (curList) {
			const item = /^\s*-\s+(.*)$/.exec(line);
			if (item) {
				curList.push(item[1].trim());
				continue;
			}
			if (line.trim() !== "") curList = null;
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

/** Flip a goal's header checkbox in place (the one write CompleteGoal needs). Normalizes a header that
 *  lacks a checkbox by inserting one. */
export function setGoalStatus(text: string, id: string, status: GoalStatus): string {
	const lines = text.split("\n");
	const idIdx = lines.findIndex((l) => ID_COMMENT.exec(l.trim())?.[1] === id);
	if (idIdx === -1) throw new Error(`Goal #${id} not found`);
	// The header sits just above the id comment; scan upward for it.
	for (let i = idIdx; i >= 0; i--) {
		const m = GOAL_HEADER.exec(lines[i]);
		if (m) {
			lines[i] = `## Goal: [${STATUS_TO_CHAR[status]}] ${m[2].trim()}`;
			return lines.join("\n");
		}
	}
	throw new Error(`Goal #${id} has no ## Goal: header`);
}

/**
 * The outcome of a sign-off attempt, decided by CompleteGoal (which runs verify + the judge). Kept
 * separate from the I/O so the record logic below is pure and testable.
 */
export type SignOff =
	| { kind: "verify_failed"; exitCode: number; outputTail: string }
	| { kind: "rejected"; missing: string }
	| { kind: "accepted" };

/** Apply a sign-off outcome to plan.md text: accept flips the header checkbox to [x] + logs; reject only logs. Pure. */
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
