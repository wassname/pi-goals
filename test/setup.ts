import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";

let agentDir: string;
beforeEach(() => { agentDir = mkdtempSync(join(tmpdir(), "goals-model-prefs-")); vi.stubEnv("PI_CODING_AGENT_DIR", agentDir); });
afterEach(() => { rmSync(agentDir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
