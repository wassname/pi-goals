import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("declares current entry and bundled extension resources that exist after install", () => {
	const manifest = JSON.parse(readFileSync("package.json", "utf8"));
	expect(manifest.pi.extensions[0]).toBe("./src/index.ts");
	for (const path of manifest.pi.extensions) expect(existsSync(resolve(path)), path).toBe(true);
	for (const name of ["pi-subagents", "pi-intercom", "pi-schedule-prompt"]) {
		expect(manifest.dependencies[name]).toBeTruthy();
		expect(manifest.bundledDependencies).toContain(name);
	}
	expect(manifest.dependencies["pi-subagents"]).toContain("953c6f6d2fc7d8a5c956c30cd77c51bad697c2a4");
	expect(existsSync("agents/goals-worker.md")).toBe(true);
});
