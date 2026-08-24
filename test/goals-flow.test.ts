import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import piGoalsExtension from "../src/index.js";

function setup(selectChoices: Array<string | undefined>) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-goals-flow-"));
	const commands = new Map<string, any>();
	const hooks = new Map<string, any>();
	const events: string[] = [];
	const messages: Array<{ content: string; display?: boolean }> = [];
	const ctx = {
		cwd,
		hasUI: true,
		sessionManager: { getSessionId: () => "session-a", getEntries: () => [] },
		ui: {
			theme: { fg: (_kind: string, text: string) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			select: async () => {
				events.push("select");
				return selectChoices.shift();
			},
		},
	};
	const pi = {
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (name: string, handler: any) => hooks.set(name, handler),
		appendEntry: () => {},
		registerTool: () => {},
		sendMessage: (message: { content: string; display?: boolean }) => {
			events.push("display");
			messages.push(message);
		},
		sendUserMessage: (message: string) => messages.push({ content: message }),
	};
	piGoalsExtension(pi as unknown as ExtensionAPI);
	return { commands, ctx, cwd, events, hooks, messages };
}

describe("/goals draft flow", () => {
	it("creates a new version, preserves the prior draft, displays the full plan before Ready, and keeps Grill me in plan mode", async () => {
		const flow = setup(["Grill me — ask one question that tests your plan understanding"]);
		try {
			const legacy = join(flow.cwd, ".pi/plan/session-a.md");
			mkdirSync(join(flow.cwd, ".pi/plan"), { recursive: true });
			writeFileSync(legacy, "old plan");
			await flow.commands.get("goals").handler("first objective", flow.ctx);
			const v1 = join(flow.cwd, ".pi/plan/session-a-v1.md");
			expect(readFileSync(v1, "utf-8")).toBe("");
			expect(readFileSync(legacy, "utf-8")).toBe("old plan");
			const plan = "# First plan\n\n## Goals\n\n1. [ ] goal: preserve this\n\n## Appendix (context, not approved)\nold context\n";
			mkdirSync(join(flow.cwd, ".pi/plan"), { recursive: true });
			writeFileSync(v1, plan);

			await flow.hooks.get("agent_end")({}, flow.ctx);
			expect(flow.events).toEqual(["display", "select"]);
			expect(flow.messages.at(-1)?.content).toContain("Ask the human the single most useful question");
			expect(flow.messages.find((message) => message.display)?.content).toBe(plan);
			await flow.hooks.get("agent_end")({}, flow.ctx);
			expect(flow.events).toEqual(["display", "select"]);
			const blocked = await flow.hooks.get("tool_call")({ toolName: "edit", input: { path: "README.md" } }, flow.ctx);
			expect(blocked?.block).toBe(true);

			await flow.commands.get("goals").handler("second objective", flow.ctx);
			expect(readFileSync(v1, "utf-8")).toBe(plan);
			expect(readFileSync(join(flow.cwd, ".pi/plan/session-a-v2.md"), "utf-8")).toBe("");
			expect(flow.messages.at(-1)?.content).toContain("session-a-v2.md");

			await flow.commands.get("goals").handler("judge the vendor options", flow.ctx);
			expect(readFileSync(join(flow.cwd, ".pi/plan/session-a-v3.md"), "utf-8")).toBe("");
			expect(flow.messages.at(-1)?.content).toContain("Objective: judge the vendor options");
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});
});
