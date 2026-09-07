import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolContext } from "../types.js";
import { DomainError, ErrorCode } from "../types.js";
import { SQLITE_PROFILES_ENV } from "../database/sqlite-profiles.js";
import { invokeBuiltInSafeAdapterOperation } from "./builtin-operations.js";

const parts = process.versions.node.split(".").map(Number);
const sqliteSupported = (parts[0] ?? 0) > 22 || ((parts[0] ?? 0) === 22 && (parts[1] ?? 0) >= 18);
const originalProfiles = process.env[SQLITE_PROFILES_ENV];
let root = "";
let session: unknown = {};
let ctx: ToolContext;

async function createFixture(file: string): Promise<void> {
  const modulePath = path.join(path.dirname(file), "gateway-fixture.mjs");
  await fs.writeFile(modulePath, `
import { DatabaseSync } from "node:sqlite";
import { workerData } from "node:worker_threads";
const db = new DatabaseSync(workerData.file);
try {
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO users VALUES (1, 'Ada'), (2, 'Lin'); CREATE VIEW user_names AS SELECT name FROM users;");
} finally { db.close(); }
`);
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(modulePath, { workerData: { file } });
    worker.once("error", reject);
    worker.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`fixture worker exited ${code}`)));
  });
  await fs.rm(modulePath, { force: true });
}

beforeAll(async () => {
  if (!sqliteSupported) return;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-gateway-sqlite-"));
  await fs.mkdir(path.join(root, "data"));
  await createFixture(path.join(root, "data", "app.db"));
  await fs.writeFile(path.join(root, "run.py"), "print('gateway-python-ok')\n", "utf8");
  await fs.writeFile(path.join(root, "validate.ipynb"), JSON.stringify({
    cells: [{ cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: ["x = 1 + 1\n"] }],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  }), "utf8");
  process.env[SQLITE_PROFILES_ENV] = JSON.stringify({ app: { path: "data/app.db" } });
  const project = { projectId: "proj", name: "proj", root, aliases: [] };
  ctx = {
    workspaceRoot: root,
    stateDir: path.join(root, ".state"),
    registry: [project],
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => [project],
      saveProjects: async () => undefined,
      getSession: async () => session,
      setSession: async (value) => { session = value; },
    },
    config: {
      workspaceRoot: root,
      stateDir: path.join(root, ".state"),
      maxReadBytes: 1024,
      maxPatchBytes: 1024,
      defaultCommandTimeoutSec: 10,
      defaultLeaseTtlMs: 60_000,
    },
    remote: false,
  };
});

afterAll(async () => {
  if (originalProfiles === undefined) delete process.env[SQLITE_PROFILES_ENV];
  else process.env[SQLITE_PROFILES_ENV] = originalProfiles;
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe.skipIf(!sqliteSupported)("SQLite adapter_gateway parity", () => {
  it("invokes sqlite.profiles through the static operation registry", async () => {
    const result = await invokeBuiltInSafeAdapterOperation(ctx, "proj", "sqlite.profiles", {});
    expect(result).toEqual({ operation: "sqlite.profiles", result: { engine: "sqlite", profiles: ["app"] } });
    expect(JSON.stringify(result)).not.toContain("data/app.db");
  });

  it("invokes sqlite.inspect through the static operation registry", async () => {
    const result = await invokeBuiltInSafeAdapterOperation(ctx, "proj", "sqlite.inspect", { profile: "app" });
    const payload = result.result as { objects: Array<{ name: string }> };
    expect(result.operation).toBe("sqlite.inspect");
    expect(payload.objects.map((item) => item.name)).toEqual(expect.arrayContaining(["users", "user_names"]));
  });

  it("invokes sqlite.query through the static operation registry without weakening backend limits", async () => {
    const result = await invokeBuiltInSafeAdapterOperation(ctx, "proj", "sqlite.query", {
      profile: "app",
      sql: "SELECT id, name FROM users ORDER BY id",
    });
    const payload = result.result as { rows: unknown[]; maxRows: number; truncated: boolean };
    expect(result.operation).toBe("sqlite.query");
    expect(payload.rows).toHaveLength(2);
    expect(payload.maxRows).toBe(100);
    expect(payload.truncated).toBe(false);
  });

  it("keeps unsafe SQL blocked through the gateway operation", async () => {
    await expect(invokeBuiltInSafeAdapterOperation(ctx, "proj", "sqlite.query", {
      profile: "app",
      sql: "DELETE FROM users",
    })).rejects.toThrow(/not allowed|read-only/i);
  });
});

describe.skipIf(!sqliteSupported)("Python and notebook adapter_gateway parity", () => {
  it("executes a simple project-confined Python script through the shared backend", async () => {
    const result = await invokeBuiltInSafeAdapterOperation(ctx, "proj", "python.execute", { path: "run.py" });
    const payload = result.result as { exitCode: number; stdout: string };
    expect(result.operation).toBe("python.execute");
    expect(payload.exitCode).toBe(0);
    expect(payload.stdout).toContain("gateway-python-ok");
  });

  it("validates a project-confined notebook through the shared backend", async () => {
    const result = await invokeBuiltInSafeAdapterOperation(ctx, "proj", "notebook.validate", { path: "validate.ipynb" });
    expect(result.operation).toBe("notebook.validate");
    expect(result.result).toMatchObject({ valid: true });
  });

  it("executes a notebook through the shared backend when the trusted notebook runtime is available", async () => {
    try {
      const result = await invokeBuiltInSafeAdapterOperation(ctx, "proj", "notebook.execute", { path: "validate.ipynb" });
      expect(result.operation).toBe("notebook.execute");
      expect(result.result).toMatchObject({ executed: true });
    } catch (error) {
      if (error instanceof DomainError && error.code === ErrorCode.NOT_IMPLEMENTED) return;
      throw error;
    }
  });

  it("executes Python remotely only when both REMOTE_EXEC and REMOTE_WRITE are enabled", async () => {
    const previousRemote = ctx.remote;
    const previousSession = session;
    const previousExec = process.env.CHATGPT2CODEX_REMOTE_EXEC;
    const previousWrite = process.env.CHATGPT2CODEX_REMOTE_WRITE;
    try {
      ctx.remote = true;
      session = {};
      process.env.CHATGPT2CODEX_REMOTE_EXEC = "1";
      process.env.CHATGPT2CODEX_REMOTE_WRITE = "1";
      const result = await invokeBuiltInSafeAdapterOperation(ctx, "proj", "python.execute", { path: "run.py" });
      expect(result.operation).toBe("python.execute");
      expect(result.result).toMatchObject({ executed: true, exitCode: 0 });
    } finally {
      ctx.remote = previousRemote;
      session = previousSession;
      if (previousExec === undefined) delete process.env.CHATGPT2CODEX_REMOTE_EXEC;
      else process.env.CHATGPT2CODEX_REMOTE_EXEC = previousExec;
      if (previousWrite === undefined) delete process.env.CHATGPT2CODEX_REMOTE_WRITE;
      else process.env.CHATGPT2CODEX_REMOTE_WRITE = previousWrite;
    }
  });
});
