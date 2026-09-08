import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { goalBlock, hashGoalBlock, repositoryState } from "../src/approval.js";

it("fingerprints literal unusual paths, binary bytes, symlink targets, modes and deletions", () => {
	const cwd = mkdtempSync(join(tmpdir(), "goals-fingerprint-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd });
	try {
		git("init", "-q");
		writeFileSync(join(cwd, "tracked"), "original"); git("add", ".");
		git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "base");
		const path = " white space\nname ";
		writeFileSync(join(cwd, path), Buffer.from([0, 255, 42]));
		symlinkSync("absent target", join(cwd, "link"));
		const first = repositoryState(cwd, true).worktree!;
		expect(first.files.map(file => file.path)).toContain(path);
		expect(first.files.find(file => file.path === "link")?.kind).toBe("symlink");
		writeFileSync(join(cwd, path), Buffer.from([0, 254, 42]));
		const changed = repositoryState(cwd, true).worktree!;
		expect(changed.status).toBe(first.status);
		expect(changed.files).not.toEqual(first.files);
		chmodSync(join(cwd, path), 0o700);
		expect(repositoryState(cwd, true).worktree?.files).not.toEqual(changed.files);
		rmSync(join(cwd, "link")); symlinkSync("other target", join(cwd, "link"));
		expect(repositoryState(cwd, true).worktree?.files.find(file => file.path === "link")?.contentHash).not.toBe(first.files.find(file => file.path === "link")?.contentHash);
		rmSync(join(cwd, "tracked"));
		expect(repositoryState(cwd, true).worktree?.files).toContainEqual({ path: "tracked", kind: "missing" });
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

it("hashes only the current goal, excluding the log, interview, and their historical goal text", () => {
	const goal = "1. [ ] goal: output\n  - evidence: output.txt\n";
	const before = `${goal}\n## Log\n- first entry\n`;
	const after = `${goal}\n## Log\n- later entry\n\n${goal}\n## Interview\n> new notes\n`;
	expect(goalBlock(before, "output")).toBe(goal.trimEnd());
	expect(hashGoalBlock(goalBlock(before, "output")!)).toBe(hashGoalBlock(goalBlock(after, "output")!));
	expect(goalBlock(`${goal}\n## Interview\n> notes`, "output")).toBe(goal.trimEnd());
	expect(goalBlock(`${goal}2. [ ] goal: second\n  - evidence: second.txt`, "output")).toBe(goal.trimEnd());
	expect(hashGoalBlock(goalBlock(before.replace("output.txt", "changed.txt"), "output")!)).not.toBe(hashGoalBlock(goalBlock(before, "output")!));
});
