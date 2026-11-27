// PI/OpenAI, PI/Claude: goals-file helpers. The file is one page of Markdown for the user, agent and judge;
// code reads only its headings, from a CommonMark syntax tree, and splices the source at node offsets.
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Heading, Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

/** The agent writes from this ## heading down; everything above it is the page the user approved. */
export const NOTES = "Resume here";
export const EVIDENCE = "Evidence";
/** Nonblank lines: what the user can review at once, and what one replaceable note may hold. */
export const PAGE_LINES = 80;
export const NOTE_LINES = 15;
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

/** Theme colours for the widget; the default is plain text (RPC mode and tests). */
export interface WidgetStyle {
	fg(color: "accent" | "success" | "warning" | "dim", text: string): string;
}
const plainStyle: WidgetStyle = { fg: (_color, text) => text };

/** One header line (status and title), then the first line of the agent's note; expanded, the whole note. */
export function widgetLines(text: string, status: string, width = 100, { expanded = false, style: s = plainStyle }: { expanded?: boolean; style?: WidgetStyle } = {}): string[] {
	const clip = (line: string) => truncateToWidth(line, width, "…");
	const shown = note(text).split("\n").filter(Boolean);
	const colour = status === "working" ? "accent" : status === "accepted" || status === "self-verified" ? "success" : "warning";
	const lines = [clip(`${s.fg(colour, `● goal ${status}`)} · ${title(text) ?? "(no title)"}${shown.length > 1 ? s.fg("dim", ` · click to ${expanded ? "collapse" : "expand"}`) : ""}`)];
	if (!shown.length) return lines;
	if (!expanded) return [...lines, clip(`  ${s.fg("dim", "→")} ${shown[0]}`)];
	return [...lines, ...shown.flatMap((line) => wrapTextWithAnsi(line, Math.max(WIDGET_NOTE_MIN, width - 4)).map((part) => clip(`  ${part}`)))];
}

/** Local time: agents write notes from the local clock they see. */
export function stamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
