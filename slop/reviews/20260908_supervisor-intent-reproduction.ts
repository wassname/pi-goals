import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMailbox, supervisorReady, writeWorkerView } from "../../src/mailbox.js";
import { registerVisibleSupervisor } from "../../src/supervisor-session.js";
import { workerView } from "../../src/worker-view.js";

const cwd = mkdtempSync(join(tmpdir(), "goals-intent-review-"));
const plan = join(cwd, "plan.md");
const mailbox = createMailbox(cwd, "worker", "approval", plan);
Object.assign(process.env, {
  PI_GOALS_WORKER_ID: "worker", PI_GOALS_OWNER_SESSION_ID: "worker",
  PI_GOALS_PLAN_PATH: plan, PI_GOALS_APPROVAL_ID: "approval", PI_GOALS_MAILBOX_PATH: mailbox.path,
});
const entries: any[] = [];
function runtime() {
  const hooks = new Map();
  const tools = new Map();
  const messages: string[] = [];
  let activeTools = ["read", "write", "bash"];
  const pi = {
    on: (name: string, handler: any) => hooks.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    sendUserMessage: (text: string) => {
      messages.push(text);
      entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
    },
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => { activeTools = tools; },
  };
  const ctx = {
    getContextUsage: () => ({ tokens: 10 }),
    sessionManager: { getEntries: () => entries },
    ui: { notify: (message: string) => { throw new Error(message); } },
  };
  registerVisibleSupervisor(pi as any);
  return { hooks, tools, messages, ctx, activeTools: () => activeTools };
}
try {
  writeWorkerView(mailbox, "settled", "The worker stopped.\n\nA fresh result awaits review.");
  for (const name of ["fresh", "resumed"]) {
    const run = runtime();
    try {
      await run.hooks.get("session_start")({}, run.ctx);
      await new Promise(setImmediate);
      console.log(`${name}: deliveredViews=${run.messages.length}, activeTools=${run.activeTools().join(",")}, readyReceipt=${supervisorReady(mailbox.path)}`);
      assert.equal(run.messages.length, name === "fresh" ? 1 : 0);
      assert.deepEqual(run.activeTools(), ["read"]);
      if (name === "fresh") {
        const tool = run.tools.get("SteerWorker");
        const result = await tool.execute("id", { instruction: "Compare the signs in the two saved outputs." });
        assert.equal(typeof tool.renderCall, "function");
        console.log(`steer: renderCall=${typeof tool.renderCall}, result=${result.content[0].text}`);
      }
    } finally {
      await run.hooks.get("session_shutdown")();
    }
  }
  const idleView = workerView([], "interval", true).split("\n")[0];
  assert.equal(idleView, "The worker stopped.");
  console.log(`interval view without any work: ${idleView}`);
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
