// PI/OpenAI, PI/Claude: goals-file helpers. The file is prose for the user, agent and judge; code reads
// only goal and task items, named sections and the Log fold, from a CommonMark syntax tree.
// Edits splice the source at node offsets, so the rest of the file keeps its exact text.
import { createHash } from "node:crypto";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Heading, ListItem, Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

const WIDGET_GOAL_LIMIT = 3;
const WIDGET_LABEL_MIN = 30;
const WIDGET_WAITING_LIMIT = 3;
const WAKE_TASK_LIMIT = 8;
const HOUR = 3_600_000;
const RESYNC_INTERVIEW_LIMIT = 10;

// [x] means reported done without a judge accept; [✓] means the judge accepted it.
export type GoalStatus = "open" | "active" | "reported" | "done" | "cancelled";
// [?] is a task mark: the task waits on the user's decision. On a goal line it reads as active.
const STATUS: Record<string, GoalStatus> = { " ": "open", "/": "active", "?": "active", x: "reported", "✓": "done", "-": "cancelled" };
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

const isWaiting = (task: Checkbox) => task.mark === "?";
const isDone = (task: Checkbox) => !" /?".includes(task.mark);
const isUnfinished = (goal: Goal) => goal.status !== "done" && goal.status !== "cancelled";

/** [?] tasks of unfinished goals: what the user must decide, shown first in the widget. */
export function waitingTasks(text: string): { goal: number; label: string }[] {
	return goals(text).flatMap((goal, index) => isUnfinished(goal) ? goalTasks(text, goal).filter(isWaiting).map((task) => ({ goal: index + 1, label: task.label })) : []);
}

/** Task-looking lines that CommonMark reads as text: a numbered list right after a text line must start at 1. */
export function hiddenTasks(text: string): string[] {
	const heads = goals(text).flatMap((goal) => [goal.item, ...subItems(goal.item).filter((item) => fieldKey(item) === "tasks")]);
	return heads.flatMap((item) => {
		const head = item.children[0];
		const lines = head?.type === "paragraph" ? text.slice(from(head), to(head)).split("\n").slice(1) : [];
		return lines.filter((line) => /^\s*\d+[.)]\s+\[[ /?xX✓-]\]\s/.test(line)).map((line) => line.trim());
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

/** PI/Claude: open tasks of [/] goals with the time their text last changed. Ages are sampled at each wake and
 * kept for open tasks of every goal, so pausing a goal does not reset them. Keys use goal and task text, not
 * list position, and the hash ignores list numbers, so reordering is not a change.
 * `waiting` lists [?] tasks of unfinished goals; `idle` names [/] goals with no open task of either kind. */
export function ageTasks(text: string, before: TaskSince, now: number): { since: TaskSince; lines: string[]; waiting: string[]; idle: string[] } {
	const since: TaskSince = {};
	const rows: { line: string; at: number }[] = [];
	const waiting: { line: string; at: number }[] = [];
	const idle: string[] = [];
	for (const [index, goal] of goals(text).entries()) {
		const open = goalTasks(text, goal).filter((task) => !isDone(task));
		if (goal.status === "active" && !open.length) idle.push(`G${index + 1}`);
		for (const task of open) {
			let key = `${goal.subject} :: ${task.label}`;
			for (let n = 2; key in since; n++) key = `${goal.subject} :: ${task.label} #${n}`;
			const body = text.slice(from(task.item), to(task.item)).replace(/^\d+[.)]\s*/, "");
			const hash = createHash("sha1").update(body).digest("hex").slice(0, 12);
			const at = before[key]?.[0] === hash ? before[key][1] : now;
			since[key] = [hash, at];
			const row = { line: `G${index + 1} ${firstLine(text, task.item).trim()}`, at };
			if (isWaiting(task)) { if (isUnfinished(goal)) waiting.push(row); }
			else if (goal.status === "active") rows.push(row);
		}
	}
	const hours = (at: number) => { const h = Math.floor((now - at) / HOUR); return h < 1 ? "under 1 h" : `${h} h`; };
	const list = (items: { line: string; at: number }[]) => {
		const sorted = [...items].sort((a, b) => a.at - b.at);
		const hidden = sorted.length - WAKE_TASK_LIMIT;
		return [...sorted.slice(0, WAKE_TASK_LIMIT).map((row) => `- ${row.line} · unchanged ${hours(row.at)}`), ...(hidden > 0 ? [`- … ${hidden} more in the goals file`] : [])];
	};
	return { since, lines: list(rows), waiting: list(waiting), idle };
}

/** The aim: the lines under the title. Files written before the aim moved there keep it in ## User-visible result. */
export function aim(text: string): string | undefined {
	const root = parse(text);
	const title = rootHeadings(root).find((heading) => heading.depth === 1);
	const next = rootHeadings(root).find((heading) => heading !== title && (!title || from(heading) > from(title)));
	return section(text, "User-visible result") || text.slice(title ? to(title) : 0, next ? from(next) : text.length).trim() || undefined;
}

/** Aim and one status line per goal; resync sends the file above the Log. */
export function loopFocus(text: string): string {
	const stated = aim(text);
	if (!stated) throw new Error("The goals file needs its aim: one or two lines under the title.");
	return `Aim:\n${stated}\n\nGoals:\n${goals(text).map((goal) => goal.line.trim()).join("\n")}`;
}

/** PI/Claude: screen lines are scarce. Questions for the user, then one line per [/] goal: tasks finished, the task
 * in progress and how many more are in progress. The label is cut before that count is. */
export function widgetLines(text: string, width = 100): string[] {
	const items = goals(text);
	const waiting = waitingTasks(text);
	// Up to two lines each: the user needs the whole question, not its first half.
	const lines: [string, string][] = waiting.slice(0, WIDGET_WAITING_LIMIT).flatMap((task) => {
		const [first, ...rest] = wrapTextWithAnsi(`? needs you (G${task.goal}): ${task.label}`, width);
		return rest.length ? [[first, ""], [`  ${rest.join(" ")}`, ""]] : [[first, ""]];
	});
	if (waiting.length > WIDGET_WAITING_LIMIT) lines.push([`? … ${waiting.length - WIDGET_WAITING_LIMIT} more need you`, ""]);
	const active = items.filter((goal) => goal.status === "active");
	for (const goal of active.slice(0, WIDGET_GOAL_LIMIT)) {
		const tasks = goalTasks(text, goal);
		const open = tasks.filter((task) => !isDone(task) && !isWaiting(task));
		const current = open.filter((task) => task.mark === "/");
		const count = tasks.length ? ` ${tasks.filter(isDone).length}/${tasks.length}` : "";
		lines.push([`◼ G${items.indexOf(goal) + 1}${count} · ${(current[0] ?? open[0])?.label ?? goal.subject}`, current.length > 1 ? ` · +${current.length - 1} in progress` : ""]);
	}
	if (active.length > WIDGET_GOAL_LIMIT) lines.push([`◼ … ${active.length - WIDGET_GOAL_LIMIT} more active goals`, ""]);
	// A narrow terminal keeps the label and drops the tail.
	return lines.map(([line, tail]) => {
		const room = width - visibleWidth(tail);
		return room >= WIDGET_LABEL_MIN ? truncateToWidth(line, room, "…") + tail : truncateToWidth(line, width, "…");
	});
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

/** Bounds what a resync sends however long the task list gets: accepted and cancelled goals keep only their line,
 * finished tasks become a count, and notes stay only on [/] and [?] tasks. */
function foldGoals(text: string): string {
	const edits: [number, number, string][] = [];
	const notes = (item: ListItem): [number, number, string] => [to(item.children[0]), to(item), ""];
	for (const goal of goals(text)) {
		if (!isUnfinished(goal)) { edits.push(notes(goal.item)); continue; }
		const tasks = goalTasks(text, goal);
		const done = tasks.filter(isDone);
		done.forEach((task, index) => {
			const start = text.lastIndexOf("\n", from(task.item) - 1) + 1;
			edits.push([start, Math.min(text.length, to(task.item) + 1), index ? "" : `${text.slice(start, from(task.item))}(${done.length} finished task${done.length > 1 ? "s" : ""} left out)\n`]);
		});
		edits.push(...tasks.filter((task) => task.mark === " ").map((task) => notes(task.item)));
	}
	return edits.sort((a, b) => b[0] - a[0]).reduce((out, [start, end, put]) => out.slice(0, start) + put + out.slice(end), text);
}

const RESYNC_FIRST = ["user-visible result", "user voice", "goals"];
/** The title and aim, then the user's words, then the goals; other ## sections follow in file order. */
function arrange(text: string): string {
	const heads = rootHeadings(parse(text)).filter((heading) => heading.depth === 2);
	if (!heads.length) return text;
	const rank = (heading: Heading) => (RESYNC_FIRST.indexOf(headingName(text, heading).toLowerCase()) + 1) || RESYNC_FIRST.length + 1;
	const parts = heads.map((heading, index) => ({ rank: rank(heading), body: text.slice(from(heading), heads[index + 1] ? from(heads[index + 1]) : text.length).trimEnd() }));
	return [text.slice(0, from(heads[0])).trimEnd(), ...parts.sort((a, b) => a.rank - b.rank).map((part) => part.body)].filter(Boolean).join("\n\n");
}

/** What a resync sends: the file above ## Log, arranged and folded, and the newest Interview entries. The Log, the
 * folded task text and older entries stay in the file. */
export function fold(text: string): { top: string; recent: string[]; older: number; cut: boolean } {
	const cut = rootHeadings(parse(text)).find((heading) => ["log", "interview"].includes(headingName(text, heading).toLowerCase()));
	const entries = interviewEntries(text);
	return { top: arrange(foldGoals((cut ? text.slice(0, from(cut)) : text).trimEnd())), recent: entries.slice(-RESYNC_INTERVIEW_LIMIT), older: Math.max(0, entries.length - RESYNC_INTERVIEW_LIMIT), cut: Boolean(cut) };
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
