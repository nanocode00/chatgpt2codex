import { describe, expect, it } from "vitest";
import { deferPublicHealthOnStart, publicHealthAtStart } from "./public-start-health-policy.js";

describe("Tauri-only deferred public HTTPS startup check", () => {
  it("retains blocking public health verification by default", () => {
    expect(deferPublicHealthOnStart({}, "default", "cloudflare")).toBe(false);
    expect(deferPublicHealthOnStart({}, "tauri-preview-v1", "cloudflare")).toBe(false);
    expect(deferPublicHealthOnStart({}, "tauri-preview-v1", "none")).toBe(false);
  });

  it("only accepts the explicit isolated preview cloudflare opt-in", () => {
    expect(deferPublicHealthOnStart({ "defer-public-health": true }, "tauri-preview-v1", "cloudflare")).toBe(true);
    for (const [instance, tunnel] of [
      ["default", "cloudflare"], ["some-other-instance", "cloudflare"],
      ["tauri-preview-v1", "none"],
    ]) {
      expect(() => deferPublicHealthOnStart({ "defer-public-health": true }, instance!, tunnel!)).toThrow();
    }
    for (const invalid of ["true", "false", false, "1", ""]) {
      expect(() => deferPublicHealthOnStart({ "defer-public-health": invalid }, "tauri-preview-v1", "cloudflare")).toThrow();
    }
  });

  it("does not block preview startup on a pending HTTPS probe or falsely report success", async () => {
    let checked = false;
    const slowProbe = async () => { checked = true; return new Promise<boolean>(() => {}); };
    expect(await publicHealthAtStart("cloudflare", true, "https://example.invalid", slowProbe)).toBeNull();
    expect(checked).toBe(false);
    expect(await publicHealthAtStart("none", false, "http://127.0.0.1", slowProbe)).toBeNull();
    expect(checked).toBe(false);
  });

  it("preserves default CLI public health checks and their actual result", async () => {
    const seen: string[] = [];
    const probe = async (url: string) => { seen.push(url); return false; };
    const origin = "https://unreachable.trycloudflare.com";
    expect(await publicHealthAtStart("cloudflare", false, origin, probe)).toBe(false);
    expect(seen).toEqual([origin]);
  });
});
