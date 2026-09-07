import { afterEach, describe, expect, it } from "vitest";
import * as builtinModule from "./builtin-operations.js";
import { builtInSafeAdapterOperationRegistry, catalogBuiltInSafeAdapterOperations } from "./builtin-operations.js";
import { PYTHON_RUNTIME_PROFILES_ENV } from "../python/runtime-profiles.js";
import { SQLITE_PROFILES_ENV } from "../database/sqlite-profiles.js";
import type { ToolContext } from "../types.js";

const pythonOriginal = process.env[PYTHON_RUNTIME_PROFILES_ENV];
const sqliteOriginal = process.env[SQLITE_PROFILES_ENV];

afterEach(() => {
  if (pythonOriginal === undefined) delete process.env[PYTHON_RUNTIME_PROFILES_ENV];
  else process.env[PYTHON_RUNTIME_PROFILES_ENV] = pythonOriginal;
  if (sqliteOriginal === undefined) delete process.env[SQLITE_PROFILES_ENV];
  else process.env[SQLITE_PROFILES_ENV] = sqliteOriginal;
});

describe("built-in safe adapter operations", () => {
  function registryForStrictValidatorTests() {
    const registry = Object.values(builtinModule).find((value) => value && typeof value === "object" && "get" in value && "catalog" in value) as {
      get(id: string): { capability: string; input: readonly unknown[]; validateInput(value: Record<string, unknown>): Record<string, unknown> };
    } | undefined;
    if (!registry) throw new Error("built-in adapter registry export not found");
    return registry;
  }

  it("catalogs deterministic multi-adapter operations without profile secrets or handler details", () => {
    process.env[PYTHON_RUNTIME_PROFILES_ENV] = JSON.stringify({ prod: "/very/private/super-secret/python" });
    process.env[SQLITE_PROFILES_ENV] = JSON.stringify({ prod: { path: "secret/database.db" } });
    const catalog = builtInSafeAdapterOperationRegistry.catalog();
    expect(catalog.operations.map((operation) => operation.id)).toEqual([
      "docker.logs",
      "docker.profiles",
      "docker.start",
      "docker.status",
      "docker.stop",
      "notebook.execute",
      "notebook.validate",
      "python.execute",
      "python.profiles",
      "sqlite.inspect",
      "sqlite.profiles",
      "sqlite.query",
    ]);
    expect(catalog.operations.map((operation) => operation.adapter)).toEqual(["docker", "docker", "docker", "docker", "docker", "notebook", "notebook", "python", "python", "sqlite", "sqlite", "sqlite"]);
    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("secret/database.db");
    expect(serialized).not.toContain("handler");
    expect(serialized).not.toContain("module");
  });

  it("keeps Python and notebook execution validators strict", () => {
    const python = builtInSafeAdapterOperationRegistry.get("python.execute");
    expect(python.capability).toBe("write");
    expect(python.availability).toBe("remote-exec");
    expect(python.validateInput({ path: "scripts/run.py" })).toEqual({ path: "scripts/run.py", runtimeProfile: undefined });
    expect(() => python.validateInput({ path: "scripts/run.py", executable: "/bin/python" })).toThrow(/unexpected fields/);
    expect(() => python.validateInput({ path: "scripts/run.py", argv: ["--x"] })).toThrow(/unexpected fields/);
    expect(() => python.validateInput({ path: "scripts/run.py", env: { X: "1" } })).toThrow(/unexpected fields/);

    const validate = builtInSafeAdapterOperationRegistry.get("notebook.validate");
    expect(validate.capability).toBe("read");
    expect(validate.validateInput({ path: "analysis.ipynb" })).toEqual({ path: "analysis.ipynb" });
    expect(() => validate.validateInput({ path: "analysis.ipynb", runtimeProfile: "x" })).toThrow(/unexpected fields/);

    const execute = builtInSafeAdapterOperationRegistry.get("notebook.execute");
    expect(execute.capability).toBe("write");
    expect(execute.availability).toBe("remote-exec");
    expect(execute.validateInput({ path: "analysis.ipynb", runtimeProfile: "chosen" })).toEqual({ path: "analysis.ipynb", runtimeProfile: "chosen" });
    expect(() => execute.validateInput({ path: "analysis.ipynb", command: "python" })).toThrow(/unexpected fields/);
  });

  it("filters the actual built-in catalog by remote-exec availability", () => {
    const remote = { remote: true } as ToolContext;
    delete process.env.CHATGPT2CODEX_REMOTE_EXEC;
    const withoutExec = catalogBuiltInSafeAdapterOperations(remote).operations.map((operation) => operation.id);
    expect(withoutExec).toEqual([
      "docker.logs",
      "docker.profiles",
      "docker.status",
      "notebook.validate",
      "python.profiles",
      "sqlite.inspect",
      "sqlite.profiles",
      "sqlite.query",
    ]);

    process.env.CHATGPT2CODEX_REMOTE_EXEC = "1";
    const withExec = catalogBuiltInSafeAdapterOperations(remote).operations.map((operation) => operation.id);
    expect(withExec).toEqual([
      "docker.logs",
      "docker.profiles",
      "docker.start",
      "docker.status",
      "docker.stop",
      "notebook.execute",
      "notebook.validate",
      "python.execute",
      "python.profiles",
      "sqlite.inspect",
      "sqlite.profiles",
      "sqlite.query",
    ]);
    delete process.env.CHATGPT2CODEX_REMOTE_EXEC;
  });

  it("keeps catalog descriptors aligned with strict SQLite validators", () => {
    const profiles = builtInSafeAdapterOperationRegistry.get("sqlite.profiles");
    expect(profiles.input).toEqual([]);
    expect(() => profiles.validateInput({ path: "data/app.db" })).toThrow(/unexpected fields/);

    const inspect = builtInSafeAdapterOperationRegistry.get("sqlite.inspect");
    expect(inspect.input).toEqual([{ name: "profile", type: "string", required: true, maxLength: 64 }]);
    expect(inspect.validateInput({ profile: "app" })).toEqual({ profile: "app" });
    expect(() => inspect.validateInput({ profile: "app", sql: "SELECT 1" })).toThrow(/unexpected fields/);

    const query = builtInSafeAdapterOperationRegistry.get("sqlite.query");
    expect(query.input).toEqual([
      { name: "profile", type: "string", required: true, maxLength: 64 },
      { name: "sql", type: "string", required: true, maxLength: 65536 },
      { name: "maxRows", type: "integer", required: false, min: 1, max: 200 },
    ]);
    expect(query.validateInput({ profile: "app", sql: "SELECT 1" })).toEqual({ profile: "app", sql: "SELECT 1", maxRows: 100 });
    expect(query.validateInput({ profile: "app", sql: "SELECT 1", maxRows: 200 })).toEqual({ profile: "app", sql: "SELECT 1", maxRows: 200 });
    expect(() => query.validateInput({ profile: "app", sql: "SELECT 1", maxRows: 201 })).toThrow(/maxRows/);
    expect(() => query.validateInput({ profile: "app", sql: "SELECT 1", executable: "/bin/sh" })).toThrow(/unexpected fields/);
    expect(() => query.validateInput({ profile: "app", sql: "SELECT 1", capability: "write" })).toThrow(/unexpected fields/);
    expect(() => query.validateInput({ profile: "app", sql: "SELECT 1", handler: "local_shell_run" })).toThrow(/unexpected fields/);
  });

  it("keeps Docker validators strict and registers only bounded read plus start/stop v1", () => {
    const registry = registryForStrictValidatorTests();
    const profiles = registry.get("docker.profiles");
    expect(profiles.capability).toBe("read");
    expect(profiles.input).toEqual([]);
    expect(() => profiles.validateInput({ composeFile: "docker-compose.yml" })).toThrow(/unexpected fields/);

    const status = registry.get("docker.status");
    expect(status.capability).toBe("read");
    expect(status.validateInput({ profile: "mallo", service: "web" })).toEqual({ profile: "mallo", service: "web" });
    for (const extra of [
      { dockerHost: "tcp://127.0.0.1:2375" }, { socket: "/var/run/docker.sock" }, { path: "/usr/bin/docker" },
      { flags: ["--context", "evil"] }, { context: "remote" }, { projectDirectory: "/tmp/x" },
    ]) expect(() => status.validateInput({ profile: "mallo", ...extra })).toThrow(/unexpected fields/);

    const logs = registry.get("docker.logs");
    expect(logs.capability).toBe("read");
    expect(logs.validateInput({ profile: "mallo", service: "web" })).toEqual({ profile: "mallo", service: "web", lines: 100 });
    expect(logs.validateInput({ profile: "mallo", service: "web", lines: 500 })).toEqual({ profile: "mallo", service: "web", lines: 500 });
    expect(() => logs.validateInput({ profile: "mallo", service: "web", lines: 501 })).toThrow(/lines/);
    expect(() => logs.validateInput({ profile: "mallo", service: "web", argv: ["--follow"] })).toThrow(/unexpected fields/);

    for (const id of ["docker.start", "docker.stop"]) {
      const operation = registry.get(id);
      expect(operation.capability).toBe("write");
      expect((operation as { availability?: string }).availability).toBe("remote-exec");
      expect(operation.validateInput({ profile: "mallo", service: "web" })).toEqual({ profile: "mallo", service: "web" });
      for (const extra of [
        { containerId: "abc" }, { containerName: "name" }, { image: "x" }, { projectName: "evil" }, { composeFile: "evil.yml" },
        { path: "/tmp" }, { dockerHost: "tcp://evil" }, { context: "evil" }, { args: ["up"] }, { flags: ["--force"] },
        { env: { DOCKER_HOST: "evil" } }, { timeout: 999 }, { signal: "KILL" }, { remove: true }, { force: true },
      ]) expect(() => operation.validateInput({ profile: "mallo", service: "web", ...extra })).toThrow(/unexpected fields/);
    }

    for (const id of ["docker.restart", "docker.up", "docker.down", "docker.build", "docker.pull", "docker.push", "docker.exec", "docker.run", "docker.rm", "docker.kill", "docker.create", "docker.compose.run", "docker.compose.up", "docker.compose.down"]) {
      expect(() => registry.get(id)).toThrow();
    }
  });

  it("cannot resolve arbitrary MCP or Git tool names through the registry", () => {
    for (const id of ["local_shell_run", "call_tool", "git.status", "database.query"]) {
      expect(() => builtInSafeAdapterOperationRegistry.get(id)).toThrow();
    }
  });
});
