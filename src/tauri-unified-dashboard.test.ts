import { describe, expect, it } from "vitest";
import { publicView, runtimeView } from "../desktop/src/dashboard-state";
import type { ManagedResult, PublicTunnelHealth } from "../desktop/src/runtime";

const stopped: ManagedResult = {
  available: true, ready: true, running: false,
  tunnelCapable: true, tunnelRunning: false,
  instance: "tauri-preview-v1", port: 18797,
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
  it("does not use the legacy 7979 monitor to decide owned runtime status", () => {
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
