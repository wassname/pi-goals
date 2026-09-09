import { expect, it } from "vitest";
import { type SupervisorReviewReason, supervisorPeriodicReview, supervisorPlanChangeReview, supervisorReadyReview, supervisorStartedReview, supervisorStoppedReview } from "../src/prompts.js";
import { workerView } from "../src/worker-view.js";

const context = { sourceSession: "/sessions/worker.jsonl", latestDirection: "Modal uses a remote GPU.", model: "provider/worker", background: "processes: 0; subagents: 0" };
const entry = (id: string, text: string) => ({ id, type: "message", message: { role: "assistant", content: text } });

it.each<[SupervisorReviewReason, boolean, string, string]>([
	["ready", true, "The worker is ready to begin.", supervisorReadyReview],
	["started", false, "The worker is still working.", supervisorStartedReview],
	["turns", false, "The worker is still working.", supervisorPeriodicReview],
	["interval", false, "The worker is still working.", supervisorPeriodicReview],
	["settled", true, "The worker stopped.", supervisorStoppedReview],
	["interval", true, "The worker stopped.", supervisorStoppedReview],
	["settled", false, "The worker is still working.", supervisorPeriodicReview],
	["plan", true, "The worker stopped.", supervisorStoppedReview],
	["plan", false, "The worker is still working.", supervisorPeriodicReview],
])("wires %s (idle=%s) to its review task without changing status prefixes", (reason, idle, prefix, task) => {
	const view = workerView([entry("claim", "The plot is complete but the result does not beat random.")], reason, idle, context);
	expect(view.startsWith(`${prefix}\n\n`)).toBe(true);
	expect(view).toContain(task);
	expect(view).toContain(`review trigger: ${reason}`);
	if (reason === "plan") expect(view).toContain(supervisorPlanChangeReview);
	if (!idle) expect(view).not.toContain(supervisorStoppedReview);
});

it("keeps human direction and source location while sending only new messages", () => {
	const view = workerView([entry("old", "old detail"), entry("new", "new result")], "interval", true, { ...context, since: "old" });
	expect(view).toContain(context.latestDirection);
	expect(view).toContain(context.sourceSession);
	expect(view).toContain("new result");
	expect(view).not.toContain("old detail");
});

it("restarts after compaction and does not report historical tool calls as active", () => {
	const entries = [
		{ id: "old", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "edit" }] } },
		{ id: "compact", type: "compaction", summary: "Saved worker account." },
		entry("new", "new result"),
	];
	const initial = workerView(entries, "interval", true, { ...context, since: "old" });
	expect(initial).toContain("Saved worker account.");
	expect(initial).toContain("tool calls with no result: none");
	const next = workerView(entries, "interval", true, { ...context, since: "new" });
	expect(next).not.toContain("Saved worker account.");
	expect(next).toContain("No new messages.");
});

it("bounds serialized Unicode and quoted logs while marking omissions", () => {
	const view = workerView([
		{ id: "compact", type: "compaction", summary: '"\\🧪'.repeat(20_000) },
		entry("new", '"\\🧪'.repeat(20_000)),
	], "interval", true, { ...context, latestDirection: "Remote only. ".repeat(3000), planReview: '"\\🧪'.repeat(20_000) });
	expect(Buffer.byteLength(JSON.stringify({ binding: "binding", role: "worker", kind: "view", id: "id", text: view }))).toBeLessThan(16_000);
	expect(view).toContain("[truncated; inspect source session]");
	expect(view).toContain(context.sourceSession);
});

it("keeps two recent thinking tails beside their actions without mutating the branch", () => {
	const entries = ["old", "middle", "new"].map(id => ({ id, type: "message", message: { role: "assistant", content: [
		{ type: "thinking", thinking: `${id} discarded head ${"padding ".repeat(100)}${id} decisive tail` },
		{ type: "toolCall", id, name: "bash", arguments: { command: `verify-${id}` } },
	] } }));
	const before = structuredClone(entries);
	const view = workerView(entries, "turns", false, context);
	expect(view).not.toContain("old decisive tail");
	expect(view).not.toContain("discarded head");
	expect(view).toContain("middle decisive tail");
	expect(view).toContain("new decisive tail");
	expect(view.indexOf("middle decisive tail")).toBeLessThan(view.indexOf("verify-middle"));
	expect(view.indexOf("verify-middle")).toBeLessThan(view.indexOf("new decisive tail"));
	expect(view.indexOf("new decisive tail")).toBeLessThan(view.indexOf("verify-new"));
	expect(entries).toEqual(before);
});

it("extracts files and blockers, retaining tool arguments instead of verbose result bodies", () => {
	const entries = [
		entry("claim", "Cannot finish because the fixture is broken."),
		{ id: "write", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "write", arguments: { path: "result.txt", content: "artifact" } }] } },
		{ id: "result", type: "message", message: { role: "toolResult", toolName: "write", toolCallId: "call", content: "verbose-result-body".repeat(1000) } },
	];
	const view = workerView(entries, "settled", true, { ...context, contextPercent: 42, planReview: "goal: [/] -> [x], manual claim" });
	expect(view).toContain("[Files And Changes]");
	expect(view).toContain("Modified: result.txt");
	expect(view).toContain("[Outstanding Context]");
	expect(view).toContain("fixture is broken");
	expect(view).toContain('write "result.txt"');
	expect(view).toContain("tool calls with no result: none");
	expect(view).toContain(context.background);
	expect(view).toContain("context used: 42%");
	expect(view).toContain("goal: [/] -> [x], manual claim");
	expect(view).not.toContain("verbose-result-body");
	expect(view).toContain("tool-result bodies omitted; inspect source for evidence");
	expect(view).not.toContain("vcc_recall");
});

it("preserves unanswered partial calls across the acknowledged boundary", () => {
	const entries = [{ id: "call", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "pending", name: "edit" }] } }];
	expect(workerView(entries, "turns", false, context)).toContain("tool calls with no result: edit");
	const view = workerView(entries, "turns", false, { ...context, since: "call" });
	expect(view).toContain("tool calls with no result: edit");
	expect(view).toContain("No new messages.");
});

it("restarts a rewound branch and keeps fresh headerless text after compaction", () => {
	const view = workerView([
		{ id: "compaction", type: "compaction", summary: "Prior worker account." }, entry("fresh", "Fresh decisive result."),
	], "settled", true, { ...context, since: "entry-on-discarded-branch", contextPercent: null });
	expect(view).toContain("initial or reset view");
	expect(view).toContain("Prior worker account.");
	expect(view).toContain("Fresh decisive result.");
	expect(view).not.toContain("context used:");
});

it("protects VCC headers and newest actions when the compacted brief exceeds its budget", () => {
	const entries = [
		{ id: "write", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "write", arguments: { path: "important.txt", content: "artifact" } }] } },
		...Array.from({ length: 150 }, (_, i) => entry(`entry-${i}`, `Action ${i}: ${"details ".repeat(80)}`)),
		entry("last", "Newest decisive observation."),
	];
	const view = workerView(entries, "turns", false, context);
	expect(view).toContain("[Files And Changes]");
	expect(view).toContain("important.txt");
	expect(view).toContain("Newest decisive observation.");
	expect(view).toContain("[truncated; inspect source session]");
	expect(Buffer.byteLength(JSON.stringify({ text: view }))).toBeLessThan(16_000);
});

it("distinguishes omitted result-only updates from no messages and extracts paired commit evidence", () => {
	const result = (content: string) => [{ id: "result", type: "message", message: { role: "toolResult", toolName: "bash", toolCallId: "done", content } }];
	const omitted = workerView(result("large diagnostic output"), "settled", true, context);
	expect(omitted).toContain("No overview text retained from these messages.");
	expect(omitted).not.toContain("No new messages.");
	const commit = workerView([
		{ id: "commit", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "done", name: "bash", arguments: { command: 'git commit -m "Save verified artifact"' } }] } },
		...result("[main abc1234] Save verified artifact"),
	], "settled", true, context);
	expect(commit).toContain("[Commits]");
	expect(commit).toContain("abc1234");
	expect(commit).not.toContain("vcc_recall");
});
