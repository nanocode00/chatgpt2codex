import { afterEach, describe, expect, it } from "vitest";
import { builtInSafeAdapterOperationRegistry } from "./builtin-operations.js";
import { PYTHON_RUNTIME_PROFILES_ENV } from "../python/runtime-profiles.js";
import { SQLITE_PROFILES_ENV } from "../database/sqlite-profiles.js";

const pythonOriginal = process.env[PYTHON_RUNTIME_PROFILES_ENV];
const sqliteOriginal = process.env[SQLITE_PROFILES_ENV];

afterEach(() => {
  if (pythonOriginal === undefined) delete process.env[PYTHON_RUNTIME_PROFILES_ENV];
  else process.env[PYTHON_RUNTIME_PROFILES_ENV] = pythonOriginal;
  if (sqliteOriginal === undefined) delete process.env[SQLITE_PROFILES_ENV];
  else process.env[SQLITE_PROFILES_ENV] = sqliteOriginal;
});

describe("built-in safe adapter operations", () => {
  it("catalogs deterministic multi-adapter operations without profile secrets or handler details", () => {
    process.env[PYTHON_RUNTIME_PROFILES_ENV] = JSON.stringify({ prod: "/very/private/super-secret/python" });
    process.env[SQLITE_PROFILES_ENV] = JSON.stringify({ prod: { path: "secret/database.db" } });
    const catalog = builtInSafeAdapterOperationRegistry.catalog();
    expect(catalog.operations.map((operation) => operation.id)).toEqual([
      "python.profiles",
      "sqlite.inspect",
      "sqlite.profiles",
      "sqlite.query",
    ]);
    expect(catalog.operations.map((operation) => operation.adapter)).toEqual(["python", "sqlite", "sqlite", "sqlite"]);
    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("secret/database.db");
    expect(serialized).not.toContain("handler");
    expect(serialized).not.toContain("module");
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

  it("cannot resolve arbitrary MCP or Git tool names through the registry", () => {
    for (const id of ["local_shell_run", "call_tool", "git.status", "database.query", "python.execute"]) {
      expect(() => builtInSafeAdapterOperationRegistry.get(id)).toThrow();
    }
  });
});
