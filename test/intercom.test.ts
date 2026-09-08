import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadBundledIntercom } from "../src/intercom.js";

const factory = vi.hoisted(() => vi.fn());
vi.mock("pi-intercom", () => ({ default: factory }));
beforeEach(() => { factory.mockReset(); });
describe("loadBundledIntercom", () => {
 it("composes the fallback once and explicitly starts its public lifecycle", async () => {
   const on = vi.fn(); const start = vi.fn(); const shutdown = vi.fn(); const registerTool = vi.fn();
   factory.mockImplementation((pi: ExtensionAPI) => { pi.on("session_start", start); pi.on("session_shutdown", shutdown); pi.registerTool({ name: "intercom" } as any); });
   const pi = { on, registerTool, getAllTools: () => [] } as unknown as ExtensionAPI;
   const event = { type: "session_start", reason: "startup" } as SessionStartEvent;
   const ctx = {} as ExtensionContext;
   await loadBundledIntercom(pi, event, ctx);
   expect(factory).toHaveBeenCalledOnce(); expect(start).toHaveBeenCalledExactlyOnceWith(event, ctx);
   expect(on).toHaveBeenCalledExactlyOnceWith("session_shutdown", shutdown);
   expect(registerTool).toHaveBeenCalledExactlyOnceWith({ name: "intercom" });
 });
 it("never loads a second copy when an installed Intercom cannot supply the required channel", async () => {
   const pi = { getAllTools: () => [{ name: "intercom" }] } as unknown as ExtensionAPI;
   await expect(loadBundledIntercom(pi, {} as SessionStartEvent, {} as ExtensionContext)).rejects.toThrow("no second Intercom was loaded");
   expect(factory).not.toHaveBeenCalled();
 });
});
