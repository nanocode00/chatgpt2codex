import { inspectSQLite, listSQLiteProfiles, querySQLite, SQLITE_DEFAULT_MAX_ROWS, SQLITE_MAX_ROWS } from "../database/sqlite.js";
import { parsePythonRuntimeProfiles } from "../python/runtime-profiles.js";
import { DomainError, ErrorCode, type ToolContext } from "../types.js";
import { invokeSafeAdapterOperation } from "./operation-invoke.js";
import { SafeAdapterOperationRegistry } from "./operation-registry.js";
import type { SafeAdapterOperationDefinition } from "./operation-types.js";

function reject(message: string): never {
  throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, message);
}

function strictKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) reject("Safe adapter operation arguments contain unexpected fields");
}

function requiredString(value: unknown, name: string, maxLength = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) reject(`Safe adapter operation argument ${name} is invalid`);
  return value;
}

const BUILT_IN_OPERATIONS = [
  {
    id: "python.profiles",
    adapterId: "python",
    description: "List operator-configured Python runtime profile aliases without exposing executable paths.",
    capability: "read",
    input: Object.freeze([]),
    validateInput(value) {
      strictKeys(value, []);
      return {};
    },
    handler() {
      return { profiles: parsePythonRuntimeProfiles().aliases };
    },
  },
  {
    id: "sqlite.profiles",
    adapterId: "sqlite",
    description: "List operator-configured SQLite profile aliases without exposing database paths.",
    capability: "read",
    input: Object.freeze([]),
    validateInput(value) {
      strictKeys(value, []);
      return {};
    },
    handler() {
      return listSQLiteProfiles();
    },
  },
  {
    id: "sqlite.inspect",
    adapterId: "sqlite",
    description: "Inspect bounded SQLite user table/view and column metadata using a configured profile.",
    capability: "read",
    input: Object.freeze([{ name: "profile", type: "string", required: true, maxLength: 64 }]),
    validateInput(value) {
      strictKeys(value, ["profile"]);
      return { profile: requiredString(value.profile, "profile", 64) };
    },
    handler(context, input) {
      return inspectSQLite(context.projectRoot, input.profile as string);
    },
  },
  {
    id: "sqlite.query",
    adapterId: "sqlite",
    description: "Run one bounded read-only SQLite query using a configured profile.",
    capability: "read",
    input: Object.freeze([
      { name: "profile", type: "string", required: true, maxLength: 64 },
      { name: "sql", type: "string", required: true, maxLength: 65536 },
      { name: "maxRows", type: "integer", required: false, min: 1, max: SQLITE_MAX_ROWS },
    ]),
    validateInput(value) {
      strictKeys(value, ["profile", "sql", "maxRows"]);
      const profile = requiredString(value.profile, "profile", 64);
      const sql = requiredString(value.sql, "sql", 65536);
      const maxRows = value.maxRows === undefined ? SQLITE_DEFAULT_MAX_ROWS : value.maxRows;
      if (!Number.isInteger(maxRows) || Number(maxRows) < 1 || Number(maxRows) > SQLITE_MAX_ROWS) reject("Safe adapter operation argument maxRows is invalid");
      return { profile, sql, maxRows: Number(maxRows) };
    },
    handler(context, input) {
      return querySQLite(context.projectRoot, input.profile as string, input.sql as string, input.maxRows as number);
    },
  },
] satisfies SafeAdapterOperationDefinition[];
Object.freeze(BUILT_IN_OPERATIONS);

export const builtInSafeAdapterOperationRegistry = new SafeAdapterOperationRegistry(BUILT_IN_OPERATIONS);

export async function invokeBuiltInSafeAdapterOperation(
  ctx: ToolContext,
  projectId: string,
  operationId: string,
  argumentsValue: Record<string, unknown>,
): Promise<{ operation: string; result: unknown }> {
  return invokeSafeAdapterOperation(ctx, builtInSafeAdapterOperationRegistry, projectId, operationId, argumentsValue);
}
