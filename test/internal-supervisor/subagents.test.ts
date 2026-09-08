import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { childPiProcesses } from "../../src/internal/supervisor/subagents.js";

/**
 * Runs the real ps command against a real child process, because the parsing is the part most
 * likely to be quietly wrong: a column order or a comm name that differs by platform reads as
 * "no subagents", which is the answer that lets the supervisor declare a busy worker finished.
 */
function spawnChildNamedPi() {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-test-"));
  const fake = join(dir, "pi");
  copyFileSync("/usr/bin/sleep", fake); // ps reports comm from the executable name
  return spawn(fake, ["30"], { stdio: "ignore" });
}

test("a child process named pi is found by ps, and stops being found when it exits", async (t) => {
  if (process.platform !== "linux" && process.platform !== "darwin") return t.skip("ps only");
  assert.deepEqual(await childPiProcesses(), [], "no subagents before one is started");

  const child = spawnChildNamedPi();
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(await childPiProcesses(), [child.pid], "the running child must be reported");

  child.kill();
  await new Promise((r) => child.once("exit", r));
  assert.deepEqual(await childPiProcesses(), [], "and not reported once it exits");
});

test("the check is a snapshot, so it cannot hold up the worker's settle", async (t) => {
  if (process.platform !== "linux" && process.platform !== "darwin") return t.skip("ps only");
  const child = spawnChildNamedPi();
  await new Promise((r) => setTimeout(r, 300));

  const started = Date.now();
  assert.deepEqual(await childPiProcesses(), [child.pid]);
  assert.ok(Date.now() - started < 1000, "it returns while the child is still running, it does not wait");
  child.kill();
});
