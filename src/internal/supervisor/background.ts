import { randomUUID } from "node:crypto";

export interface BackgroundState { quiet: boolean; description: string }

/** Public process-local protocols only. Missing owners remain explicitly unknown. */
export async function backgroundState(pi: any): Promise<BackgroundState> {
  let processes: unknown;
  pi.events.emit("processes:request:list", { reply: (value: unknown) => { processes = value; } });
  const rows = Array.isArray(processes) ? processes : null;
  const processKnown = rows?.every(p => p && ["running", "terminating", "terminate_timeout", "exited", "killed"].includes(p.status));
  const activeProcesses = processKnown ? rows!.filter(p => !["exited", "killed"].includes(p.status)).length : null;
  let activeSubagents: number | null = null;
  if (pi.getAllTools?.().some((tool: any) => tool.name === "subagent")) {
    const requestId = randomUUID();
    activeSubagents = await new Promise<number | null>(resolve => {
      let unsubscribe: unknown;
      const finish = (value: number | null) => { clearTimeout(timer); if (typeof unsubscribe === "function") unsubscribe(); resolve(value); };
      const timer = setTimeout(() => finish(null), 2_000);
      unsubscribe = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (reply: any) => {
        if (reply?.requestId !== requestId) return;
        const count = reply?.success && reply?.data?.fleet?.version === 1 ? reply.data.fleet.totalActive : undefined;
        finish(Number.isSafeInteger(count) && count >= 0 ? count : null);
      });
      pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "status", params: {}, source: { extension: "pi-supervise" } });
    });
  }
  return {
    quiet: activeProcesses === 0 && activeSubagents === 0,
    description: `processes: ${activeProcesses ?? "unknown (provider unavailable)"}; subagents: ${activeSubagents ?? "unknown (provider unavailable)"}; unregistered detached work is not tracked`,
  };
}
