// PI/OpenAI: goals-file helpers. The file is prose for the user, agent and judge; code reads only
// goal lines, named sections and the Log fold.
export const GOAL_LINE = /^\s*(?:\d+\.|[-*])\s*\[([ xX/✓-])\]\s*goal:\s*(.*)$/i;
const SUBTASK_LINE = /^\s+(?:\d+\.|[-*])\s*\[([ xX/-])\]\s*(.*)$/;
const FOLD_LINE = /^#{1,6}[ \t]+Log[ \t]*\r?$/im;
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*$/;
const WIDGET_GOAL_LIMIT = 3;

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

export function withoutSection(text: string, name: string): string {
	const lines = text.split("\n");
	const range = sectionRange(lines, name);
	if (!range) return text;
	lines.splice(range[0], range[1] - range[0]);
	return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function openSubtasks(text: string, goalLine: number): string[] {
	const lines = text.split("\n");
	const out: string[] = [];
	for (let i = goalLine + 1; i < lines.length && !GOAL_LINE.test(lines[i]) && !HEADING.test(lines[i]); i++) {
		const match = SUBTASK_LINE.exec(lines[i]);
		if (match && (match[1] === " " || match[1] === "/")) out.push(match[2].trim());
	}
	return out;
}

const MARK: Record<GoalStatus, string> = { active: "◼", reported: "x", open: "◻", done: "✓", cancelled: "✗" };
const PRIORITY: Record<GoalStatus, number> = { active: 0, reported: 1, open: 2, done: 3, cancelled: 4 };

/** Widget: current goals first, open subtasks under the first unfinished goal, then the file path. */
export function widgetLines(text: string, path: string): string[] {
	const items = goals(text);
	const sorted = [...items].sort((a, b) => PRIORITY[a.status] - PRIORITY[b.status]);
	const lines: string[] = [];
	sorted.slice(0, WIDGET_GOAL_LIMIT).forEach((goal, index) => {
		lines.push(`${MARK[goal.status]} G${items.indexOf(goal) + 1}: ${goal.subject}`);
		if (index === 0 && (goal.status === "active" || goal.status === "open")) lines.push(...openSubtasks(text, goal.line).slice(0, 3).map((task) => `   ◦ ${task}`));
	});
	const hidden = sorted.slice(WIDGET_GOAL_LIMIT);
	const counts = (Object.keys(MARK) as GoalStatus[]).map((status) => {
		const count = hidden.filter((goal) => goal.status === status).length;
		return count ? `${count} ${MARK[status]}` : "";
	}).filter(Boolean);
	lines.push(`${counts.length ? `… ${counts.join(", ")}; ` : ""}${path}`);
	return lines;
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
