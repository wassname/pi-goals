import { expect, it } from "vitest";
import { workerView } from "../src/worker-view.js";

const context = { sourceSession: "/sessions/worker.jsonl", latestDirection: "Modal uses a remote GPU.", model: "provider/worker", background: "processes: 0; subagents: 0" };
const entry = (id: string, text: string) => ({ id, type: "message", message: { role: "assistant", content: text } });

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
	], "interval", true, { ...context, latestDirection: "Remote only. ".repeat(3000) });
	expect(Buffer.byteLength(JSON.stringify({ binding: "binding", role: "worker", kind: "view", id: "id", text: view }))).toBeLessThan(16_000);
	expect(view).toContain("[truncated; inspect source session]");
	expect(view).toContain(context.sourceSession);
});
