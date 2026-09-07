import { promises as fs } from "node:fs";
import { Worker } from "node:worker_threads";
import { resolveInProject } from "../policy/paths.js";
import { isSecretPath } from "../policy/secrets.js";
import { DomainError, ErrorCode } from "../types.js";
import { validateProfileAlias } from "../adapters/profile.js";
import { assertSafeReadOnlySql } from "./sql-guard.js";
import { parseSQLiteProfiles } from "./sqlite-profiles.js";

export const SQLITE_DEFAULT_MAX_ROWS = 100;
export const SQLITE_MAX_ROWS = 200;
export const SQLITE_QUERY_TIMEOUT_MS = 5_000;
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 18;

export interface SQLiteRunOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function sqliteUnavailable(): never {
  throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "SQLite adapter unavailable on this Node runtime");
}

export function assertSQLiteRuntime(version = process.versions.node): void {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number(part));
  if (major < MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor < MIN_NODE_MINOR)) sqliteUnavailable();
}

async function resolveDatabasePath(projectRoot: string, profile: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (!validateProfileAlias(profile)) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "SQLite profile alias is invalid");
  }
  const profiles = parseSQLiteProfiles(env);
  const descriptor = profiles.profiles.get(profile);
  if (!descriptor) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "SQLite profile is not configured");

  let abs: string;
  try {
    abs = await resolveInProject(projectRoot, descriptor.path, { allowSymlink: false, rejectRoot: true });
  } catch {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "SQLite profile database path is not accessible");
  }
  if (isSecretPath(abs)) {
    throw new DomainError(ErrorCode.SECRET_BLOCKED, "SQLite profile database path is secret-classified");
  }
  try {
    const stat = await fs.lstat(abs);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("invalid type");
  } catch {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "SQLite profile database must be an existing regular file");
  }
  return abs;
}

function workerUrl(): URL {
  const sourceMode = import.meta.url.endsWith(".ts");
  return new URL(sourceMode ? "./sqlite-worker.ts" : "./sqlite-worker.js", import.meta.url);
}

async function runWorker(
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  assertSQLiteRuntime();
  const sourceMode = import.meta.url.endsWith(".ts");
  const worker = new Worker(workerUrl(), {
    workerData: payload,
    ...(sourceMode ? { execArgv: ["--import", "tsx"] } : {}),
  });

  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        void worker.terminate();
        reject(new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "SQLite query timed out"));
      });
    }, timeoutMs);
    worker.once("message", (message: { ok?: boolean; value?: unknown; code?: string }) => {
      finish(() => {
        void worker.terminate();
        if (message?.ok) resolve(message.value);
        else if (message?.code === "TOO_MANY_COLUMNS") reject(new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "SQLite query returned too many columns"));
        else if (message?.code?.startsWith("SCHEMA_")) reject(new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "SQLite schema inspection failed"));
        else reject(new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "SQLite operation failed"));
      });
    });
    worker.once("error", () => finish(() => reject(new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "SQLite operation failed"))));
    worker.once("exit", (code) => {
      if (code !== 0) finish(() => reject(new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "SQLite operation failed")));
    });
  });
}

export function listSQLiteProfiles(env: NodeJS.ProcessEnv = process.env): { engine: "sqlite"; profiles: string[] } {
  assertSQLiteRuntime();
  const profiles = parseSQLiteProfiles(env);
  return { engine: "sqlite", profiles: profiles.aliases };
}

export async function inspectSQLite(
  projectRoot: string,
  profile: string,
  options: SQLiteRunOptions = {},
): Promise<{ engine: "sqlite"; objects: unknown[]; truncated: boolean }> {
  const env = options.env ?? process.env;
  const dbPath = await resolveDatabasePath(projectRoot, profile, env);
  const result = await runWorker({ mode: "inspect", dbPath }, options.timeoutMs ?? SQLITE_QUERY_TIMEOUT_MS) as { objects?: unknown[]; truncated?: boolean };
  return { engine: "sqlite", objects: Array.isArray(result.objects) ? result.objects : [], truncated: result.truncated === true };
}

export async function querySQLite(
  projectRoot: string,
  profile: string,
  sql: string,
  maxRows = SQLITE_DEFAULT_MAX_ROWS,
  options: SQLiteRunOptions = {},
): Promise<{ engine: "sqlite"; rows: unknown[]; truncated: boolean; maxRows: number }> {
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > SQLITE_MAX_ROWS) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `maxRows must be an integer between 1 and ${SQLITE_MAX_ROWS}`);
  }
  assertSafeReadOnlySql(sql);
  const env = options.env ?? process.env;
  const dbPath = await resolveDatabasePath(projectRoot, profile, env);
  const result = await runWorker(
    { mode: "query", dbPath, sql, maxRows: maxRows + 1 },
    options.timeoutMs ?? SQLITE_QUERY_TIMEOUT_MS,
  ) as { rows?: unknown[]; truncated?: boolean };
  const fetched = Array.isArray(result.rows) ? result.rows : [];
  const overLimit = fetched.length > maxRows;
  return {
    engine: "sqlite",
    rows: overLimit ? fetched.slice(0, maxRows) : fetched,
    truncated: overLimit || result.truncated === true,
    maxRows,
  };
}
