import { promises as fs } from "node:fs";
import { Client, type ClientConfig, type QueryConfig } from "pg";
import { validateProfileAlias } from "../adapters/profile.js";
import { DomainError, ErrorCode } from "../types.js";
import { parsePostgresProfiles, type PostgresProfile } from "./postgres-profiles.js";
import { assertSafePostgresReadOnlySql } from "./postgres-sql-guard.js";

export const POSTGRES_DEFAULT_MAX_ROWS = 100;
export const POSTGRES_MAX_ROWS = 200;
const CONNECTION_TIMEOUT_MS = 5_000;
const STATEMENT_TIMEOUT_MS = 5_000;
const LOCK_TIMEOUT_MS = 1_000;
const IDLE_TX_TIMEOUT_MS = 5_000;
const MAX_COLUMNS = 128;
const MAX_OBJECTS = 100;
const MAX_COLUMNS_PER_OBJECT = 128;
const MAX_STRING = 4096;
const MAX_OUTPUT_BYTES = 128 * 1024;

export interface PostgresRunOptions {
  env?: NodeJS.ProcessEnv;
  clientFactory?: (config: ClientConfig) => PgClientLike;
}

export interface PgClientLike {
  connect(): Promise<unknown>;
  query(queryTextOrConfig: string | QueryConfig<any[]>, values?: any[]): Promise<any>;
  end(): Promise<void>;
}

function reject(message: string): never {
  throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, message);
}

async function resolveProfile(projectRoot: string, profile: string, env: NodeJS.ProcessEnv): Promise<{ profile: PostgresProfile; dsn: string }> {
  if (!validateProfileAlias(profile)) reject("PostgreSQL profile alias is invalid");
  const descriptor = parsePostgresProfiles(env).profiles.get(profile);
  if (!descriptor) reject("PostgreSQL profile is not configured");
  let actualRoot: string;
  let configuredRoot: string;
  try {
    [actualRoot, configuredRoot] = await Promise.all([fs.realpath(projectRoot), fs.realpath(descriptor.projectRoot)]);
  } catch {
    reject("PostgreSQL profile project binding is invalid");
  }
  if (actualRoot !== configuredRoot) reject("PostgreSQL profile does not match the selected project");
  const dsn = env[descriptor.connectionStringEnv];
  if (!dsn) reject("PostgreSQL profile credential environment is unavailable");
  try {
    const url = new URL(dsn);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") reject("PostgreSQL profile connection protocol is not allowed");
  } catch (error) {
    if (error instanceof DomainError) throw error;
    reject("PostgreSQL profile connection value is invalid");
  }
  return { profile: descriptor, dsn };
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return { type: "buffer", bytes: value.length };
  if (Array.isArray(value)) return value.slice(0, 128).map((entry) => sanitizeValue(entry, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 128)) out[key] = sanitizeValue(entry, depth + 1);
    return out;
  }
  return String(value).slice(0, MAX_STRING);
}

function boundPayload<T>(payload: T): T {
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (bytes > MAX_OUTPUT_BYTES) reject("PostgreSQL operation result exceeded the output limit");
  return payload;
}

async function withReadOnlyClient<T>(projectRoot: string, profileAlias: string, options: PostgresRunOptions, operation: (client: PgClientLike, profile: PostgresProfile) => Promise<T>): Promise<T> {
  const env = options.env ?? process.env;
  const resolved = await resolveProfile(projectRoot, profileAlias, env);
  const client = (options.clientFactory ?? ((config) => new Client(config) as unknown as PgClientLike))({ connectionString: resolved.dsn, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS });
  let begun = false;
  try {
    await client.connect();
    await client.query("BEGIN TRANSACTION READ ONLY");
    begun = true;
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${IDLE_TX_TIMEOUT_MS}ms'`);
    const tx = await client.query("SHOW transaction_read_only") as { rows: Array<{ transaction_read_only: string }> };
    if (String(tx.rows[0]?.transaction_read_only).toLowerCase() !== "on") reject("PostgreSQL connection did not enter read-only mode");
    const role = await client.query(
      "SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user",
    ) as { rows: Array<{ rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; rolbypassrls: boolean }> };
    const r = role.rows[0];
    if (!r || r.rolsuper || r.rolcreaterole || r.rolcreatedb || r.rolreplication || r.rolbypassrls) reject("PostgreSQL profile role is privileged and is not allowed");
    const result = await operation(client, resolved.profile);
    await client.query("COMMIT");
    begun = false;
    return result;
  } catch (error) {
    if (begun) {
      try { await client.query("ROLLBACK"); } catch { /* best effort */ }
    }
    if (error instanceof DomainError) throw error;
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "PostgreSQL operation failed");
  } finally {
    try { await client.end(); } catch { /* do not expose connection details */ }
  }
}

export function listPostgresProfiles(env: NodeJS.ProcessEnv = process.env): { engine: "postgres"; profiles: string[] } {
  return { engine: "postgres", profiles: parsePostgresProfiles(env).aliases };
}

export async function inspectPostgres(projectRoot: string, profile: string, options: PostgresRunOptions = {}) {
  return withReadOnlyClient(projectRoot, profile, options, async (client, descriptor) => {
    const result = await client.query(
      `SELECT c.table_schema, c.table_name, t.table_type, c.column_name, c.data_type, c.is_nullable
       FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = ANY($1::text[])
       ORDER BY c.table_schema, c.table_name, c.ordinal_position
       LIMIT $2`,
      [descriptor.schemas, MAX_OBJECTS * MAX_COLUMNS_PER_OBJECT + 1],
    ) as { rows: Array<{ table_schema: string; table_name: string; table_type: string; column_name: string; data_type: string; is_nullable: string }> };
    const objects = new Map<string, { schema: string; name: string; type: string; columns: Array<{ name: string; dataType: string; nullable: boolean }> }>();
    let truncated = false;
    for (const row of result.rows) {
      const key = `${row.table_schema}\0${row.table_name}`;
      let object = objects.get(key);
      if (!object) {
        if (objects.size >= MAX_OBJECTS) { truncated = true; break; }
        object = { schema: row.table_schema, name: row.table_name, type: row.table_type, columns: [] };
        objects.set(key, object);
      }
      if (object.columns.length >= MAX_COLUMNS_PER_OBJECT) { truncated = true; continue; }
      object.columns.push({ name: row.column_name, dataType: row.data_type, nullable: row.is_nullable === "YES" });
    }
    return boundPayload({ engine: "postgres" as const, objects: [...objects.values()], truncated });
  });
}

export async function queryPostgres(projectRoot: string, profile: string, sql: string, maxRows = POSTGRES_DEFAULT_MAX_ROWS, options: PostgresRunOptions = {}) {
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > POSTGRES_MAX_ROWS) reject(`maxRows must be an integer between 1 and ${POSTGRES_MAX_ROWS}`);
  const validated = assertSafePostgresReadOnlySql(sql);
  return withReadOnlyClient(projectRoot, profile, options, async (client) => {
    const wrapped = `SELECT * FROM (${validated}) AS _chatgpt2codex_readonly LIMIT ${maxRows + 1}`;
    const result = await client.query({ text: wrapped, rowMode: "array" } as QueryConfig<any[]>) as { rows: unknown[][]; fields: Array<{ name: string }> };
    if (result.fields.length > MAX_COLUMNS) reject("PostgreSQL query returned too many columns");
    const over = result.rows.length > maxRows;
    const rows = (over ? result.rows.slice(0, maxRows) : result.rows).map((row) => row.map((value) => sanitizeValue(value)));
    return boundPayload({
      engine: "postgres" as const,
      columns: result.fields.map((field) => field.name),
      rows,
      truncated: over,
      maxRows,
    });
  });
}
