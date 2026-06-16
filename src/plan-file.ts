/**
 * plan-file.ts — read goals.md, and the two writes CompleteGoal needs. That is all.
 *
 * Pure module, no pi deps, so it unit-tests without a runtime. The file is the canonical store and
 * the agent edits it with its normal Edit tool (create goals, tick subtasks, fill evidence), guided
 * by the format in prompts.ts and the reminder -- the form guides, it does not gate. The only
 * programmatic writers are setGoalStatus + appendLog, used by CompleteGoal to record an accepted
 * sign-off; both touch one line so the diff stays readable.
 *
 * Format (markdown, checkbox-first, made to be skim-reviewed by a human):
 *
 *   # <plan title>
 *
 *   <context: the user's ask, preferences, decisions>
 *
 *   ## Goals
 *
 *   1. [ ] goal: <desc>            <- state in the checkbox: [ ] open  [/] active  [x] done  [-] cancelled
 *     - discriminator: <positive observation that the goal succeeded, that no failure below could fake>
 *     - subtle failure mode: <a way this looks done but isn't>
 *     - verify: <optional shell command that exits 0 only when the discriminator passes>
 *     - tasks:
 *       1. [x] <subtask>           <- a subtask is any checkbox WITHOUT a "goal:" prefix
 *       2. [/] <subtask>
 *       3. [-] <subtask>           <- [-] or ~~[ ]~~ both read as cancelled
 *     - evidence:                  <- empty at planning; filled at sign-off, read by CompleteGoal
 *       - > <artifact path / link / metric, plus a short read of it>
 *   2. [ ] goal: <desc>
 *
 *   # Future work / out of scope
 *
 *   ## Log
 *   - <verbatim append-only line>
 *
 * A goal/subtask's state lives in its checkbox (single source of truth, renders natively). Goals are
 * matched by their <desc> (the text after "goal:"); the list number is human-facing only. Only
 * CompleteGoal writes a goal's [x]; the agent sets [/] when it starts one.
 */

export type GoalStatus = "open" | "active" | "done" | "cancelled";

export interface Subtask {
	text: string;
	status: GoalStatus;
}

export interface Goal {
	/** The text after "goal:" in the header line; the handle CompleteGoal matches on. */
	subject: string;
	status: GoalStatus;
	/** Positive observation(s) that the goal succeeded AND that no failure mode could fake. The success test. Written at planning. */
	discriminator: string[];
	/** Subtle ways a "done" could be wrong (look-like-success failures). Written at planning. */
	failure_modes: string[];
	/** Optional command that exits 0 only when the discriminator passes (the cheap deterministic gate). */
	verify?: string;
	/** Proof the discriminator passed, pointing at durable artifacts. Written at completion; read by CompleteGoal. */
	evidence: string[];
	subtasks: Subtask[];
}

export interface PlanDoc {
	title: string;
	goals: Goal[];
	/** Verbatim ## Log lines, including the leading "- ". */
	log: string[];
}

const TITLE = /^#\s+(.+?)\s*$/; // the first single-# H1
const GOALS_HEADER = /^##\s+Goals\s*$/i;
const LOG_HEADER = /^##\s+Log\s*$/i;
const ANY_HEADER = /^#{1,6}\s/;
// A goal: a numbered or bulleted checkbox item whose text begins "goal:".
const GOAL_ITEM = /^\s*(?:\d+\.|[-*])\s*\[([ xX/-])\]\s*goal:\s*(.*)$/i;
// A section marker bullet under a goal (the trailing colon is optional, e.g. "- tasks").
const KEY_LINE = /^\s*[-*]\s*(discriminator|subtle failure modes?|failure_modes?|verify|tasks?|evidence)\s*:?\s*(.*)$/i;
// Any list item (numbered or bulleted); used for subtasks and for list items inside the sections.
const LIST_ITEM = /^\s*(?:\d+\.|[-*])\s+(.*)$/;
// A checkbox inside a list-item body (subtask). A leading/trailing ~~ marks it cancelled.
const CHECKBOX_BODY = /^(~~)?\s*\[([ xX/-])\]\s*(.*)$/;

const CHAR_TO_STATUS: Record<string, GoalStatus> = { " ": "open", "/": "active", x: "done", "-": "cancelled" };
const STATUS_TO_CHAR: Record<GoalStatus, string> = { open: " ", active: "/", done: "x", cancelled: "-" };

function normalizeKey(raw: string): "discriminator" | "failure_modes" | "verify" | "tasks" | "evidence" {
	const k = raw.toLowerCase();
	if (k.startsWith("discriminator")) return "discriminator";
	if (k.startsWith("verify")) return "verify";
	if (k.startsWith("task")) return "tasks";
	if (k.startsWith("evidence")) return "evidence";
	return "failure_modes"; // "subtle failure mode(s)" / "failure_mode(s)"
}

export function parse(text: string): PlanDoc {
	const lines = text.split("\n");
	let title = "";
	const goals: Goal[] = [];
	const log: string[] = [];

	let cur: Goal | null = null;
	let curList: string[] | null = null; // the discriminator/failure_modes/evidence list "- " items append to
	let inGoals = false;
	let inLog = false;

	const flush = () => {
		if (cur) goals.push(cur);
		cur = null;
		curList = null;
	};

	for (const line of lines) {
		const tM = TITLE.exec(line);
		if (tM && !title && !GOALS_HEADER.test(line) && !LOG_HEADER.test(line)) {
			title = tM[1].trim();
			continue;
		}
		if (GOALS_HEADER.test(line)) {
			flush();
			inGoals = true;
			inLog = false;
			continue;
		}
		if (LOG_HEADER.test(line)) {
			flush();
			inGoals = false;
			inLog = true;
			continue;
		}
		// Any other header (e.g. "# Future work") ends the goals / log section.
		if (ANY_HEADER.test(line)) {
			flush();
			inGoals = false;
			inLog = false;
			continue;
		}

		if (inLog) {
			if (/^\s*-\s+/.test(line)) log.push(line);
			continue;
		}
		if (!inGoals) continue; // title + context prose between the title and ## Goals

		const goalM = GOAL_ITEM.exec(line);
		if (goalM) {
			flush();
			cur = {
				subject: goalM[2].trim(),
				status: CHAR_TO_STATUS[goalM[1].toLowerCase()] ?? "open",
				discriminator: [],
				failure_modes: [],
				evidence: [],
				subtasks: [],
			};
			continue;
		}
		if (!cur) continue;

		const keyM = KEY_LINE.exec(line);
		if (keyM) {
			const key = normalizeKey(keyM[1]);
			const inlineVal = keyM[2].trim();
			if (key === "verify") {
				cur.verify = inlineVal || undefined;
				curList = null;
			} else if (key === "tasks") {
				curList = null; // subtasks are identified by being a checkbox; this marker is cosmetic
			} else {
				curList = cur[key]; // discriminator | failure_modes | evidence
				if (inlineVal) curList.push(inlineVal);
			}
			continue;
		}

		const listM = LIST_ITEM.exec(line);
		if (listM) {
			const body = listM[1];
			const cb = CHECKBOX_BODY.exec(body);
			if (cb) {
				// A checkbox without a "goal:" prefix is a subtask of the current goal.
				const cancelled = cb[1] === "~~" || body.includes("~~");
				const status = cancelled ? "cancelled" : (CHAR_TO_STATUS[cb[2].toLowerCase()] ?? "open");
				cur.subtasks.push({ text: cb[3].replace(/~~/g, "").trim(), status });
				curList = null;
				continue;
			}
			// A plain "- " / "> " item belongs to the current section (discriminator/failure/evidence).
			if (curList) curList.push(body.trim());
			continue;
		}

		// A non-empty, non-"- " line continues the current item, so multi-line evidence (a block quote
		// of a log, a table, an interpretation line) stays attached to its item. Blank lines are skipped.
		if (curList && line.trim() !== "" && curList.length > 0) {
			curList[curList.length - 1] += `\n${line.trim()}`;
		}
	}
	flush();

	return { title, goals, log };
}

export function findGoal(doc: PlanDoc, subject: string): Goal | undefined {
	const want = subject.trim();
	return doc.goals.find((g) => g.subject === want);
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

/** Flip a goal's checkbox in place, matched by its subject (the one write CompleteGoal needs). */
export function setGoalStatus(text: string, subject: string, status: GoalStatus): string {
	const lines = text.split("\n");
	const want = subject.trim();
	for (let i = 0; i < lines.length; i++) {
		const m = GOAL_ITEM.exec(lines[i]);
		if (m && m[2].trim() === want) {
			lines[i] = lines[i].replace(/\[[ xX/-]\]/, `[${STATUS_TO_CHAR[status]}]`);
			return lines.join("\n");
		}
	}
	throw new Error(`Goal "${subject}" not found`);
}

/**
 * The outcome of a sign-off attempt, decided by CompleteGoal (which runs verify + the judge). Kept
 * separate from the I/O so the record logic below is pure and testable.
 */
export type SignOff =
	| { kind: "verify_failed"; exitCode: number; outputTail: string }
	| { kind: "rejected"; missing: string }
	| { kind: "accepted" };

/** Apply a sign-off outcome to goals.md text: accept flips the goal checkbox to [x] + logs; reject only logs. Pure. */
export function recordSignOff(
	text: string,
	subject: string,
	when: string,
	outcome: SignOff,
): { content: string; message: string; isError: boolean } {
	const goal = findGoal(parse(text), subject);
	if (!goal) return { content: text, message: `No goal "${subject}" in goals.md.`, isError: true };

	if (outcome.kind === "verify_failed") {
		const content = appendLog(text, `${when} reject "${subject}": verify exit ${outcome.exitCode}`);
		return { content, message: `Sign-off rejected: verify failed (exit ${outcome.exitCode}).\n${outcome.outputTail}`, isError: true };
	}
	if (outcome.kind === "rejected") {
		const oneLine = outcome.missing.replace(/\s+/g, " ").trim().slice(0, 200);
		const content = appendLog(text, `${when} reject "${subject}": ${oneLine}`);
		return { content, message: `Sign-off rejected. Missing:\n${outcome.missing}`, isError: true };
	}
	const flipped = setGoalStatus(text, subject, "done");
	const content = appendLog(flipped, `${when} signed off "${subject}" (judge accept)`);
	return { content, message: `Signed off "${subject}". Marked done in goals.md.`, isError: false };
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
