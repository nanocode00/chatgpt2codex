import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POSTGRES_PROFILES_ENV } from "./postgres-profiles.js";
import { inspectPostgres, queryPostgres, type PgClientLike } from "./postgres.js";

const roots: string[] = [];
async function root(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-postgres-"));
  roots.push(dir);
  return dir;
}
function env(projectRoot: string): NodeJS.ProcessEnv {
  return {
    [POSTGRES_PROFILES_ENV]: JSON.stringify({ app: { projectRoot, connectionStringEnv: "APP_POSTGRES_READONLY_URL", schemas: ["public"] } }),
    APP_POSTGRES_READONLY_URL: "postgresql://readonly:secret@db.internal/app",
  };
}
function client(operationRows: unknown[][] = [[1]], fields = [{ name: "value" }]) {
  const calls: Array<{ query: unknown; values?: unknown[] }> = [];
  let role = { rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false };
  const mock: PgClientLike = {
    connect: vi.fn(async () => undefined),
    query: vi.fn(async (query: any, values?: any[]) => {
      calls.push({ query, values });
      const text = typeof query === "string" ? query : query.text;
      if (text === "SHOW transaction_read_only") return { rows: [{ transaction_read_only: "on" }], fields: [] };
      if (text.includes("FROM pg_catalog.pg_roles")) return { rows: [role], fields: [] };
      if (text.includes("information_schema.columns")) return { rows: [], fields: [] };
      if (typeof query === "object" && query.rowMode === "array") return { rows: operationRows, fields };
      return { rows: [], fields: [] };
    }),
    end: vi.fn(async () => undefined),
  };
  return { mock, calls, setRole(value: typeof role) { role = value; } };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("PostgreSQL read-only client", () => {
  it("binds the profile to the canonical selected project before connecting", async () => {
    const selected = await root();
    const other = await root();
    const factory = vi.fn();
    await expect(queryPostgres(selected, "app", "SELECT 1", 100, { env: env(other), clientFactory: factory })).rejects.toThrow(/selected project/);
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects non-PostgreSQL protocols before connecting", async () => {
    const selected = await root();
    const bad = env(selected);
    bad.APP_POSTGRES_READONLY_URL = "https://example.invalid/db";
    const factory = vi.fn();
    await expect(queryPostgres(selected, "app", "SELECT 1", 100, { env: bad, clientFactory: factory })).rejects.toThrow(/protocol/);
    expect(factory).not.toHaveBeenCalled();
  });

  it("uses a bounded read-only transaction, verifies role safety, and server-bounds rows", async () => {
    const selected = await root();
    const c = client([[1], [2], [3]], [{ name: "n" }]);
    const result = await queryPostgres(selected, "app", "SELECT n FROM numbers;", 2, { env: env(selected), clientFactory: () => c.mock });
    expect(result).toEqual({ engine: "postgres", columns: ["n"], rows: [[1], [2]], truncated: true, maxRows: 2 });
    expect(c.calls.map((call) => typeof call.query === "string" ? call.query : (call.query as any).text)).toEqual([
      "BEGIN TRANSACTION READ ONLY",
      "SET LOCAL statement_timeout = '5000ms'",
      "SET LOCAL lock_timeout = '1000ms'",
      "SET LOCAL idle_in_transaction_session_timeout = '5000ms'",
      "SHOW transaction_read_only",
      "SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user",
      "SELECT * FROM (SELECT n FROM numbers) AS _chatgpt2codex_readonly LIMIT 3",
      "COMMIT",
    ]);
    expect((c.calls[6]!.query as any).rowMode).toBe("array");
    expect(c.mock.end).toHaveBeenCalledOnce();
  });

  it("fails closed for privileged roles and rolls back", async () => {
    const selected = await root();
    const c = client();
    c.setRole({ rolsuper: true, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false });
    await expect(queryPostgres(selected, "app", "SELECT 1", 100, { env: env(selected), clientFactory: () => c.mock })).rejects.toThrow(/privileged/);
    expect(c.calls.some((call) => call.query === "ROLLBACK")).toBe(true);
    expect(c.mock.end).toHaveBeenCalledOnce();
  });

  it("runs fixed parameterized schema inspection without exposing sensitive metadata", async () => {
    const selected = await root();
    const c = client();
    (c.mock.query as any).mockImplementation(async (query: any, values?: any[]) => {
      c.calls.push({ query, values });
      const text = typeof query === "string" ? query : query.text;
      if (text === "SHOW transaction_read_only") return { rows: [{ transaction_read_only: "on" }], fields: [] };
      if (text.includes("pg_catalog.pg_roles")) return { rows: [{ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false }], fields: [] };
      if (text.includes("information_schema.columns")) return { rows: [{ table_schema: "public", table_name: "users", table_type: "BASE TABLE", column_name: "id", data_type: "bigint", is_nullable: "NO" }], fields: [] };
      return { rows: [], fields: [] };
    });
    const result = await inspectPostgres(selected, "app", { env: env(selected), clientFactory: () => c.mock });
    expect(result).toEqual({ engine: "postgres", objects: [{ schema: "public", name: "users", type: "BASE TABLE", columns: [{ name: "id", dataType: "bigint", nullable: false }] }], truncated: false });
    const metadata = c.calls.find((call) => typeof call.query === "string" && call.query.includes("information_schema.columns"));
    expect(metadata?.values?.[0]).toEqual(["public"]);
  });

  it("sanitizes driver failures", async () => {
    const selected = await root();
    const c = client();
    (c.mock.connect as any).mockRejectedValue(new Error("postgresql://readonly:secret@db.internal/app password=secret"));
    await expect(queryPostgres(selected, "app", "SELECT 1", 100, { env: env(selected), clientFactory: () => c.mock })).rejects.toThrow("PostgreSQL operation failed");
    await expect(queryPostgres(selected, "app", "SELECT 1", 100, { env: env(selected), clientFactory: () => c.mock })).rejects.not.toThrow(/secret|db\.internal/);
  });
});
