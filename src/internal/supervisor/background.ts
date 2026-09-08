import { randomUUID } from "node:crypto";

export interface BackgroundState { quiet: boolean; description: string }

/** Optional trackers are queried afresh. Absent tools mean no tracked work; an installed
 * tracker that cannot report stays unknown. Detached/unregistered work is not OS-wide idleness. */
export async function backgroundState(pi: any): Promise<BackgroundState> {
  const tools = pi.getAllTools();
  const hasProcesses = tools.some((tool: any) => tool.name === "process");
  const hasSubagents = tools.some((tool: any) => tool.name === "subagent");
  let processes: unknown;
  pi.events.emit("processes:request:list", { reply: (value: unknown) => { processes = value; } });
  const rows = Array.isArray(processes) ? processes : !hasProcesses && processes === undefined ? [] : null;
  const processKnown = rows?.every(p => p && ["running", "terminating", "terminate_timeout", "exited", "killed"].includes(p.status));
  const activeProcesses = processKnown ? rows!.filter(p => !["exited", "killed"].includes(p.status)).length : null;
  let activeSubagents: number | null = hasSubagents ? null : 0;
  if (hasSubagents) {
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
