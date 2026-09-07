import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { invalidProfileValue, parseOperatorProfiles, validateProfileAlias } from "../adapters/profile.js";
import type { OperatorProfileSpec, SafeAdapterDefinition } from "../adapters/types.js";
import { DomainError, ErrorCode } from "../types.js";

export const PYTHON_RUNTIME_PROFILES_ENV = "CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES";

export interface PythonRuntimeProfiles {
  aliases: string[];
  paths: Map<string, string>;
}

function configError(message: string): DomainError {
  return new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Python runtime profile config invalid: ${message}`);
}

export const PYTHON_RUNTIME_PROFILE_SPEC: OperatorProfileSpec<string> = Object.freeze({
  envName: PYTHON_RUNTIME_PROFILES_ENV,
  reservedAliases: ["auto"],
  parseValue(value: unknown): string {
    if (typeof value !== "string") invalidProfileValue("profile values must be executable path strings");
    if (!path.isAbsolute(value)) invalidProfileValue("profile executable paths must be absolute");
    return value;
  },
  configError,
});

export const PYTHON_SAFE_ADAPTER: SafeAdapterDefinition<string> = Object.freeze({
  id: "python",
  description: "Built-in Python runtime adapter",
  profiles: PYTHON_RUNTIME_PROFILE_SPEC,
  operations: Object.freeze({
    execute: Object.freeze({ capabilities: ["write"] as const }),
    notebookExecute: Object.freeze({ capabilities: ["write"] as const }),
  }),
});

export function parsePythonRuntimeProfiles(env: NodeJS.ProcessEnv = process.env): PythonRuntimeProfiles {
  const parsed = parseOperatorProfiles({ env, spec: PYTHON_RUNTIME_PROFILE_SPEC });
  return { aliases: parsed.aliases, paths: parsed.profiles };
}

export async function resolvePythonRuntimeProfile(
  alias: string,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): Promise<string> {
  if (alias === "auto") throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "auto is not an explicit Python runtime profile");
  if (!validateProfileAlias(alias)) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Python runtime profile alias is invalid");
  const profiles = parsePythonRuntimeProfiles(options.env);
  const executable = profiles.paths.get(alias);
  if (!executable) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Python runtime profile '${alias}' is not configured`);
  const st = await fs.lstat(executable).catch(() => null);
  if (!st?.isFile() || st.isSymbolicLink()) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Python runtime profile '${alias}' is unavailable`);
  if ((options.platform ?? process.platform) !== "win32") {
    try { await fs.access(executable, fsConstants.X_OK); }
    catch { throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Python runtime profile '${alias}' is unavailable`); }
  }
  return executable;
}
