// PI/OpenAI, PI/Claude: goals-file helpers. The file is one page of Markdown for the user, agent and judge;
// code reads only its headings, from a CommonMark syntax tree, and splices the source at node offsets.
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Heading, Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

/** The agent writes from this ## heading down; everything above it is the page the user approved. */
export const NOTES = "Resume here";
export const EVIDENCE = "Evidence";
/** Limits in words: a line limit was met by packing lines (first real page, 2026-11-27).
 * wassname: "the main stuff is ok. notes I don't read and is for the AI". So the part he reads, ## Goal and ## Result mock-up,
 * has its own limit, and the whole page a looser one: it is re-sent to the agent after every compaction. */
export const READ_WORDS = 500;
export const PAGE_WORDS = 1200;
/** Nonblank lines that one replaceable note may hold. */
export const NOTE_LINES = 15;
const NOTE_LINE_CHARS = 160;
const EVIDENCE_LINES = 20;
const WIDGET_NOTE_MIN = 30;

const from = (node: Nodes) => node.position!.start.offset!;
const to = (node: Nodes) => node.position!.end.offset!;
const parse = (text: string): Root => fromMarkdown(text);
const rootHeadings = (root: Root) => root.children.filter((node): node is Heading => node.type === "heading");
/** Heading text as written (keeps `code` marks). */
const headingName = (text: string, heading: Heading) => heading.children.length ? text.slice(from(heading.children[0]), to(heading.children[heading.children.length - 1])).trim() : "";
const named = (text: string, root: Root, name: string) => rootHeadings(root).find((heading) => heading.depth === 2 && headingName(text, heading).toLowerCase() === name.toLowerCase());

function sectionRange(text: string, root: Root, name: string): [number, number] | undefined {
	const heading = named(text, root, name);
	if (!heading) return undefined;
	const next = rootHeadings(root).find((other) => from(other) > from(heading) && other.depth <= 2);
	return [to(heading), next ? from(next) : text.length];
}

/** Body of a named ## section, without its heading. */
export function section(text: string, name: string): string | undefined {
	const range = sectionRange(text, parse(text), name);
	return range && text.slice(...range).trim();
}

export function title(text: string): string | undefined {
	const heading = rootHeadings(parse(text)).find((h) => h.depth === 1);
	return heading && headingName(text, heading);
}

/** The page the user approved, and the agent's notes from ## Resume here to the end. */
export function split(text: string): { page: string; notes: string } {
	const heading = named(text, parse(text), NOTES);
	return heading ? { page: text.slice(0, from(heading)).trimEnd(), notes: text.slice(from(heading)) } : { page: text.trimEnd(), notes: "" };
}

/** Undo a change to the approved page and keep the new notes. Undefined when the page did not change. */
export function keepPage(before: string, after: string): string | undefined {
	const was = split(before);
	const now = split(after);
	if (was.page === now.page) return undefined;
	return now.notes ? `${was.page}\n\n${now.notes}` : before;
}

export const lineCount = (text: string) => text.split("\n").filter((line) => line.trim()).length;
export const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** The agent's note, cut to its limit: what is beyond it is never sent back, so the note gets replaced, not appended to. */
export function note(text: string): string {
	const lines = (section(text, NOTES) ?? "").split("\n").filter((line) => line.trim());
	return [...lines.slice(0, NOTE_LINES), ...(lines.length > NOTE_LINES ? [`(${lines.length - NOTE_LINES} more lines are not sent: replace this note, at most ${NOTE_LINES} lines)`] : [])].join("\n");
}

/** What is re-sent: the page, the note and the newest evidence lines. The rest of the agent's appendix stays in the file. */
export function view(text: string): string {
	const evidence = (section(text, EVIDENCE) ?? "").split("\n").filter((line) => line.trim());
	const older = evidence.length - EVIDENCE_LINES;
	return `${split(text).page}\n\n## ${NOTES}\n\n${note(text)}\n\n## ${EVIDENCE}\n\n${[...(older > 0 ? [`(${older} earlier lines are in the file)`] : []), ...evidence.slice(-EVIDENCE_LINES)].join("\n")}`.trimEnd();
}

/** Append one list line under ## Evidence, creating the section at the end if needed. */
export function appendEvidence(text: string, entry: string): string {
	const range = sectionRange(text, parse(text), EVIDENCE);
	if (!range) return `${text.trimEnd()}\n\n## ${EVIDENCE}\n\n- ${entry}\n`;
	const rest = text.slice(range[1]);
	return `${text.slice(0, range[1]).trimEnd()}\n- ${entry}\n${rest ? `\n${rest}` : ""}`;
}

/** One message the user typed, with the last lines of the agent message it answered. */
export interface UserMessage { at: string; text: string; before?: string }
/** wassname 2026-11-27: "first 1000 lines of user messages, last 1000 lines ... each user message with a few lines of prev message". */
const DIALOGUE_LINES = 1000;
const MESSAGE_LINES = 60;
const LINE_CHARS = 300;
export const BEFORE_LINES = 3;

/** The last nonblank lines of a text. */
/** The last lines of a reply that say something: a signature ("-- PI/Claude") or a bare file path is skipped. */
export const lastLines = (text: string, count: number) => text.split("\n").filter((line) => line.trim() && !/^\s*(--\s|\S*\/\S*\.\w+\s*$)/.test(line)).slice(-count).join("\n");

/** The user's messages in order, each after the end of the agent message it answered. A long history keeps its first and last 1,000 lines. */
export function dialogue(messages: UserMessage[]): string {
	const crop = (line: string) => line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line;
	const lines = messages.flatMap((message, index) => {
		const said = message.text.split("\n").filter((line) => line.trim());
		const kept = said.length > MESSAGE_LINES ? [...said.slice(0, MESSAGE_LINES / 2), `… (${said.length - MESSAGE_LINES} lines cut) …`, ...said.slice(-MESSAGE_LINES / 2)] : said;
		// The agent's words are quoted so they cannot be mistaken for the user's. The user may be answering any part of
		// that message; their own "> " quotes say which. A follow-up to the same agent message does not repeat it.
		const end = lastLines(message.before ?? "", BEFORE_LINES);
		const before = end && end !== lastLines(messages[index - 1]?.before ?? "", BEFORE_LINES) ? [`(after the agent's message that ended: "… ${end.split("\n").map(crop).join(" / ")}")`] : [];
		return [`### User, ${message.at}`, ...before, ...kept.map(crop), ""];
	});
	const cut = lines.length - 2 * DIALOGUE_LINES;
	return (cut > 0 ? [...lines.slice(0, DIALOGUE_LINES), `… (${cut} lines of the middle of the conversation cut) …`, ...lines.slice(-DIALOGUE_LINES)] : lines).join("\n").trim();
}

/** Theme colours for the widget; the default is plain text (RPC mode and tests). */
export interface WidgetStyle {
	fg(color: "accent" | "success" | "warning" | "dim", text: string): string;
}
const plainStyle: WidgetStyle = { fg: (_color, text) => text };

/** The goal as the user wrote it: the first paragraph of ## Goal, on one line. */
export function goalLead(text: string): string | undefined {
	const body = section(text, "Goal");
	const first = body === undefined ? undefined : parse(body).children.find((node) => node.type === "paragraph");
	return first && body!.slice(from(first), to(first)).split("\n").map((line) => line.trim()).join(" ");
}

const WIDGET_GOAL_LINES = 4;
const starts = (label: string) => (line: string) => line.toLowerCase().startsWith(label);
/** The note reads in a small widget: short labelled lines with a "Now:" among them, not a paragraph. */
export function noteIsReadable(text: string): boolean {
	const lines = (section(text, NOTES) ?? "").split("\n").filter((line) => line.trim());
	return !lines.length || (lines.some(starts("now:")) && lines.every((line) => line.length <= NOTE_LINE_CHARS));
}
/** Note lines that ask the user for a decision; the widget and the status line count them. */
export const needsYou = (text: string) => note(text).split("\n").filter(starts("needs you:"));
/** wassname 2026-11-27: "why is it not literally the goal from the goals.md"; a note written as one paragraph was "unreadable";
 * "remember 'needs you'? that was cool ... and 'you should know' is ok too".
 * Collapsed: the status and the file's short path, the goal, what needs the user, and the note's "Now:" line.
 * Expanded: the file's full path on its own line, so a terminal can open it, the goal wrapped, then every line of the note. */
export function widgetLines(text: string, status: string, width = 100, { expanded = false, style: s = plainStyle, path }: { expanded?: boolean; style?: WidgetStyle; path?: { short: string; full: string } } = {}): string[] {
	const clip = (line: string) => truncateToWidth(line, width, "…");
	const wrap = (line: string, indent: string) => wrapTextWithAnsi(line, Math.max(WIDGET_NOTE_MIN, width - indent.length - 2)).map((part, index) => clip(`  ${index ? indent : ""}${part}`));
	const noted = note(text).split("\n").filter(Boolean);
	const goal = goalLead(text) ?? title(text) ?? "(no goal)";
	const colour = status === "working" ? "accent" : status === "accepted" || status === "self-verified" ? "success" : "warning";
	const asks = noted.filter(starts("needs you:"));
	const paint = (line: string) => starts("needs you:")(line) ? s.fg("warning", line) : starts("you should know:")(line) ? s.fg("accent", line) : line;
	const header = `${s.fg(colour, `● goal ${status}`)}${asks.length ? ` · ${s.fg("warning", `${asks.length} need${asks.length === 1 ? "s" : ""} you`)}` : ""}${path && !expanded ? s.fg("dim", ` · ${path.short}`) : ""}${s.fg("dim", ` · click to ${expanded ? "collapse" : "expand"}`)}`;
	// The rest of the note (Saw, Waiting on, If it fails) is for the agent and the judge, not shown here.
	const now = noted.find(starts("now:")) ?? noted.find((line) => !asks.includes(line));
	const know = noted.filter(starts("you should know:"));
	if (!expanded) return [clip(header), clip(`  ${goal}`), ...asks.map((line) => clip(`  ${s.fg("warning", "?")} ${paint(line)}`)), ...(now ? [clip(`  ${s.fg("dim", "→")} ${now}`)] : [])];
	const told = wrap(goal, "");
	const shown = [...asks, ...know, ...(now ? [now] : [])];
	return [clip(header), ...(path ? [s.fg("dim", `  ${path.full}`)] : []), ...told.slice(0, WIDGET_GOAL_LINES), ...(told.length > WIDGET_GOAL_LINES ? [s.fg("dim", "  …")] : []), ...(shown.length ? [""] : []), ...shown.flatMap((line) => wrap(paint(line), "  "))];
}

/** Local time: agents write notes from the local clock they see. */
export function stamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
