import { describe, expect, it, vi } from "vitest";
import type { RuntimeInstanceRecord } from "./instances.js";
import {
  reloadRunningRuntimeCatalogs,
  signalRuntimeCatalogReload,
} from "./live-reload.js";

function record(name: string, pid: number): RuntimeInstanceRecord {
  return {
    version: 1,
    name,
    pid,
    entrypoint: "/opt/c2c/dist/cli.js",
    workspace: "/tmp/workspace",
    host: "127.0.0.1",
    port: 7979,
    publicUrl: "http://127.0.0.1:7979",
    startedAt: 1,
  };
}

describe("runtime catalog live reload", () => {
  it("signals a verified live Linux runtime", async () => {
    const signal = vi.fn();
    const target = record("alpha", 111);
    await signalRuntimeCatalogReload(target, {
      platform: "linux",
      processAlive: () => true,
      processMatches: async () => true,
      signal,
    });
    expect(signal).toHaveBeenCalledWith(111, "SIGHUP");
  });

  it("preserves manual reload safety checks", async () => {
    const target = record("alpha", 111);
    await expect(signalRuntimeCatalogReload(target, {
      platform: "linux",
      processAlive: () => false,
      processMatches: async () => true,
      signal: vi.fn(),
    })).rejects.toThrow("instance is not running");

    await expect(signalRuntimeCatalogReload(target, {
      platform: "linux",
      processAlive: () => true,
      processMatches: async () => false,
      signal: vi.fn(),
    })).rejects.toThrow("recorded pid could not be verified");

    await expect(signalRuntimeCatalogReload(target, {
      platform: "win32",
    })).rejects.toThrow("requires Linux/WSL");
  });

  it("reloads every verified running instance and skips stale records", async () => {
    const a = record("alpha", 101);
    const b = record("beta", 202);
    const stale = record("stale", 303);
    const signal = vi.fn();
    const result = await reloadRunningRuntimeCatalogs("/state", {
      platform: "linux",
      listInstances: async () => [a, b, stale],
      processAlive: (pid) => pid !== 303,
      processMatches: async () => true,
      signal,
    });

    expect(result).toEqual({
      supported: true,
      restartRequired: false,
      reloaded: ["alpha", "beta"],
      notRunning: ["stale"],
      failed: [],
    });
    expect(signal.mock.calls).toEqual([[101, "SIGHUP"], [202, "SIGHUP"]]);
  });

  it("continues other instances and reports partial reload failures", async () => {
    const a = record("alpha", 101);
    const b = record("beta", 202);
    const c = record("gamma", 303);
    const signal = vi.fn((pid: number) => {
      if (pid === 303) throw new Error("signal denied");
    });
    const result = await reloadRunningRuntimeCatalogs("/state", {
      platform: "linux",
      listInstances: async () => [a, b, c],
      processAlive: () => true,
      processMatches: async (item) => item.name !== "beta",
      signal,
    });

    expect(result.reloaded).toEqual(["alpha"]);
    expect(result.failed).toEqual([
      {
        instance: "beta",
        pid: 202,
        error: "refusing reload because the recorded pid could not be verified as this c2c instance",
      },
      { instance: "gamma", pid: 303, error: "signal denied" },
    ]);
    expect(signal.mock.calls).toEqual([[101, "SIGHUP"], [303, "SIGHUP"]]);
  });

  it("returns restart-required without inspecting runtime records on non-Linux platforms", async () => {
    const listInstances = vi.fn(async () => [record("alpha", 101)]);
    const result = await reloadRunningRuntimeCatalogs("/state", {
      platform: "darwin",
      listInstances,
    });
    expect(result).toEqual({
      supported: false,
      restartRequired: true,
      reloaded: [],
      notRunning: [],
      failed: [],
    });
    expect(listInstances).not.toHaveBeenCalled();
  });
});
