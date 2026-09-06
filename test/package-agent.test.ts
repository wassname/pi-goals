import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface PackageManifest {
	files: string[];
	pi: { extensions: string[]; subagents: { agents: string[] } };
}

describe("package manifest", () => {
	it("includes the versioned foreground worker for child-process discovery", () => {
		const root = resolve(import.meta.dirname, "..");
		const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as PackageManifest;
		const worker = readFileSync(resolve(root, "agents/pi-goals-worker-v1.md"), "utf8");
		expect(manifest.files).toEqual(["src", "agents", "README.md"]);
		expect(manifest.pi.extensions).toEqual(["./src/index.ts"]);
		expect(manifest.pi.subagents.agents).toEqual(["./agents"]);
		expect(worker).toContain("name: pi-goals-worker-v1");
		expect(worker).toContain("async: false");
		expect(worker).toContain("tools: read, grep, find, ls, bash, edit, write");
		expect(worker).toContain("excludeTools: contact_supervisor, subagent");
	});
});
