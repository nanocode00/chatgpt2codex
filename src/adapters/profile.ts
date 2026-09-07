import type { OperatorProfileSet, OperatorProfileSpec } from "./types.js";

const PROFILE_ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface ProfileAliasOptions {
  reserved?: readonly string[];
}

export class ProfileValueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileValueValidationError";
  }
}

export function invalidProfileValue(message: string): never {
  throw new ProfileValueValidationError(message);
}

export function validateProfileAlias(alias: string, options: ProfileAliasOptions = {}): boolean {
  if (!PROFILE_ALIAS_RE.test(alias) || alias.includes("..")) return false;
  return !(options.reserved ?? []).includes(alias);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function parseOperatorProfiles<T>(options: {
  env?: NodeJS.ProcessEnv;
  spec: OperatorProfileSpec<T>;
}): OperatorProfileSet<T> {
  const env = options.env ?? process.env;
  const raw = env[options.spec.envName];
  if (!raw?.trim()) return { aliases: [], profiles: new Map() };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw options.spec.configError("expected a JSON object");
  }
  if (!isPlainObject(parsed)) throw options.spec.configError("expected a JSON object");

  const profiles = new Map<string, T>();
  for (const [alias, rawValue] of Object.entries(parsed)) {
    if (!validateProfileAlias(alias, { reserved: options.spec.reservedAliases })) {
      throw options.spec.configError("contains an invalid profile alias");
    }
    try {
      profiles.set(alias, options.spec.parseValue(rawValue));
    } catch (error) {
      if (error instanceof ProfileValueValidationError) {
        throw options.spec.configError(error.message);
      }
      throw options.spec.configError("contains an invalid profile value");
    }
  }

  return { aliases: [...profiles.keys()].sort(), profiles };
}
