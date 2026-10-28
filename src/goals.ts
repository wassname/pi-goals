// PI/OpenAI: goals-file helpers. The file is prose for the user, agent and judge; code reads only
// goal lines, named sections and the Log fold.
import { truncateToWidth } from "@earendil-works/pi-tui";

export const GOAL_LINE = /^\s*(?:\d+\.|[-*])\s*\[([ xX/✓-])\]\s*goal:\s*(.*)$/i;
const FOLD_LINE = /^#{1,6}[ \t]+Log[ \t]*\r?$/im;
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*$/;
const WIDGET_GOAL_LIMIT = 3;
const WIDGET_TASK_LIMIT = 5;
const TASK_LINE = /^\s*(?:\d+\.|[-*])\s*\[([ xX/✓-])\]\s*(.*)$/;

// [x] means reported done without a judge accept; [✓] means the judge accepted it.
export type GoalStatus = "open" | "active" | "reported" | "done" | "cancelled";
const STATUS: Record<string, GoalStatus> = { " ": "open", "/": "active", x: "reported", "✓": "done", "-": "cancelled" };
export interface Goal {
	status: GoalStatus;
	subject: string;
	line: number;
}

export function goals(text: string): Goal[] {
	return foldGoals(text).split("\n").flatMap((line, index) => {
		const match = GOAL_LINE.exec(line);
		return match ? [{ status: STATUS[match[1].toLowerCase()] ?? "open", subject: match[2].trim(), line: index }] : [];
	});
}

/** PI/OpenAI: keep nested headings inside a goal; stop at the next goal or top-level section. */
function goalBlock(lines: string[], goal: Goal): string[] {
	const end = lines.findIndex((line, index) => index > goal.line && (GOAL_LINE.test(line) || (HEADING.exec(line)?.[1].length ?? Infinity) <= 2));
	return lines.slice(goal.line, end === -1 ? lines.length : end);
}

/** Checkbox lines between this goal and the next goal; done = [x]/[✓]/[-]. */
function goalTasks(text: string, goal: Goal): { mark: string; subject: string; done: boolean }[] {
	return goalBlock(foldGoals(text).split("\n"), goal).slice(1).flatMap((line) => {
		const match = TASK_LINE.exec(line);
		return match ? [{ mark: match[1], subject: match[2].trim(), done: !" /".includes(match[1]) }] : [];
	});
}

/** Open and active tasks of [/] goals, indented under the goal line; finished ones are counted. */
function activeTaskLines(text: string, goal: Goal, limit = Infinity): string[] {
	if (goal.status !== "active") return [];
	const tasks = goalTasks(text, goal);
	const open = tasks.filter((task) => !task.done);
	const done = tasks.length - open.length;
	const hidden = Math.max(0, open.length - limit);
	const tail = [hidden ? `${hidden} more` : "", done ? `${done} done` : ""].filter(Boolean).join(", ");
	return [...open.slice(0, limit).map((task) => `    [${task.mark}] ${task.subject}`), ...(tail ? [`    … ${tail}`] : [])];
}

export const hasRemainingGoals = (text: string, judge = true) => goals(text).some((goal) => goal.status === "open" || goal.status === "active" || (judge && goal.status === "reported"));

/** Everything above the Log heading: the current requirements and goals. */
export function foldGoals(text: string): string {
	const match = FOLD_LINE.exec(text);
	return (match ? text.slice(0, match.index) : text).trimEnd();
}

function sectionRange(lines: string[], name: string): [number, number] | undefined {
	const start = lines.findIndex((line) => HEADING.exec(line)?.[2].toLowerCase() === name.toLowerCase());
	if (start === -1) return undefined;
	const level = HEADING.exec(lines[start])![1].length;
	const end = lines.findIndex((line, index) => index > start && (HEADING.exec(line)?.[1].length ?? Infinity) <= level);
	return [start, end === -1 ? lines.length : end];
}

/** Names of the ## headings, in order. */
export const headings = (text: string) => [...text.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)].map((match) => match[1]);

/** Body of a named section, without its heading. */
export function section(text: string, name: string): string | undefined {
	const lines = text.split("\n");
	const range = sectionRange(lines, name);
	return range && lines.slice(range[0] + 1, range[1]).join("\n").trim();
}

const indent = (line: string) => line.length - line.trimStart().length;
const FIELD_NAME = /^\s*[-*]\s+([^:]{1,80}?):/;
// What defines done; repeated on every wake. Other fields are only named.
const WAKE_FIELDS = new Set(["subtle failure mode", "discriminator", "verify", "completion criteria"]);

/** Nonblank lines grouped into items: each item is a least-indented line plus the deeper lines under it. */
function listItems(lines: string[]): string[][] {
	const nonblank = lines.filter((line) => line.trim());
	const level = Math.min(...nonblank.map(indent));
	const items: string[][] = [];
	for (const line of nonblank) {
		if (indent(line) <= level || !items.length) items.push([line]);
		else items[items.length - 1].push(line);
	}
	return items;
}

/** PI/Claude: a [/] goal for the loop wake: what defines done and the unfinished task titles. Other fields are named so the agent rereads the file for them. */
function wakeSummary(block: string[]): string[] {
	const [goalLine, ...body] = block;
	const heading = body.findIndex((line) => HEADING.test(line));
	const fields = heading === -1 ? body : body.slice(0, heading);
	const shown = [goalLine];
	const hidden: string[] = [];
	for (const item of listItems(fields)) {
		const raw = FIELD_NAME.exec(item[0])?.[1].trim() ?? "notes";
		const key = raw.replace(/\s*\(.*$/, "").toLowerCase();
		const name = raw.includes("(") && !raw.includes(")") ? key : raw;
		if (WAKE_FIELDS.has(key)) shown.push(...item);
		else if (key === "tasks" && item.length > 1) {
			const tasks = listItems(item.slice(1));
			const open = tasks.filter((task) => " /".includes(TASK_LINE.exec(task[0])?.[1] ?? "x"));
			if (open.length) shown.push(item[0], ...open.map((task) => task[0]));
			if (tasks.length > open.length) hidden.push(`${tasks.length - open.length} finished tasks`);
			if (open.some((task) => task.length > 1)) hidden.push("task details");
		} else hidden.push(name);
	}
	if (heading !== -1) hidden.push(...body.slice(heading).filter((line) => HEADING.test(line)).map((line) => HEADING.exec(line)![2]));
	if (hidden.length) shown.push(`${" ".repeat(indent(goalLine) + 3)}- not shown here: ${hidden.join("; ")}`);
	return shown;
}

export function loopFocus(text: string): string {
	const lines = foldGoals(text).split("\n");
	const outcome = section(text, "User-visible result");
	if (!outcome) throw new Error("The goals file needs a User-visible result.");
	const items = goals(text);
	const active = items.filter(goal => goal.status === "active").map(goal => wakeSummary(goalBlock(lines, goal)).join("\n"));
	return `User-visible result:\n${outcome}\n\nGoal status:\n${items.map(goal => lines[goal.line].trim()).join("\n")}${active.length ? `\n\nActive goals (summary; the goals file has the rest):\n${active.join("\n\n")}` : ""}`;
}

const MARK: Record<GoalStatus, string> = { active: "◼", reported: "☑", open: "◻", done: "✓", cancelled: "✗" };
const PRIORITY: Record<GoalStatus, number> = { active: 0, reported: 1, open: 2, done: 3, cancelled: 4 };

/** PI/OpenAI: goal titles/status; open tasks only under [/] goals, to keep the widget short. */
export function widgetLines(text: string, path: string, width = 100): string[] {
	const items = goals(text);
	const sorted = [...items].sort((a, b) => PRIORITY[a.status] - PRIORITY[b.status]);
	const lines: string[] = [];
	for (const goal of sorted.slice(0, WIDGET_GOAL_LIMIT)) {
		lines.push(`${MARK[goal.status]} G${items.indexOf(goal) + 1}: ${goal.subject}`, ...activeTaskLines(text, goal, WIDGET_TASK_LIMIT));
	}
	const hidden = sorted.slice(WIDGET_GOAL_LIMIT);
	const counts = (Object.keys(MARK) as GoalStatus[]).map((status) => {
		const count = hidden.filter((goal) => goal.status === status).length;
		return count ? `${count} ${MARK[status]}` : "";
	}).filter(Boolean);
	lines.push(`${counts.length ? `… ${counts.join(", ")}; ` : ""}${path}`);
	return lines.map(line => truncateToWidth(line, width, "…"));
}

/** Set the checkbox of the one goal whose subject matches exactly (case-insensitive). */
export function markGoal(text: string, goal: string, mark: "x" | "✓"): string | undefined {
	const lines = text.split("\n");
	const want = goal.trim().toLowerCase();
	const hits = goals(text).filter(item => item.subject.toLowerCase() === want).map(item => item.line);
	if (hits.length !== 1) return undefined;
	lines[hits[0]] = lines[hits[0]].replace(/\[[ xX/✓-]\]/, `[${mark}]`);
	return lines.join("\n");
}

/** Append one line under ## Log, creating the section at the end if needed. */
export function appendLog(text: string, entry: string): string {
	const lines = text.split("\n");
	const header = lines.findIndex((line) => /^##\s+Log\s*$/i.test(line));
	if (header === -1) return `${text.replace(/\n+$/, "")}\n\n## Log\n- ${entry}\n`;
	let insertAt = header + 1;
	for (let i = header + 1; i < lines.length && !HEADING.test(lines[i]); i++) if (/^\s*-\s+/.test(lines[i])) insertAt = i + 1;
	lines.splice(insertAt, 0, `- ${entry}`);
	return lines.join("\n");
}

/** Keep the user's messages verbatim below the fold. */
export function appendInterview(text: string, answer: string): string {
	return insertInterview(text, [`### ${stamp()}`, "", ...answer.split("\n").map((line) => `> ${line}`), ""].join("\n"));
}

/** Entries (### stamp + quoted message) in ## Interview. */
export function interviewEntries(text: string): string[] {
	const body = section(text, "Interview");
	return body ? body.split(/^(?=### )/m).map((entry) => entry.trim()).filter(Boolean) : [];
}

/** Put back entries an agent edit removed; the user's words are not the agent's to rewrite. */
export function restoreInterview(text: string, entries: string[]): { text: string; restored: number } {
	const kept = new Set(interviewEntries(text));
	const missing = entries.filter((entry) => !kept.has(entry));
	return { text: missing.reduce((out, entry) => insertInterview(out, `${entry}\n`), text), restored: missing.length };
}

function insertInterview(text: string, entry: string): string {
	const lines = text.split("\n");
	const header = lines.findIndex((line) => /^##\s+Interview\s*$/i.test(line));
	if (header === -1) return `${text.replace(/\n+$/, "")}\n\n## Interview\n\n${entry}`;
	let insertAt = header + 1;
	while (insertAt < lines.length && !/^##\s+/.test(lines[insertAt])) insertAt++;
	lines.splice(insertAt, 0, entry);
	return lines.join("\n");
}

/** Local time: agents write manual Log lines from the local clock they see. */
export function stamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
