// PI/OpenAI, PI/Claude: goals-file helpers. The file is prose for the user, agent and judge; code reads
// only goal and task items, named sections and the Log fold, from a CommonMark syntax tree.
// Edits splice the source at node offsets, so the rest of the file keeps its exact text.
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Heading, ListItem, Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

const WIDGET_GOAL_LIMIT = 3;
const WIDGET_TASK_LIMIT = 5;
// Other fields of a [/] goal are cut to this many chars on loop wakes, with a visible marker.
const FIELD_PREVIEW = 160;
// What defines done; repeated in full on every wake.
const WAKE_FIELDS = new Set(["subtle failure mode", "discriminator", "verify", "completion criteria"]);
// [x] is not a GFM task here: plain CommonMark keeps "[/] goal: …" as the item's first text.
const CHECKBOX = /^\[([ xX/✓-])\][ \t]*/;

// [x] means reported done without a judge accept; [✓] means the judge accepted it.
export type GoalStatus = "open" | "active" | "reported" | "done" | "cancelled";
const STATUS: Record<string, GoalStatus> = { " ": "open", "/": "active", x: "reported", "✓": "done", "-": "cancelled" };
export interface Goal {
	status: GoalStatus;
	subject: string;
	/** "1. [/] goal: subject", as written. */
	line: string;
	item: ListItem;
	/** Where this goal's block ends: the next goal, a heading of level 1-2, or the Log fold. */
	end: number;
}
interface Checkbox { mark: string; label: string; item: ListItem }

const from = (node: Nodes) => node.position!.start.offset!;
const to = (node: Nodes) => node.position!.end.offset!;
const parse = (text: string): Root => fromMarkdown(text);
const headingName = (text: string, heading: Heading) => heading.children.length ? text.slice(from(heading.children[0]), to(heading.children[heading.children.length - 1])).trim() : "";
const rootHeadings = (root: Root) => root.children.filter((node): node is Heading => node.type === "heading");
const firstLine = (text: string, node: Nodes) => text.slice(from(node), to(node)).split("\n")[0];

/** A list item whose first paragraph starts with [c]. */
function checkbox(text: string, item: ListItem): Checkbox | undefined {
	const head = item.children[0];
	if (head?.type !== "paragraph") return undefined;
	const match = CHECKBOX.exec(firstLine(text, head));
	return match ? { mark: match[1], label: firstLine(text, head).slice(match[0].length).trim(), item } : undefined;
}

/** Block nodes that start in [lo, hi), outermost only; lists are opened into their items. */
function blocksIn(node: Nodes, lo: number, hi: number, out: Nodes[] = []): Nodes[] {
	if (from(node) >= hi || to(node) <= lo) return out;
	if (from(node) >= lo && node.type !== "list" && node.type !== "root") out.push(node);
	else if ("children" in node && node.type !== "paragraph" && node.type !== "heading") for (const child of node.children) blocksIn(child as Nodes, lo, hi, out);
	return out;
}

const allItems = (node: Nodes): ListItem[] => [
	...(node.type === "listItem" ? [node] : []),
	...("children" in node ? (node.children as Nodes[]).flatMap(allItems) : []),
];

/** Goals above the Log heading (any level). */
export function goals(text: string): Goal[] {
	const root = parse(text);
	const log = rootHeadings(root).find((heading) => headingName(text, heading).toLowerCase() === "log");
	const fold = log ? from(log) : text.length;
	const found = allItems(root).flatMap((item) => {
		const box = checkbox(text, item);
		const subject = box?.label.match(/^goal:\s*(.*)$/i)?.[1];
		return box && subject !== undefined && from(item) < fold ? [{ box, subject }] : [];
	});
	const stops = [...found.map(({ box }) => from(box.item)), ...rootHeadings(root).filter((heading) => heading.depth <= 2).map(from), fold];
	return found.map(({ box, subject }) => ({
		status: STATUS[box.mark.toLowerCase()] ?? "open",
		subject: subject.trim(),
		line: text.slice(from(box.item), from(box.item.children[0])) + firstLine(text, box.item.children[0]),
		item: box.item,
		end: Math.min(...stops.filter((stop) => stop > from(box.item))),
	}));
}

/** The goal's own parts: named fields, tasks, nested headings and loose notes. */
function goalParts(text: string, goal: Goal) {
	const parts = blocksIn(parse(text), to(goal.item.children[0]), goal.end);
	const fields: { key: string; item: ListItem }[] = [];
	const tasks: Checkbox[] = [];
	const headings: string[] = [];
	let notes = 0;
	for (const part of parts) {
		if (part.type === "heading") headings.push(headingName(text, part));
		else if (headings.length) continue; // content under a nested heading belongs to that heading
		else if (part.type !== "listItem") notes++;
		else if (checkbox(text, part)) tasks.push(checkbox(text, part)!);
		else {
			// "tasks (wassname: …):" is the tasks field
			const key = firstLine(text, part.children[0] ?? part).match(/^([^:(]{1,80}?)\s*[:(]/)?.[1].toLowerCase();
			if (!key) notes++;
			else if (key === "tasks") tasks.push(...part.children.flatMap((child) => child.type === "list" ? child.children.flatMap((item) => checkbox(text, item) ?? []) : []));
			else fields.push({ key, item: part });
		}
	}
	return { fields, tasks, headings, notes };
}

const isDone = (task: Checkbox) => !" /".includes(task.mark);

/** Open and active tasks of [/] goals, indented under the goal line; finished ones are counted. */
function activeTaskLines(text: string, goal: Goal, limit = Infinity): string[] {
	if (goal.status !== "active") return [];
	const tasks = goalParts(text, goal).tasks;
	const open = tasks.filter((task) => !isDone(task));
	const done = tasks.length - open.length;
	const hidden = Math.max(0, open.length - limit);
	const tail = [hidden ? `${hidden} more` : "", done ? `${done} done` : ""].filter(Boolean).join(", ");
	return [...open.slice(0, limit).map((task) => `    [${task.mark}] ${task.label}`), ...(tail ? [`    … ${tail}`] : [])];
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

/** Source of a node, re-indented to its column so nested lines keep their shape. */
const block = (text: string, node: Nodes) => " ".repeat(node.position!.start.column - 1) + text.slice(from(node), to(node)).trimEnd();

/** PI/Claude: a [/] goal for the loop wake. Fields that define done in full, other fields cut to one
 * marked line, unfinished task titles; evidence, finished tasks and task details are counted. */
function wakeSummary(text: string, goal: Goal): string[] {
	const { fields, tasks, headings: nested, notes } = goalParts(text, goal);
	const pad = " ".repeat(goal.item.position!.start.column + 2);
	const shown = [goal.line.trimStart()];
	const hidden: string[] = [];
	for (const { key, item } of fields) {
		if (WAKE_FIELDS.has(key)) shown.push(block(text, item));
		else if (key === "evidence") hidden.push(allItems(item).length > 1 ? `evidence (${allItems(item).length - 1} items)` : "evidence");
		else {
			const flat = text.slice(from(item.children[0]), to(item)).replace(/\s+/g, " ").trim();
			shown.push(flat.length <= FIELD_PREVIEW ? `${pad}- ${flat}` : `${pad}- ${flat.slice(0, FIELD_PREVIEW)}… [cut, ${flat.length - FIELD_PREVIEW} more chars in the goals file]`);
		}
	}
	const open = tasks.filter((task) => !isDone(task));
	if (open.length) shown.push(`${pad}- unfinished tasks:`, ...open.map((task) => `${pad}  ${firstLine(text, task.item)}`));
	if (tasks.length > open.length) hidden.push(`${tasks.length - open.length} finished tasks`);
	if (open.some((task) => task.item.children.length > 1)) hidden.push("task details");
	hidden.push(...nested, ...(notes ? [`notes (${notes})`] : []));
	if (hidden.length) shown.push(`${pad}- not shown here: ${hidden.join("; ")}`);
	return shown;
}

export function loopFocus(text: string): string {
	const outcome = section(text, "User-visible result");
	if (!outcome) throw new Error("The goals file needs a User-visible result.");
	const items = goals(text);
	const active = items.filter((goal) => goal.status === "active").map((goal) => wakeSummary(text, goal).join("\n"));
	return `User-visible result:\n${outcome}\n\nGoal status:\n${items.map((goal) => goal.line.trim()).join("\n")}${active.length ? `\n\nActive goals (summary; the goals file has the rest):\n${active.join("\n\n")}` : ""}`;
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
