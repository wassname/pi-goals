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
		expect(manifest.files).toEqual(["src", "README.md"]);
		expect(manifest.pi.extensions).toEqual(["./src/index.ts"]);
		expect(manifest.pi.subagents).toBeUndefined();
	});
});
