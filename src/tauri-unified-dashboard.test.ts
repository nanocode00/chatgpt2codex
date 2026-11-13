import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { publicView, runtimeView, startAction, storedPublicPreference } from "../desktop/src/dashboard-state";
import type { ManagedResult, PublicTunnelHealth } from "../desktop/src/runtime";

const stopped: ManagedResult = {
  available: true, ready: true, running: false,
  tunnelCapable: true, tunnelRunning: false,
  instance: "tauri-preview-v1", port: 7979,
  details: "ready"
};
const publicRunning: ManagedResult = {
  ...stopped, running: true, tunnelRunning: true,
  publicConnector: "https://current.example.com/mcp"
};
const checked: PublicTunnelHealth = {
  state: "online",
  endpoint: "https://current.example.com/healthz",
  details: "HTTPS healthy"
};

describe("first unified dashboard: owned runtime only", () => {
  it("switches card columns by usable dashboard width instead of the window viewport", () => {
    const css = readFileSync("desktop/src/dashboard.css", "utf8");
    expect(css).toContain("container-name:dashboard");
    expect(css).toContain("container-type:inline-size");
    expect(css).toContain("@container dashboard (max-width:900px)");
    expect(css).toContain("@container dashboard (max-width:620px)");
    expect(css).toContain("word-break:keep-all");
    expect(css).not.toMatch(/@media\(max-width:1050px\)\{\.dash-status-grid/);
  });

  it("keeps the stopped-state public preference distinct from a live tunnel", () => {
    expect(storedPublicPreference(null)).toBe(false);
    expect(storedPublicPreference("false")).toBe(false);
    expect(storedPublicPreference("true")).toBe(true);
    expect(storedPublicPreference("unexpected")).toBe(false);
    expect(startAction(false)).toBe("start");
    expect(startAction(true)).toBe("start-public");
  });
  it("uses the app-owned status rather than a separate monitoring port", () => {
    expect(runtimeView(false, publicRunning)).toBe("unsupported");
    expect(runtimeView(true, null)).toBe("checking");
    expect(runtimeView(true, { ...stopped, available: false })).toBe("unavailable");
    expect(runtimeView(true, { ...stopped, ready: false })).toBe("setup");
    expect(runtimeView(true, stopped)).toBe("stopped");
    expect(runtimeView(true, { ...stopped, running: true })).toBe("online");
  });

  it("does not claim public connectivity from a running tunnel alone", () => {
    expect(publicView(publicRunning, null)).toBe("unchecked");
    expect(publicView(publicRunning, checked)).toBe("online");
    expect(publicView(publicRunning, { ...checked, state: "offline" })).toBe("offline");
    expect(publicView(publicRunning, { ...checked, state: "unavailable" })).toBe("unavailable");
    expect(publicView(stopped, checked)).toBe("inactive");
  });

  it("refuses to reuse a successful health check from a previous tunnel", () => {
    expect(publicView(publicRunning, { ...checked, endpoint: "https://old.example.com/healthz" })).toBe("unchecked");
    expect(publicView(publicRunning, { ...checked, endpoint: "http://current.example.com/healthz" })).toBe("unchecked");
    expect(publicView(publicRunning, { ...checked, endpoint: null })).toBe("unchecked");
  });
});
