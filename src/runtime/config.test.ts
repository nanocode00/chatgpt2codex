import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getRuntimeSecret,
  listRuntimeSecrets,
  loadRuntimeEnvironment,
  parseRuntimeEnvFile,
  readRuntimeConfig,
  removeRuntimeSecret,
  resolveRuntimeSettings,
  setRuntimeConfigValue,
  setRuntimeSecret,
  settingsFromEnvironment,
  unsetRuntimeConfigValue,
} from "./config.js";

describe("runtime config", () => {
  let root: string;
  let configDir: string;
  let stateDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "chatgpt2codex-config-"));
    configDir = join(root, "config");
    stateDir = join(root, "state");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stores global and instance settings and resolves instance overrides", async () => {
    await setRuntimeConfigValue(configDir, "workspace", "/workspace/default");
    await setRuntimeConfigValue(configDir, "port", "7980");
    await setRuntimeConfigValue(configDir, "port", "7990", "proj");
    await setRuntimeConfigValue(configDir, "tunnel", "cloudflare", "proj");
    const config = await readRuntimeConfig(configDir);

    expect(config.defaults).toEqual({ workspace: "/workspace/default", port: 7980 });
    expect(config.instances.proj).toEqual({ port: 7990, tunnel: "cloudflare" });
    expect(resolveRuntimeSettings(config, "proj", {})).toEqual({
      workspace: "/workspace/default",
      port: 7990,
      tunnel: "cloudflare",
    });

    await unsetRuntimeConfigValue(configDir, "port", "proj");
    expect((await readRuntimeConfig(configDir)).instances.proj).toEqual({ tunnel: "cloudflare" });
  });

  it("uses environment variables as runtime overrides", async () => {
    await setRuntimeConfigValue(configDir, "port", "7980");
    const config = await readRuntimeConfig(configDir);
    const resolved = resolveRuntimeSettings(config, "default", {
      PORT: "8123",
      WORKSPACE: "/env/workspace",
      PUBLIC_HOSTNAME: "c2c.example.com",
      CLOUDFLARED_TUNNEL_NAME: "c2c-prod",
    });

    expect(resolved).toEqual({
      port: 8123,
      workspace: "/env/workspace",
      publicHostname: "c2c.example.com",
      tunnelName: "c2c-prod",
      tunnel: "cloudflare",
    });
  });

  it("extracts known legacy environment settings for migration", () => {
    expect(settingsFromEnvironment({
      WORKSPACE: "/workspace",
      PORT: "7979",
      CHATGPT2CODEX_EXPOSE_WEB: "1",
    })).toEqual({
      workspace: "/workspace",
      port: 7979,
      tunnel: "cloudflare",
    });
  });

  it("parses legacy runtime.env assignments without executing shell syntax", () => {
    expect(parseRuntimeEnvFile([
      "# comment",
      "set -a",
      "export WORKSPACE='/workspace with space'",
      "PORT=7979",
      "CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES='{",
      '  "proj": "/venv/bin/python"',
      "}'",
      "unset CHATGPT2CODEX_ACTIVE_PROJECT_ROOT",
      "EMPTY=",
      "set +a",
    ].join("\n"))).toEqual({
      values: {
        WORKSPACE: "/workspace with space",
        PORT: "7979",
        CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES: '{\n  "proj": "/venv/bin/python"\n}',
        EMPTY: "",
      },
      unset: ["CHATGPT2CODEX_ACTIVE_PROJECT_ROOT"],
    });
    expect(() => parseRuntimeEnvFile("source ~/.profile")).toThrow(/shell commands are not executed/);
  });

  it("loads runtime.env below the current process environment", async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "runtime.env"),
      "PORT=7000\nWORKSPACE=/legacy\nunset CHATGPT2CODEX_ACTIVE_PROJECT_ROOT\n",
      "utf8",
    );
    const loaded = await loadRuntimeEnvironment(configDir, {
      PORT: "8000",
      CHATGPT2CODEX_ACTIVE_PROJECT_ROOT: "/stale",
    });
    expect(loaded.loaded).toEqual(["PORT", "WORKSPACE"]);
    expect(loaded.unset).toEqual(["CHATGPT2CODEX_ACTIVE_PROJECT_ROOT"]);
    expect(loaded.env.PORT).toBe("8000");
    expect(loaded.env.WORKSPACE).toBe("/legacy");
    expect(loaded.env.CHATGPT2CODEX_ACTIVE_PROJECT_ROOT).toBeUndefined();
  });

  it("stores secrets separately without exposing values when listing", async () => {
    await setRuntimeSecret(stateDir, "cloudflare-token", "super-secret");
    expect(await getRuntimeSecret(stateDir, "cloudflare-token")).toBe("super-secret");
    expect(await listRuntimeSecrets(stateDir)).toEqual(["cloudflare-token"]);

    const secretFile = join(stateDir, "secrets", "runtime.json");
    expect((await stat(secretFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(secretFile, "utf8")).toContain("super-secret");

    expect(await removeRuntimeSecret(stateDir, "cloudflare-token")).toBe(true);
    expect(await getRuntimeSecret(stateDir, "cloudflare-token")).toBeUndefined();
  });
});
