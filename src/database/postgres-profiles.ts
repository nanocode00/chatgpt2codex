import path from "node:path";
import { invalidProfileValue, parseOperatorProfiles } from "../adapters/profile.js";
import type { OperatorProfileSpec, SafeAdapterDefinition } from "../adapters/types.js";
import { DomainError, ErrorCode } from "../types.js";

export const POSTGRES_PROFILES_ENV = "CHATGPT2CODEX_POSTGRES_PROFILES";
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const SCHEMA_RE = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

export interface PostgresProfile {
  projectRoot: string;
  connectionStringEnv: string;
  schemas: string[];
}

function configError(message: string): DomainError {
  return new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `PostgreSQL profile config invalid: ${message}`);
}

function validSchema(schema: string): boolean {
  const lower = schema.toLowerCase();
  return SCHEMA_RE.test(schema) && !lower.startsWith("pg_") && lower !== "information_schema";
}

export const POSTGRES_PROFILE_SPEC: OperatorProfileSpec<PostgresProfile> = Object.freeze({
  envName: POSTGRES_PROFILES_ENV,
  parseValue(value: unknown): PostgresProfile {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalidProfileValue("profile value must be an object");
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.some((key) => !["projectRoot", "connectionStringEnv", "schemas"].includes(key))) invalidProfileValue("profile value contains unexpected fields");
    if (typeof record.projectRoot !== "string" || !path.isAbsolute(record.projectRoot) || record.projectRoot.includes("\0")) {
      invalidProfileValue("projectRoot must be an absolute path");
    }
    if (typeof record.connectionStringEnv !== "string" || !ENV_NAME_RE.test(record.connectionStringEnv)) {
      invalidProfileValue("connectionStringEnv is invalid");
    }
    const schemas = record.schemas === undefined ? ["public"] : record.schemas;
    if (!Array.isArray(schemas) || schemas.length === 0 || schemas.length > 16 || schemas.some((schema) => typeof schema !== "string" || !validSchema(schema))) {
      invalidProfileValue("schemas must contain only allowlisted user schema names");
    }
    if (new Set(schemas.map((schema) => schema.toLowerCase())).size !== schemas.length) invalidProfileValue("schemas must not contain duplicates");
    return { projectRoot: record.projectRoot, connectionStringEnv: record.connectionStringEnv, schemas: [...schemas] as string[] };
  },
  configError,
});

export const POSTGRES_SAFE_ADAPTER: SafeAdapterDefinition<PostgresProfile> = Object.freeze({
  id: "postgres",
  description: "Built-in read-only PostgreSQL adapter",
  profiles: POSTGRES_PROFILE_SPEC,
  operations: Object.freeze({
    profiles: Object.freeze({ capabilities: ["read"] as const }),
    inspect: Object.freeze({ capabilities: ["read"] as const }),
    query: Object.freeze({ capabilities: ["read"] as const }),
  }),
});

export function parsePostgresProfiles(env: NodeJS.ProcessEnv = process.env) {
  return parseOperatorProfiles({ env, spec: POSTGRES_PROFILE_SPEC });
}
