import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface PackageManifest {
	files: string[];
	pi: { extensions: string[]; subagents?: unknown };
}

describe("package manifest", () => {
	it("includes the extension without registering a packaged subagent", () => {
		const root = resolve(import.meta.dirname, "..");
		const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as PackageManifest;
		expect(manifest.files).toEqual(["src", "prototype", "README.md"]);
		expect(manifest.pi.extensions).toEqual(["./src/prototype.ts"]);
		expect(manifest.private).toBe(true);
		expect(manifest.pi.subagents).toBeUndefined();
	});
});
