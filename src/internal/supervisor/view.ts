/**
 * The worker view: what the supervisor judges from.
 *
 * Built from ctx.sessionManager.getBranch(), which already follows the live leaf path, so a fork
 * or a rewind cannot leave dead entries in here. There is no disk read and no cross-branch merge.
 *
 * The body is pi-vcc's compiler, the same algorithmic compactor the worker can run, called here on
 * the live messages with the worker's last compaction summary as previousSummary. So the view is
 * "compaction summary, merged with everything since". We add what a compactor has no reason to
 * track: unanswered tool calls and whether anything changed since the last review.
 */

import { normalize } from "@sting8k/pi-vcc/src/core/normalize.ts";
import { compile } from "@sting8k/pi-vcc/src/core/summarize.ts";
import { extractCommits } from "@sting8k/pi-vcc/src/extract/commits.ts";
import { extractFiles } from "@sting8k/pi-vcc/src/extract/files.ts";

const SUPERVISOR_PREFIX = "[supervisor] ";

/** Entry shapes we read. Only the fields this file touches, taken from real session jsonl. */
export interface Block {
  type: string;
  id?: string;
  text?: string;
  /** Set on `type: "thinking"` blocks. Empty when the provider redacted the reasoning. */
  thinking?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}
export interface AgentMsg {
  role: "user" | "assistant" | "toolResult" | string;
  content?: string | Block[];
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
}
export interface Entry {
  type: string;
  message?: AgentMsg;
  /** ISO, written on every entry by the session manager (core/session-manager.d.ts:21). */
  timestamp?: string;
  /** Written by whichever compactor the worker runs. VCC's summary lands here too. */
  summary?: string;
  tokensBefore?: number;
}

/**
 * Milliseconds since the worker last put a message in its session.
 *
 * The clock a stuck worker shows on, and the only one that reads the same for both ways of being
 * stuck: sitting at the prompt, and inside one command that never returns. A supervisor directive
 * does not reset it. Time since the last look measures the supervisor instead, and understates a
 * worker that stopped hours before.
 */
export function sinceLastTurn(entries: Entry[], now = Date.now()): number {
  const last = [...entries].reverse().find((e) =>
    e.type === "message" && e.timestamp && !(e.message?.role === "user" && textOf(e.message).startsWith(SUPERVISOR_PREFIX))
  );
  return last ? now - Date.parse(last.timestamp!) : 0;
}

/** A duration a supervisor can read at a glance: 2h27m, 45m, 30s. */
export function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Extension channel payloads cap at 16 KiB, so the view must stay under it. */
export const MAX_VIEW_BYTES = 15000;
const GOAL_PREVIEW_CHARS = 160;

/** A long goal remains identifiable in every view without replaying its whole rubric. */
export function goalPreview(goal: string): string {
  if (!goal.includes("\n")) return goal || "not set";
  const firstLine = goal.split("\n").find((line) => line.trim())?.trim() || "not set";
  return `${firstLine.slice(0, GOAL_PREVIEW_CHARS)} [...]`;
}

function blocks(msg: AgentMsg): Block[] {
  return Array.isArray(msg.content) ? msg.content : [];
}

function textOf(msg: AgentMsg): string {
  if (typeof msg.content === "string") return msg.content;
  return blocks(msg)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

/**
 * Tool calls with no matching result on this branch. A settled worker with an unanswered
 * subagent call still has delegated work running, and "done" then means nothing.
 */
export function outstandingWork(entries: Entry[]): string[] {
  const called = new Map<string, string>();
  const answered = new Set<string>();
  for (const entry of entries) {
    const msg = entry.message;
    if (!msg) continue;
    for (const b of blocks(msg)) {
      if (b.type === "toolCall" && b.id) called.set(b.id, b.name ?? "?");
    }
    if (msg.role === "toolResult" && msg.toolCallId) answered.add(msg.toolCallId);
  }
  return [...called].filter(([id]) => !answered.has(id)).map(([, name]) => name);
}

/** The summary written by whichever compactor the worker runs. Empty when it has not compacted. */
export function compactionSummary(entries: Entry[]): string {
  let summary = "";
  for (const entry of entries) {
    if (entry.type === "compaction" && entry.summary) summary = entry.summary;
  }
  return summary;
}

/**
 * What the worker has changed: the files it wrote and the commits it made.
 *
 * Two reviews with the same key mean the last instruction produced neither. That is evidence for
 * the supervisor, not a rule: re-editing one file while a test still fails looks the same, and is
 * sometimes the right thing to be doing.
 *
 * Read from pi-vcc's extractor rather than from its rendered section, which caps the list at ten
 * paths and would freeze this key on any run long enough to matter.
 */
export function progressKey(entries: Entry[]): string {
  const blocks = normalize(messagesSince(entries) as any);
  const files = extractFiles(blocks);
  const commits = extractCommits(blocks).map((c) => c.hash ?? c.message);
  return [[...files.modified].sort(), [...files.created].sort(), commits].map((p) => p.join(",")).join("||");
}

/**
 * Messages after the worker's last compaction.
 *
 * getBranch keeps the entries a compaction replaced, so handing every message to compile alongside
 * the summary would send the supervisor both copies and spend the byte budget twice. Supervisor
 * directives already live in the supervisor transcript, so exclude their worker-session echo.
 */
function messagesSince(entries: Entry[]): AgentMsg[] {
  const lastCompaction = entries.map((e) => e.type).lastIndexOf("compaction");
  return entries
    .slice(lastCompaction + 1)
    .filter((e) => e.type === "message" && e.message)
    .map((e) => e.message!)
    .filter((message) => message.role !== "user" || !textOf(message).startsWith(SUPERVISOR_PREFIX));
}

/** What the caller records after a view goes out, and hands back as `since` on the next one. */
export function turnsSince(entries: Entry[]): number {
  return messagesSince(entries).length;
}

/** Reasoning blocks kept, newest first, and the tail kept from each. A block ends on a decision. */
const THINKING_BLOCKS = 2;
const THINKING_CHARS = 400;

/**
 * Keep the last few reasoning blocks by rewriting them as text, and let pi-vcc drop the rest.
 *
 * normalize() keeps only text and toolCall blocks from an assistant message, so reasoning never
 * reaches the supervisor although you see it on screen. Rewriting in place leaves each thought
 * next to the tool call it produced, which is the order you read a session in. A separate section
 * at the top of the view would divorce the thought from what it did.
 *
 * Only the last two, because one worker session here held 161 reasoning blocks and all of them
 * would make the view a second transcript. Everything older needs no work: pi-vcc drops it.
 */
function keepRecentThinking(msgs: AgentMsg[]): AgentMsg[] {
  const keep = new Set<string>();
  outer: for (let i = msgs.length - 1; i >= 0; i--) {
    const content = msgs[i].content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      if (content[j].type !== "thinking" || !content[j].thinking) continue;
      keep.add(`${i}:${j}`);
      if (keep.size === THINKING_BLOCKS) break outer;
    }
  }
  if (!keep.size) return msgs;
  return msgs.map((msg, i) =>
    Array.isArray(msg.content)
      ? {
        ...msg,
        content: msg.content.map((b, j) =>
          keep.has(`${i}:${j}`) ? { type: "text", text: `(thinking) ${b.thinking!.slice(-THINKING_CHARS)}` } : b
        ),
      }
      : msg
  );
}

const VCC_SEPARATOR = "\n\n---\n\n";
/** pi-vcc's section names, in the order formatSummary writes them (its format.ts). */
const VCC_HEADERS = ["Session Goal", "Files And Changes", "Commits", "Outstanding Context", "User Preferences"];

/**
 * pi-vcc's compiled summary, split into its header sections and its brief transcript.
 *
 * compile() writes `sections + "\n\n---\n\n" + brief`, and drops either part when it is empty, so
 * all four combinations are possible. Get this wrong and the header block lands in the transcript,
 * where the byte cut eats the newest turns instead of the oldest.
 */
function vccSections(fresh: AgentMsg[]): { headers: string; brief: string } {
  // No previousSummary: compile's merge reads the fresh brief with briefOf, which finds nothing
  // when the fresh messages produced no header sections, and the newest turns vanish. The
  // compaction summary goes into the view above this instead, which loses nothing.
  //
  // compile appends a note telling the reader to call vcc_recall, which the supervisor does not
  // have. Matched on the tool name because wrapLongLines rewraps the note before we see it.
  const compiled = compile({ messages: keepRecentThinking(fresh) as any })
    .replace(/\n*-*\n*Use `vcc_recall`[\s\S]*$/, "")
    .trim();
  if (!VCC_HEADERS.some((h) => compiled.startsWith(`[${h}]`))) return { headers: "", brief: compiled };
  const at = compiled.indexOf(VCC_SEPARATOR);
  if (at < 0) return { headers: compiled, brief: "" };
  return { headers: compiled.slice(0, at), brief: compiled.slice(at + VCC_SEPARATOR.length) };
}

export interface ViewInput {
  goal: string;
  status: string;
  entries: Entry[];
  /**
   * Turns the supervisor has already been sent, from turnsSince() after the last view.
   *
   * The supervisor is a real session and keeps every view it has read, so re-sending the whole
   * transcript every time is a second copy of what it already has. This is a person glancing at a
   * screen: they read the new lines, not the scrollback. Past the compaction or a rewind this no
   * longer lines up, and the view says so and sends everything after the compaction.
   */
  since?: number;
  /** Reviews in a row where progressKey did not change. 0 means something changed this time. */
  stale?: number;
  /** Child pi processes still running. A settled worker with one of these is still spending. */
  subagents?: number[];
  /**
   * The worker's model and how full its context is, from the intercom presence record.
   *
   * A supervisor steering a small fast model should give smaller steps than one steering a frontier
   * model, and a worker near the top of its context is about to compact and lose detail.
   */
  model?: string;
}

/** Render the view, and cut it to MAX_VIEW_BYTES so the broker cannot reject it. */
export function buildView({ goal, status, entries, since = 0, stale = 0, subagents = [], model = "" }: ViewInput): string {
  const messages = entries.filter((e) => e.type === "message" && e.message);
  const pending = outstandingWork(messages);
  const workerMessages = messagesSince(entries);
  const total = workerMessages.length;
  // A compaction or a rewind leaves the mark past the end. Restart from the compaction and say so,
  // otherwise the supervisor silently reads a slice of the wrong history.
  const restarted = since > total;
  const from = restarted ? 0 : since;
  const fresh = workerMessages.slice(from);
  const { headers, brief } = vccSections(fresh);
  const earlier = compactionSummary(entries);

  const head = [
    // Short goals are the criterion on every review. A multi-line research rubric is reinserted
    // into the supervisor context at its own cadence, so this view carries only its locator.
    `<goal>`,
    goalPreview(goal),
    `</goal>`,
    ``,
    `# Worker`,
    ...(model ? [`model: ${model}`] : []),
    `status: ${status}`,
    `turns: ${workerMessages.length}`,
    `tool calls with no result: ${pending.length ? pending.join(", ") : "none"}`,
    `child pi processes still running: ${subagents.length ? subagents.join(", ") : "none"}`,
    ...(stale > 0 ? [`no new file or commit for ${stale} reviews in a row`] : []),
    ``,
    // Sent when this view starts at the compaction boundary, which is the first view and every
    // view after the worker compacts. In between the supervisor already has it.
    ...(from === 0 && earlier
      ? [
        restarted ? `# The worker compacted, so this view restarts. Everything before it:` : `# Earlier work, from the worker's own compaction summary`,
        earlier.slice(0, 6000),
        ``,
      ]
      : []),
    ...(headers ? [`# Files, commits and context, from the new turns only`, headers, ``] : []),
    from > 0 ? `# New turns since your last look (${total - from} of ${total})` : `# Turns so far`,
  ].join("\n");

  // Oldest brief lines go first, because the newest turns are what the next instruction rests on.
  let lines = brief.split("\n");
  let view = `${head}\n${lines.join("\n")}\n`;
  while (Buffer.byteLength(view, "utf-8") > MAX_VIEW_BYTES && lines.length > 1) {
    lines = lines.slice(1);
    view = `${head}\n[earlier turns cut to fit the channel]\n${lines.join("\n")}\n`;
  }
  if (Buffer.byteLength(view, "utf-8") <= MAX_VIEW_BYTES) return view;
  // The head alone can overflow, on a long goal. The broker drops anything over
  // 16 KiB and never tells the extension, so the supervisor would go blind. Cut, and say so.
  return `${Buffer.from(view, "utf-8").subarray(0, MAX_VIEW_BYTES - 40).toString("utf-8")}\n[view cut here to fit the channel]\n`;
}
