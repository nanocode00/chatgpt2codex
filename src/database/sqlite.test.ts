import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SQLITE_PROFILES_ENV } from "./sqlite-profiles.js";
import { assertSQLiteRuntime, inspectSQLite, listSQLiteProfiles, querySQLite } from "./sqlite.js";

const runtimeParts = process.versions.node.split(".").map(Number);
const sqliteSupported = (runtimeParts[0] ?? 0) > 22 || ((runtimeParts[0] ?? 0) === 22 && (runtimeParts[1] ?? 0) >= 18);

let root = "";
let dbPath = "";
let env: NodeJS.ProcessEnv;

async function fingerprint(file: string) {
  const [data, stat] = await Promise.all([fs.readFile(file), fs.stat(file)]);
  return { hash: createHash("sha256").update(data).digest("hex"), mtimeMs: stat.mtimeMs, size: stat.size };
}

async function createFixture(file: string) {
  const fixtureModule = path.join(path.dirname(file), "fixture-create.mjs");
  await fs.writeFile(fixtureModule, `
import { DatabaseSync } from "node:sqlite";
import { workerData } from "node:worker_threads";
const db = new DatabaseSync(workerData.file);
try {
  db.exec(\`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, team_id INTEGER, payload BLOB);
    CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE big_values (value INTEGER NOT NULL);
    CREATE VIEW user_names AS SELECT id, name FROM users;
    INSERT INTO teams VALUES (1, 'alpha'), (2, 'beta');
    INSERT INTO big_values VALUES (9223372036854775806);
  \`);
  const insert = db.prepare("INSERT INTO users(id, name, team_id, payload) VALUES (?, ?, ?, ?)");
  for (let i = 1; i <= 250; i++) {
    const name = i === 1 ? "x".repeat(6000) : \`user-\${i}\`;
    insert.run(i, name, i % 2 === 0 ? 2 : 1, i === 1 ? Buffer.alloc(8192, 7) : Buffer.from([i % 256]));
  }
} finally { db.close(); }
`);
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(fixtureModule, { workerData: { file } });
    worker.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`fixture worker exited ${code}`)));
    worker.once("error", reject);
  });
  await fs.rm(fixtureModule, { force: true });
}

beforeAll(async () => {
  if (!sqliteSupported) return;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-sqlite-"));
  await fs.mkdir(path.join(root, "data"));
  dbPath = path.join(root, "data", "app.db");
  await createFixture(dbPath);
  env = { [SQLITE_PROFILES_ENV]: JSON.stringify({ app: { path: "data/app.db" } }) };
});

afterAll(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = "";
});

describe("SQLite runtime guard", () => {
  it("requires Node 22.18 or newer for the adapter", () => {
    expect(() => assertSQLiteRuntime("22.17.9")).toThrow("SQLite adapter unavailable on this Node runtime");
    expect(() => assertSQLiteRuntime("22.18.0")).not.toThrow();
    expect(() => assertSQLiteRuntime("24.0.0")).not.toThrow();
  });
});

describe.skipIf(!sqliteSupported)("SQLite read-only backend", () => {
  it("lists aliases only and never returns paths", () => {
    const result = listSQLiteProfiles(env);
    expect(result).toEqual({ engine: "sqlite", profiles: ["app"] });
    expect(JSON.stringify(result)).not.toContain("data/app.db");
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("runs SELECT, JOIN, aggregate, CTE, VALUES, comments, strings, and a trailing semicolon", async () => {
    const queries = [
      "SELECT 1 AS one",
      "SELECT u.name, t.name AS team FROM users u JOIN teams t ON t.id=u.team_id WHERE u.id=2",
      "SELECT count(*) AS count FROM users",
      "WITH picked AS (SELECT id FROM users WHERE id <= 3) SELECT count(*) AS count FROM picked",
      "VALUES (1), (2)",
      "SELECT 'DELETE ATTACH PRAGMA' AS words; -- harmless comment",
      "/* UPDATE users */ SELECT name FROM users WHERE id=2",
    ];
    for (const sql of queries) {
      const result = await querySQLite(root, "app", sql, 10, { env });
      expect(result.engine).toBe("sqlite");
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rows.length).toBeLessThanOrEqual(10);
    }
  });

  it("enforces default/max row limits and truncation", async () => {
    const defaultResult = await querySQLite(root, "app", "SELECT id FROM users ORDER BY id", undefined, { env });
    expect(defaultResult.rows).toHaveLength(100);
    expect(defaultResult.truncated).toBe(true);
    expect(defaultResult.maxRows).toBe(100);

    const maxResult = await querySQLite(root, "app", "SELECT id FROM users ORDER BY id", 200, { env });
    expect(maxResult.rows).toHaveLength(200);
    expect(maxResult.truncated).toBe(true);
    await expect(querySQLite(root, "app", "SELECT 1", 201, { env })).rejects.toThrow(/between 1 and 200/);
  });

  it("bounds long text, BLOBs, BigInts, and total serialized output", async () => {
    const first = await querySQLite(root, "app", "SELECT name, payload FROM users WHERE id=1", 5, { env });
    const row = first.rows[0] as Record<string, unknown>;
    expect(row.name).toMatchObject({ type: "text", truncated: true, originalChars: 6000 });
    expect((row.name as { value: string }).value).toHaveLength(4096);
    expect(row.payload).toEqual({ type: "blob", bytes: 8192 });

    const big = await querySQLite(root, "app", "SELECT value FROM big_values", 5, { env });
    expect((big.rows[0] as Record<string, unknown>).value).toEqual({ type: "bigint", value: "9223372036854775806" });

    const bounded = await querySQLite(root, "app", "SELECT name || printf('%05000d', id) AS text FROM users", 200, { env });
    expect(bounded.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThan(140 * 1024);
  });

  it("inspects bounded user tables/views and column metadata without sqlite internals", async () => {
    const result = await inspectSQLite(root, "app", { env });
    const objects = result.objects as Array<{ name: string; kind: string; columns: Array<Record<string, unknown>> }>;
    expect(objects.map((item) => item.name)).toEqual(expect.arrayContaining(["users", "teams", "big_values", "user_names"]));
    expect(objects.some((item) => item.name.startsWith("sqlite_"))).toBe(false);
    const users = objects.find((item) => item.name === "users");
    expect(users?.kind).toBe("table");
    expect(users?.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "id", declaredType: "INTEGER", primaryKey: true }),
      expect.objectContaining({ name: "name", declaredType: "TEXT", nullable: false }),
    ]));
    expect(JSON.stringify(result)).not.toContain("CREATE TABLE");
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("rejects profile paths that are missing, symlinked, or outside confinement without leaking paths", async () => {
    const missingEnv = { [SQLITE_PROFILES_ENV]: JSON.stringify({ missing: { path: "data/missing.db" } }) };
    await expect(querySQLite(root, "missing", "SELECT 1", 5, { env: missingEnv })).rejects.toThrow("existing regular file");

    if (process.platform !== "win32") {
      const link = path.join(root, "data", "link.db");
      await fs.symlink(dbPath, link);
      const linkEnv = { [SQLITE_PROFILES_ENV]: JSON.stringify({ linked: { path: "data/link.db" } }) };
      let message = "";
      try { await querySQLite(root, "linked", "SELECT 1", 5, { env: linkEnv }); } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("not accessible");
      expect(message).not.toContain(link);
      expect(message).not.toContain(root);
    }
  });

  it.each([
    "INSERT INTO users(name) VALUES ('bad')",
    "UPDATE users SET name='bad' WHERE id=2",
    "DELETE FROM users WHERE id=2",
    "REPLACE INTO users(id,name) VALUES (2,'bad')",
    "CREATE TABLE hacked(x)",
    "DROP TABLE users",
    "ALTER TABLE users ADD COLUMN hacked TEXT",
    "ATTACH DATABASE 'other.db' AS other",
    "DETACH DATABASE main",
    "PRAGMA user_version=1",
    "VACUUM",
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
    "SAVEPOINT x",
    "RELEASE x",
    "SELECT load_extension('evil')",
    "WITH x AS (SELECT 1) DELETE FROM users",
    "SELECT 1; SELECT 2",
  ])("rejects mutation/escape SQL and leaves the database byte-identical: %s", async (sql) => {
    const before = await fingerprint(dbPath);
    await expect(querySQLite(root, "app", sql, 5, { env })).rejects.toThrow();
    const after = await fingerprint(dbPath);
    expect(after).toEqual(before);
  });

  it("terminates a long-running worker on a bounded internal timeout without changing the database", async () => {
    const before = await fingerprint(dbPath);
    await expect(querySQLite(
      root,
      "app",
      "WITH RECURSIVE cnt(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM cnt WHERE x < 1000000000) SELECT sum(x) FROM cnt",
      5,
      { env, timeoutMs: 50 },
    )).rejects.toThrow("SQLite query timed out");
    const after = await fingerprint(dbPath);
    expect(after).toEqual(before);
  });
});
