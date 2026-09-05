import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";

export const PYTHON_RUNTIME_PROFILES_ENV = "CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES";
const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface PythonRuntimeProfiles {
  aliases: string[];
  paths: Map<string, string>;
}

function configError(message: string): DomainError {
  return new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Python runtime profile config invalid: ${message}`);
}

export function parsePythonRuntimeProfiles(env: NodeJS.ProcessEnv = process.env): PythonRuntimeProfiles {
  const raw = env[PYTHON_RUNTIME_PROFILES_ENV];
  if (!raw?.trim()) return { aliases: [], paths: new Map() };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw configError("expected a JSON object");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw configError("expected a JSON object");
  const paths = new Map<string, string>();
  for (const [alias, executable] of Object.entries(value as Record<string, unknown>)) {
    if (!ALIAS_RE.test(alias) || alias === "auto" || alias.includes("..")) throw configError("contains an invalid profile alias");
    if (typeof executable !== "string") throw configError("profile values must be executable path strings");
    if (!path.isAbsolute(executable)) throw configError("profile executable paths must be absolute");
    paths.set(alias, executable);
  }
  return { aliases: [...paths.keys()].sort(), paths };
}

export async function resolvePythonRuntimeProfile(
  alias: string,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): Promise<string> {
  if (alias === "auto") throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "auto is not an explicit Python runtime profile");
  if (!ALIAS_RE.test(alias) || alias.includes("..")) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Python runtime profile alias is invalid");
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
