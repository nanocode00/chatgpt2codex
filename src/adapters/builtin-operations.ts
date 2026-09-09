import { inspectSQLite, listSQLiteProfiles, querySQLite, SQLITE_DEFAULT_MAX_ROWS, SQLITE_MAX_ROWS } from "../database/sqlite.js";
import { dockerLogs, dockerStart, dockerStatus, dockerStop, listDockerProfiles, DOCKER_LOG_DEFAULT_LINES, DOCKER_LOG_MAX_LINES } from "../docker/docker.js";
import { executeNotebook, validateNotebook } from "../notebook/notebook.js";
import { inspectNpmProject, installNpmDependencies, NPM_MAX_PACKAGE_SPEC_LENGTH, NPM_MAX_PACKAGES, removeNpmDependencies } from "../npm/npm-dependencies.js";
import { executePythonScript } from "../python/python-execute.js";
import { parsePythonRuntimeProfiles } from "../python/runtime-profiles.js";
import { assertRemoteExecAllowed } from "../server/remote-safety.js";
import { DomainError, ErrorCode, type ToolContext } from "../types.js";
import { catalogSafeAdapterOperations, invokeSafeAdapterOperation } from "./operation-invoke.js";
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
    id: "npm.inspect",
    adapterId: "npm",
    description: "Inspect bounded npm dependency metadata for the selected project without exposing scripts, paths, config, or credentials.",
    capability: "read",
    availability: "always",
    input: Object.freeze([]),
    validateInput(value) {
      strictKeys(value, []);
      return {};
    },
    handler(context) {
      return inspectNpmProject(context.projectRoot);
    },
  },
  {
    id: "npm.install",
    adapterId: "npm",
    description: "Install validated npm registry dependencies in the selected project with lifecycle scripts disabled and fixed server-owned arguments.",
    capability: "write",
    availability: "remote-exec",
    input: Object.freeze([
      { name: "packages", type: "array", required: true, minItems: 1, maxItems: NPM_MAX_PACKAGES, itemType: "string", itemMaxLength: NPM_MAX_PACKAGE_SPEC_LENGTH },
      { name: "dev", type: "boolean", required: true },
    ]),
    validateInput(value) {
      strictKeys(value, ["packages", "dev"]);
      if (typeof value.dev !== "boolean") reject("Safe adapter operation argument dev is invalid");
      if (!Array.isArray(value.packages)) reject("Safe adapter operation argument packages is invalid");
      return { packages: value.packages, dev: value.dev };
    },
    handler(context, input) {
      assertRemoteExecAllowed(context.ctx, "npm_install");
      return installNpmDependencies(context.projectRoot, input.packages, input.dev as boolean);
    },
  },
  {
    id: "npm.remove",
    adapterId: "npm",
    description: "Remove validated npm registry dependencies from the selected project with lifecycle scripts disabled and fixed server-owned arguments.",
    capability: "write",
    availability: "remote-exec",
    input: Object.freeze([
      { name: "packages", type: "array", required: true, minItems: 1, maxItems: NPM_MAX_PACKAGES, itemType: "string", itemMaxLength: NPM_MAX_PACKAGE_SPEC_LENGTH },
    ]),
    validateInput(value) {
      strictKeys(value, ["packages"]);
      if (!Array.isArray(value.packages)) reject("Safe adapter operation argument packages is invalid");
      return { packages: value.packages };
    },
    handler(context, input) {
      assertRemoteExecAllowed(context.ctx, "npm_remove");
      return removeNpmDependencies(context.projectRoot, input.packages);
    },
  },
  {
    id: "docker.profiles",
    adapterId: "docker",
    description: "List operator-configured Docker profile aliases without exposing compose paths or service configuration.",
    capability: "read",
    input: Object.freeze([]),
    validateInput(value) {
      strictKeys(value, []);
      return {};
    },
    handler() {
      return listDockerProfiles();
    },
  },
  {
    id: "docker.status",
    adapterId: "docker",
    description: "Read bounded sanitized Docker Compose service status for an operator-configured profile.",
    capability: "read",
    input: Object.freeze([
      { name: "profile", type: "string", required: true, maxLength: 64 },
      { name: "service", type: "string", required: false, maxLength: 128 },
    ]),
    validateInput(value) {
      strictKeys(value, ["profile", "service"]);
      const profile = requiredString(value.profile, "profile", 64);
      const service = value.service === undefined ? undefined : requiredString(value.service, "service", 128);
      return { profile, service };
    },
    handler(context, input) {
      return dockerStatus(context.projectRoot, input.profile as string, input.service as string | undefined);
    },
  },
  {
    id: "docker.logs",
    adapterId: "docker",
    description: "Read bounded redacted Docker Compose logs for one allowlisted service.",
    capability: "read",
    input: Object.freeze([
      { name: "profile", type: "string", required: true, maxLength: 64 },
      { name: "service", type: "string", required: true, maxLength: 128 },
      { name: "lines", type: "integer", required: false, min: 1, max: DOCKER_LOG_MAX_LINES },
    ]),
    validateInput(value) {
      strictKeys(value, ["profile", "service", "lines"]);
      const profile = requiredString(value.profile, "profile", 64);
      const service = requiredString(value.service, "service", 128);
      const lines = value.lines === undefined ? DOCKER_LOG_DEFAULT_LINES : value.lines;
      if (!Number.isInteger(lines) || Number(lines) < 1 || Number(lines) > DOCKER_LOG_MAX_LINES) reject("Safe adapter operation argument lines is invalid");
      return { profile, service, lines: Number(lines) };
    },
    handler(context, input) {
      return dockerLogs(context.projectRoot, input.profile as string, input.service as string, input.lines as number);
    },
  },
  {
    id: "docker.start",
    adapterId: "docker",
    description: "Start one existing operator-allowlisted Docker Compose service container without creating, building, pulling, or recreating.",
    capability: "write",
    availability: "remote-exec",
    input: Object.freeze([
      { name: "profile", type: "string", required: true, maxLength: 64 },
      { name: "service", type: "string", required: true, maxLength: 128 },
    ]),
    validateInput(value) {
      strictKeys(value, ["profile", "service"]);
      return {
        profile: requiredString(value.profile, "profile", 64),
        service: requiredString(value.service, "service", 128),
      };
    },
    handler(context, input) {
      assertRemoteExecAllowed(context.ctx, "docker_start");
      return dockerStart(context.projectRoot, input.profile as string, input.service as string);
    },
  },
  {
    id: "docker.stop",
    adapterId: "docker",
    description: "Stop one existing operator-allowlisted Docker Compose service container with a fixed graceful timeout.",
    capability: "write",
    availability: "remote-exec",
    input: Object.freeze([
      { name: "profile", type: "string", required: true, maxLength: 64 },
      { name: "service", type: "string", required: true, maxLength: 128 },
    ]),
    validateInput(value) {
      strictKeys(value, ["profile", "service"]);
      return {
        profile: requiredString(value.profile, "profile", 64),
        service: requiredString(value.service, "service", 128),
      };
    },
    handler(context, input) {
      assertRemoteExecAllowed(context.ctx, "docker_stop");
      return dockerStop(context.projectRoot, input.profile as string, input.service as string);
    },
  },
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
    id: "python.execute",
    adapterId: "python",
    description: "Execute a project-confined Python script with trusted runtime discovery or an operator runtime profile alias.",
    capability: "write",
    availability: "remote-exec",
    input: Object.freeze([
      { name: "path", type: "string", required: true, maxLength: 4096 },
      { name: "runtimeProfile", type: "string", required: false, maxLength: 64 },
    ]),
    validateInput(value) {
      strictKeys(value, ["path", "runtimeProfile"]);
      const path = requiredString(value.path, "path", 4096);
      const runtimeProfile = value.runtimeProfile === undefined ? undefined : requiredString(value.runtimeProfile, "runtimeProfile", 64);
      return { path, runtimeProfile };
    },
    handler(context, input) {
      assertRemoteExecAllowed(context.ctx, "python_execute");
      return executePythonScript(context.projectRoot, input.path as string, input.runtimeProfile as string | undefined);
    },
  },
  {
    id: "notebook.validate",
    adapterId: "notebook",
    description: "Statically validate a project-confined Jupyter notebook without executing cells.",
    capability: "read",
    availability: "always",
    input: Object.freeze([{ name: "path", type: "string", required: true, maxLength: 4096 }]),
    validateInput(value) {
      strictKeys(value, ["path"]);
      return { path: requiredString(value.path, "path", 4096) };
    },
    handler(context, input) {
      return validateNotebook(context.projectRoot, input.path as string);
    },
  },
  {
    id: "notebook.execute",
    adapterId: "notebook",
    description: "Execute a project-confined Jupyter notebook with trusted runtime discovery or an operator runtime profile alias.",
    capability: "write",
    availability: "remote-exec",
    input: Object.freeze([
      { name: "path", type: "string", required: true, maxLength: 4096 },
      { name: "runtimeProfile", type: "string", required: false, maxLength: 64 },
    ]),
    validateInput(value) {
      strictKeys(value, ["path", "runtimeProfile"]);
      const path = requiredString(value.path, "path", 4096);
      const runtimeProfile = value.runtimeProfile === undefined ? undefined : requiredString(value.runtimeProfile, "runtimeProfile", 64);
      return { path, runtimeProfile };
    },
    handler(context, input) {
      assertRemoteExecAllowed(context.ctx, "notebook_execute");
      return executeNotebook(context.projectRoot, input.path as string, { runtimeProfile: input.runtimeProfile as string | undefined });
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

export function catalogBuiltInSafeAdapterOperations(ctx: ToolContext) {
  return catalogSafeAdapterOperations(ctx, builtInSafeAdapterOperationRegistry);
}
