// PI/OpenAI, PI/Claude: goals-file helpers. The file is prose for the user, agent and judge; code reads
// only goal and task items, named sections and the Log fold, from a CommonMark syntax tree.
// Edits splice the source at node offsets, so the rest of the file keeps its exact text.
import { createHash } from "node:crypto";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Heading, ListItem, Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

const WIDGET_GOAL_LIMIT = 3;
const WIDGET_TASK_LIMIT = 5;
const WAKE_TASK_LIMIT = 8;
const HOUR = 3_600_000;

// [x] means reported done without a judge accept; [✓] means the judge accepted it.
export type GoalStatus = "open" | "active" | "reported" | "done" | "cancelled";
const STATUS: Record<string, GoalStatus> = { " ": "open", "/": "active", x: "reported", "✓": "done", "-": "cancelled" };
export interface Goal {
	status: GoalStatus;
	subject: string;
	/** "1. [/] goal: subject", as written. */
	line: string;
	item: ListItem;
}
interface Checkbox { mark: string; label: string; item: ListItem }

const from = (node: Nodes) => node.position!.start.offset!;
const to = (node: Nodes) => node.position!.end.offset!;
const parse = (text: string): Root => fromMarkdown(text);
const firstLine = (text: string, node: Nodes) => text.slice(from(node), to(node)).split("\n")[0];
const plain = (node: Nodes): string => "value" in node ? node.value : "children" in node ? (node.children as Nodes[]).map(plain).join("") : "";
/** Heading text as written (keeps `code` marks): saved heading lists are compared against it. */
const headingName = (text: string, heading: Heading) => heading.children.length ? text.slice(from(heading.children[0]), to(heading.children[heading.children.length - 1])).trim() : "";
const rootHeadings = (root: Root) => root.children.filter((node): node is Heading => node.type === "heading");
/** List items, not inside blockquotes: a quoted goal is an example, not a goal. */
const allItems = (node: Nodes): ListItem[] => node.type === "blockquote" ? [] : [...(node.type === "listItem" ? [node] : []), ...("children" in node ? (node.children as Nodes[]).flatMap(allItems) : [])];
/** Items of the lists directly inside an item: a goal's fields, or a field's entries. */
const subItems = (item: ListItem) => item.children.flatMap((child) => child.type === "list" ? child.children : []);
/** "subtle failure mode" from "- subtle failure mode: …"; "tasks" from "- tasks (wassname: …):". */
function fieldKey(item: ListItem): string | undefined {
	const head = item.children[0];
	const words = head?.type === "paragraph" ? plain(head).split("\n")[0] : "";
	const colon = words.indexOf(":");
	return colon > 0 ? words.slice(0, colon).split("(")[0].trim().toLowerCase() : undefined;
}

/** A list item whose first paragraph starts with [c]. Not GFM task syntax, which has no [/], [✓] or [-]. */
function checkbox(text: string, item: ListItem): Checkbox | undefined {
	const head = item.children[0];
	const line = head?.type === "paragraph" ? firstLine(text, head) : "";
	return line[0] === "[" && line[2] === "]" && line[1].toLowerCase() in STATUS ? { mark: line[1], label: line.slice(3).trim(), item } : undefined;
}

/** Goals above the Log heading (any level). */
export function goals(text: string): Goal[] {
	const root = parse(text);
	const log = rootHeadings(root).find((heading) => headingName(text, heading).toLowerCase() === "log");
	return allItems(root).flatMap((item) => {
		const box = checkbox(text, item);
		if (!box?.label.toLowerCase().startsWith("goal:") || (log && from(item) > from(log))) return [];
		return [{ status: STATUS[box.mark.toLowerCase()], subject: box.label.slice(5).trim(), line: text.slice(from(item), from(item.children[0])) + firstLine(text, item.children[0]), item }];
	});
}

/** Checkbox items directly under the goal or under its "tasks:" field. */
const goalTasks = (text: string, goal: Goal): Checkbox[] =>
	subItems(goal.item).flatMap((item) => checkbox(text, item) ?? (fieldKey(item) === "tasks" ? subItems(item).flatMap((task) => checkbox(text, task) ?? []) : []));

const isDone = (task: Checkbox) => !" /".includes(task.mark);

/** Open and active tasks of [/] goals, indented under the goal line; finished ones are counted. */
function activeTaskLines(text: string, goal: Goal, limit = Infinity): string[] {
	if (goal.status !== "active") return [];
	const tasks = goalTasks(text, goal);
	const open = tasks.filter((task) => !isDone(task));
	const done = tasks.length - open.length;
	const hidden = Math.max(0, open.length - limit);
	const tail = [hidden ? `${hidden} more` : "", done ? `${done} done` : ""].filter(Boolean).join(", ");
	return [...open.slice(0, limit).map((task) => `    [${task.mark}] ${task.label}`), ...(tail ? [`    … ${tail}`] : [])];
}

/** Task-looking lines that CommonMark reads as text: a numbered list right after a text line must start at 1. */
export function hiddenTasks(text: string): string[] {
	const heads = goals(text).flatMap((goal) => [goal.item, ...subItems(goal.item).filter((item) => fieldKey(item) === "tasks")]);
	return heads.flatMap((item) => {
		const head = item.children[0];
		const lines = head?.type === "paragraph" ? text.slice(from(head), to(head)).split("\n").slice(1) : [];
		return lines.filter((line) => /^\s*\d+[.)]\s+\[.\]/.test(line)).map((line) => line.trim());
	});
}

export const hasRemainingGoals = (text: string, judge = true) => goals(text).some((goal) => goal.status === "open" || goal.status === "active" || (judge && goal.status === "reported"));

function sectionRange(text: string, root: Root, name: string): [number, number] | undefined {
	const all = rootHeadings(root);
	const index = all.findIndex((heading) => headingName(text, heading).toLowerCase() === name.toLowerCase());
	if (index === -1) return undefined;
	const next = all.slice(index + 1).find((heading) => heading.depth <= all[index].depth);
	return [to(all[index]), next ? from(next) : text.length];
}

/** Names of the ## headings, in order. */
export const headings = (text: string) => { const root = parse(text); return rootHeadings(root).filter((heading) => heading.depth === 2).map((heading) => headingName(text, heading)); };

/** Body of a named section, without its heading. */
export function section(text: string, name: string): string | undefined {
	const range = sectionRange(text, parse(text), name);
	return range && text.slice(...range).trim();
}

/** When each task's text (mark, label, notes) last changed, as [text hash, ms]; keyed by goal number and label. */
export type TaskSince = Record<string, [string, number]>;

/** PI/Claude: open tasks of [/] goals with the time their text last changed. Ages are sampled at each wake. */
export function ageTasks(text: string, before: TaskSince, now: number): { since: TaskSince; lines: string[] } {
	const since: TaskSince = {};
	const rows: { line: string; at: number }[] = [];
	for (const [index, goal] of goals(text).entries()) {
		if (goal.status !== "active") continue;
		for (const task of goalTasks(text, goal).filter((task) => !isDone(task))) {
			const key = `${index + 1} ${task.label}`;
			const source = createHash("sha1").update(text.slice(from(task.item), to(task.item))).digest("hex").slice(0, 12);
			const at = before[key]?.[0] === source ? before[key][1] : now;
			since[key] = [source, at];
			rows.push({ line: `G${index + 1} ${firstLine(text, task.item).trim()}`, at });
		}
	}
	rows.sort((a, b) => a.at - b.at);
	const hours = (at: number) => { const h = Math.floor((now - at) / HOUR); return h < 1 ? "under 1 h" : `${h} h`; };
	const hidden = rows.length - WAKE_TASK_LIMIT;
	return { since, lines: [...rows.slice(0, WAKE_TASK_LIMIT).map((row) => `- ${row.line} · unchanged ${hours(row.at)}`), ...(hidden > 0 ? [`- … ${hidden} more in the goals file`] : [])] };
}

/** Outcome and one status line per goal; the whole file is sent after Ready, compaction and resume. */
export function loopFocus(text: string): string {
	const outcome = section(text, "User-visible result");
	if (!outcome) throw new Error("The goals file needs a User-visible result.");
	return `User-visible result:\n${outcome}\n\nGoals:\n${goals(text).map((goal) => goal.line.trim()).join("\n")}`;
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
	return lines.map((line) => truncateToWidth(line, width, "…"));
}

/** Set the checkbox of the one goal whose subject matches exactly (case-insensitive). */
export function markGoal(text: string, goal: string, mark: "x" | "✓"): string | undefined {
	const want = goal.trim().toLowerCase();
	const hits = goals(text).filter((item) => item.subject.toLowerCase() === want);
	if (hits.length !== 1) return undefined;
	const at = from(hits[0].item.children[0]) + 1;
	return text.slice(0, at) + mark + text.slice(at + 1);
}

/** Append one line to the list under ## Log, creating the section at the end if needed. */
export function appendLog(text: string, entry: string): string {
	const root = parse(text);
	const log = rootHeadings(root).find((heading) => heading.depth === 2 && headingName(text, heading).toLowerCase() === "log");
	if (!log) return `${text.trimEnd()}\n\n## Log\n- ${entry}\n`;
	const next = rootHeadings(root).find((heading) => from(heading) > from(log));
	const lists = root.children.filter((node) => node.type === "list" && from(node) > from(log) && (!next || from(node) < from(next)));
	const at = lists.length ? to(lists[lists.length - 1]) : to(log);
	return `${text.slice(0, at)}\n- ${entry}${text.slice(at)}`;
}

/** Keep the user's messages verbatim below the fold. */
export function appendInterview(text: string, answer: string): string {
	return insertInterview(text, [`### ${stamp()}`, "", ...answer.split("\n").map((line) => `> ${line}`), ""].join("\n"));
}

/** Entries (### stamp + quoted message) in ## Interview. */
export function interviewEntries(text: string): string[] {
	const root = parse(text);
	const range = sectionRange(text, root, "Interview");
	if (!range) return [];
	const cuts = [range[0], ...rootHeadings(root).filter((heading) => heading.depth >= 3 && from(heading) > range[0] && from(heading) < range[1]).map(from), range[1]];
	return cuts.slice(1).map((cut, index) => text.slice(cuts[index], cut).trim()).filter(Boolean);
}

/** Put back entries an agent edit removed; the user's words are not the agent's to rewrite. */
export function restoreInterview(text: string, entries: string[]): { text: string; restored: number } {
	const kept = new Set(interviewEntries(text));
	const missing = entries.filter((entry) => !kept.has(entry));
	return { text: missing.reduce((out, entry) => insertInterview(out, `${entry}\n`), text), restored: missing.length };
}

/** Add an entry at the end of ## Interview, creating the section at the end if needed. */
function insertInterview(text: string, entry: string): string {
	const range = sectionRange(text, parse(text), "Interview");
	if (!range) return `${text.trimEnd()}\n\n## Interview\n\n${entry}`;
	const rest = text.slice(range[1]);
	return `${text.slice(0, range[1]).trimEnd()}\n\n${entry}${rest ? `\n${rest}` : ""}`;
}

/** Local time: agents write manual Log lines from the local clock they see. */
export function stamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
