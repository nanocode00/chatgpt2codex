import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  DOCKER_LOG_MAX_LINES,
  DOCKER_OUTPUT_MAX_BYTES,
  DOCKER_PROFILES_ENV,
  DOCKER_STOP_TIMEOUT_SECONDS,
  TRUSTED_LOCAL_DOCKER_HOST,
  dockerLogs,
  dockerStart,
  dockerStatus,
  dockerStop,
  listDockerProfiles,
  setDockerExecForTests,
} from "./docker.js";

const originalProfiles = process.env[DOCKER_PROFILES_ENV];
let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-docker-"));
  await writeFile(path.join(root, "docker-compose.yml"), "services:\n  web:\n    image: scratch\n", "utf8");
  process.env[DOCKER_PROFILES_ENV] = JSON.stringify({ mallo: { composeFile: "docker-compose.yml", projectName: "mallo_project", services: ["web", "api", "postgres"], controlServices: ["web", "api"] } });
});

afterEach(async () => {
  setDockerExecForTests();
  if (originalProfiles === undefined) delete process.env[DOCKER_PROFILES_ENV];
  else process.env[DOCKER_PROFILES_ENV] = originalProfiles;
  if (root) await rm(root, { recursive: true, force: true });
});

describe("safe Docker read-only adapter", () => {
  it("returns profile aliases only", () => {
    expect(listDockerProfiles()).toEqual({ profiles: ["mallo"] });
    expect(JSON.stringify(listDockerProfiles())).not.toContain("docker-compose.yml");
    expect(JSON.stringify(listDockerProfiles())).not.toContain("web");
    expect(JSON.stringify(listDockerProfiles())).not.toContain("mallo_project");
  });

  it("requires and validates projectName and defaults controlServices to empty", async () => {
    process.env[DOCKER_PROFILES_ENV] = JSON.stringify({ bad: { composeFile: "docker-compose.yml", services: ["web"] } });
    expect(() => listDockerProfiles()).toThrow(/project name/);
    process.env[DOCKER_PROFILES_ENV] = JSON.stringify({ bad: { composeFile: "docker-compose.yml", projectName: "BAD NAME", services: ["web"] } });
    expect(() => listDockerProfiles()).toThrow(/project name/);
    process.env[DOCKER_PROFILES_ENV] = JSON.stringify({ safe: { composeFile: "docker-compose.yml", projectName: "safe_project", services: ["web"] } });
    setDockerExecForTests(async () => ({ stdout: "[]", stderr: "" }));
    await expect(dockerStart(root, "safe", "web")).rejects.toThrow(/not allowlisted for control/);
  });

  it("validates controlServices as a duplicate-free subset with valid service names", () => {
    process.env[DOCKER_PROFILES_ENV] = JSON.stringify({ bad: { composeFile: "docker-compose.yml", projectName: "bad", services: ["web"], controlServices: ["web", "web"] } });
    expect(() => listDockerProfiles()).toThrow(/duplicates/);
    process.env[DOCKER_PROFILES_ENV] = JSON.stringify({ bad: { composeFile: "docker-compose.yml", projectName: "bad", services: ["web"], controlServices: ["api"] } });
    expect(() => listDockerProfiles()).toThrow(/subset/);
    process.env[DOCKER_PROFILES_ENV] = JSON.stringify({ bad: { composeFile: "docker-compose.yml", projectName: "bad", services: ["web"], controlServices: ["bad service"] } });
    expect(() => listDockerProfiles()).toThrow(/control services/);
  });

  it("rejects absolute and traversal compose paths", () => {
    process.env[DOCKER_PROFILES_ENV] = JSON.stringify({ bad: { composeFile: "/tmp/compose.yml", projectName: "bad", services: ["web"] } });
    expect(() => listDockerProfiles()).toThrow(/project-relative/);
    process.env[DOCKER_PROFILES_ENV] = JSON.stringify({ bad: { composeFile: "../compose.yml", projectName: "bad", services: ["web"] } });
    expect(() => listDockerProfiles()).toThrow(/within the project/);
  });

  it("rejects secret-classified compose paths", () => {
    process.env[DOCKER_PROFILES_ENV] = JSON.stringify({ bad: { composeFile: ".env", projectName: "bad", services: ["web"] } });
    expect(() => listDockerProfiles()).toThrow(/secret-classified/);
  });

  it("rejects symlink compose files", async () => {
    const outside = path.join(os.tmpdir(), `chatgpt2codex-compose-${Date.now()}.yml`);
    await writeFile(outside, "services: {}\n", "utf8");
    await symlink(outside, path.join(root, "link.yml"));
    process.env[DOCKER_PROFILES_ENV] = JSON.stringify({ bad: { composeFile: "link.yml", projectName: "bad", services: ["web"] } });
    await expect(dockerStatus(root, "bad")).rejects.toThrow(/symlink/);
    await rm(outside, { force: true });
  });

  it("requires exact allowlisted services", async () => {
    setDockerExecForTests(async () => ({ stdout: "[]", stderr: "" }));
    await expect(dockerStatus(root, "mallo", "worker")).rejects.toThrow(/allowlisted/);
    await expect(dockerLogs(root, "mallo", "web-extra", 10)).rejects.toThrow(/allowlisted/);
  });

  it("uses docker only with fixed argv, shell false, safe env, and bounded maxBuffer", async () => {
    const calls: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    setDockerExecForTests(async (file, args, options) => {
      calls.push({ file, args, options });
      if (args.includes("ps")) return { stdout: "[]", stderr: "" };
      return { stdout: "hello", stderr: "" };
    });
    await dockerStatus(root, "mallo", "web");
    await dockerLogs(root, "mallo", "api", 17);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.file).toBe("docker");
    expect(calls[0]?.args).toEqual(["compose", "-p", "mallo_project", "-f", path.join(root, "docker-compose.yml"), "ps", "--format", "json", "web"]);
    expect(calls[1]?.args).toEqual(["compose", "-p", "mallo_project", "-f", path.join(root, "docker-compose.yml"), "logs", "--no-color", "--tail", "17", "api"]);
    for (const call of calls) {
      expect(call.options.shell).toBe(false);
      expect(call.options.maxBuffer).toBe(DOCKER_OUTPUT_MAX_BYTES);
      expect((call.options.env as NodeJS.ProcessEnv).DOCKER_HOST).toBe(TRUSTED_LOCAL_DOCKER_HOST);
      for (const key of ["DOCKER_CONTEXT", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) {
        expect((call.options.env as NodeJS.ProcessEnv)[key]).toBeUndefined();
      }
    }
  });

  it("uses exact fixed start/stop argv and returns sanitized post-state", async () => {
    const calls: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    setDockerExecForTests(async (file, args, options) => {
      calls.push({ file, args, options });
      if (args.includes("ps")) return { stdout: JSON.stringify({ Service: "web", State: "running", Health: "healthy", Environment: ["TOKEN=nope"] }), stderr: "" };
      return { stdout: "raw docker output should not escape", stderr: "raw stderr should not escape" };
    });
    const started = await dockerStart(root, "mallo", "web");
    const stopped = await dockerStop(root, "mallo", "api");
    expect(calls[0]?.args).toEqual(["compose", "-p", "mallo_project", "-f", path.join(root, "docker-compose.yml"), "start", "web"]);
    expect(calls[2]?.args).toEqual(["compose", "-p", "mallo_project", "-f", path.join(root, "docker-compose.yml"), "stop", "--timeout", String(DOCKER_STOP_TIMEOUT_SECONDS), "api"]);
    expect(calls[0]?.options.shell).toBe(false);
    expect(calls[2]?.options.shell).toBe(false);
    expect(started).toEqual({ profile: "mallo", service: "web", action: "start", status: { service: "web", state: "running", health: "healthy" } });
    expect(stopped.profile).toBe("mallo");
    expect(JSON.stringify({ started, stopped })).not.toContain("raw docker output");
    expect(JSON.stringify({ started, stopped })).not.toContain("TOKEN");
    const forbidden = new Set(["up", "down", "run", "exec", "build", "pull", "push", "rm", "kill"]);
    for (const call of calls) for (const arg of call.args) expect(forbidden.has(arg)).toBe(false);
  });

  it("separates read services from controlServices", async () => {
    setDockerExecForTests(async (_file, args) => args.includes("ps") ? { stdout: JSON.stringify({ Service: "postgres", State: "running" }), stderr: "" } : { stdout: "logs", stderr: "" });
    await expect(dockerStatus(root, "mallo", "postgres")).resolves.toEqual({ services: [{ service: "postgres", state: "running" }] });
    await expect(dockerLogs(root, "mallo", "postgres", 5)).resolves.toMatchObject({ service: "postgres", lines: 5 });
    await expect(dockerStart(root, "mallo", "postgres")).rejects.toThrow(/not allowlisted for control/);
    await expect(dockerStop(root, "mallo", "postgres")).rejects.toThrow(/not allowlisted for control/);
    await expect(dockerStart(root, "mallo", "unknown")).rejects.toThrow(/not allowlisted for control/);
  });

  it("never falls back when start or stop fails", async () => {
    const calls: readonly string[][] = [] as unknown as string[][];
    setDockerExecForTests(async (_file, args) => {
      (calls as string[][]).push([...args]);
      throw new Error(args.includes("start") ? "no container to start" : "stop failed");
    });
    await expect(dockerStart(root, "mallo", "web")).rejects.toThrow(/^Docker command failed$/);
    expect(calls).toHaveLength(1);
    await expect(dockerStop(root, "mallo", "web")).rejects.toThrow(/^Docker command failed$/);
    expect(calls).toHaveLength(2);
    expect(calls.flat()).not.toContain("up");
    expect(calls.flat()).not.toContain("down");
    expect(calls.flat()).not.toContain("kill");
    expect(calls.flat()).not.toContain("rm");
  });

  it("sanitizes status to the explicit allowlist of fields", async () => {
    setDockerExecForTests(async () => ({
      stdout: JSON.stringify({
        Service: "web",
        State: "running",
        Status: "Up 2 minutes",
        Health: "healthy",
        Name: "proj-web-1",
        Image: "example/web:local",
        Publishers: [{ URL: "0.0.0.0", TargetPort: 3000, PublishedPort: 8080, Protocol: "tcp", HostIP: "/private/path" }],
        Environment: ["TOKEN=super-secret"],
        Labels: { token: "super-secret" },
        Mounts: [{ Source: "/Users/alice/private", Destination: "/app" }],
        Command: "cat /secret/file",
      }),
      stderr: "",
    }));
    const result = await dockerStatus(root, "mallo");
    expect(result).toEqual({ services: [{
      service: "web",
      state: "running",
      status: "Up 2 minutes",
      health: "healthy",
      containerName: "proj-web-1",
      image: "example/web:local",
      publishedPorts: [{ url: "0.0.0.0", targetPort: 3000, publishedPort: 8080, protocol: "tcp" }],
    }] });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("TOKEN");
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("/Users/alice/private");
    expect(serialized).not.toContain("Labels");
  });

  it("bounds log lines, caps output, and applies existing secret redaction", async () => {
    setDockerExecForTests(async () => ({ stdout: `token=ghp_abcdefghijklmnopqrstuvwxyz1234567890\n${"x".repeat(DOCKER_OUTPUT_MAX_BYTES)}`, stderr: "warning" }));
    await expect(dockerLogs(root, "mallo", "web", DOCKER_LOG_MAX_LINES + 1)).rejects.toThrow(/between 1 and 500/);
    const result = await dockerLogs(root, "mallo", "web", DOCKER_LOG_MAX_LINES);
    expect(result.lines).toBe(500);
    expect(Buffer.byteLength(`${result.logs}${result.stderr ?? ""}`, "utf8")).toBeLessThanOrEqual(DOCKER_OUTPUT_MAX_BYTES);
    expect(result.logs).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
  });

  it("returns a sanitized unavailable error without leaking executor errors", async () => {
    setDockerExecForTests(async () => { const error = new Error("spawn /private/docker ENOENT DOCKER_HOST=tcp://secret:2375") as NodeJS.ErrnoException; error.code = "ENOENT"; throw error; });
    await expect(dockerStatus(root, "mallo")).rejects.toThrow(/^Docker adapter unavailable$/);
  });
});
