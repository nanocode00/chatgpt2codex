import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolContext } from "../types.js";
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
