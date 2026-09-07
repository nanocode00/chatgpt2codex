import path from "node:path";
import { invalidProfileValue, parseOperatorProfiles } from "../adapters/profile.js";
import type { OperatorProfileSpec, SafeAdapterDefinition } from "../adapters/types.js";
import { DomainError, ErrorCode } from "../types.js";

export const SQLITE_PROFILES_ENV = "CHATGPT2CODEX_SQLITE_PROFILES";

export interface SQLiteProfile {
  path: string;
}

function configError(message: string): DomainError {
  return new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `SQLite profile config invalid: ${message}`);
}

export const SQLITE_PROFILE_SPEC: OperatorProfileSpec<SQLiteProfile> = Object.freeze({
  envName: SQLITE_PROFILES_ENV,
  parseValue(value: unknown): SQLiteProfile {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalidProfileValue("profile value must be an object");
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length !== 1 || keys[0] !== "path") invalidProfileValue("profile value must contain only path");
    const rawPath = (value as { path?: unknown }).path;
    if (typeof rawPath !== "string" || rawPath.length === 0) invalidProfileValue("profile path must be a non-empty string");
    if (rawPath.includes("\0")) invalidProfileValue("profile path contains a null byte");
    if (path.isAbsolute(rawPath) || path.win32.isAbsolute(rawPath)) invalidProfileValue("profile path must be project-relative");
    const portablePath = rawPath.replaceAll("\\", "/");
    if (portablePath.split("/").includes("..")) invalidProfileValue("profile path must not contain traversal segments");
    const normalized = path.posix.normalize(portablePath);
    if (normalized === ".." || normalized.startsWith("../") || normalized === ".") invalidProfileValue("profile path must stay within the project");
    return { path: rawPath };
  },
  configError,
});

export const SQLITE_SAFE_ADAPTER: SafeAdapterDefinition<SQLiteProfile> = Object.freeze({
  id: "sqlite",
  description: "Built-in read-only SQLite adapter",
  profiles: SQLITE_PROFILE_SPEC,
  operations: Object.freeze({
    profiles: Object.freeze({ capabilities: ["read"] as const }),
    inspect: Object.freeze({ capabilities: ["read"] as const }),
    query: Object.freeze({ capabilities: ["read"] as const }),
  }),
});

export function parseSQLiteProfiles(env: NodeJS.ProcessEnv = process.env) {
  return parseOperatorProfiles({ env, spec: SQLITE_PROFILE_SPEC });
}
