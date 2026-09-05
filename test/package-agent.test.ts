import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface PackageManifest {
	files: string[];
	pi: { subagents: { agents: string[] } };
}

describe("packaged goal worker", () => {
	it("exposes goal-worker through pi-subagents package discovery", () => {
		const root = resolve(import.meta.dirname, "..");
		const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as PackageManifest;
		expect(manifest.files).toContain("agents");
		expect(manifest.pi.subagents.agents).toEqual(["./agents"]);

		const definition = readFileSync(resolve(root, "agents", "goal-worker.md"), "utf8");
		expect(definition).toMatch(/^---\nname: goal-worker\n/);
		expect(definition).toContain("tools: read, grep, find, ls, bash, edit, write, contact_supervisor");
		expect(definition).toContain("defaultContext: fork");
		expect(definition).toContain("retained implementation worker");
	});
});
