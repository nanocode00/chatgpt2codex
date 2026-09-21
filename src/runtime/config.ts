import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type TunnelMode = "none" | "cloudflare";

export interface RuntimeSettings {
  workspace?: string;
  host?: string;
  port?: number;
  publicHostname?: string;
  tunnel?: TunnelMode;
  tunnelName?: string;
}

export interface RuntimeConfigFile {
  version: 1;
  defaults: RuntimeSettings;
  instances: Record<string, RuntimeSettings>;
}

interface RuntimeSecretFile {
  version: 1;
  values: Record<string, string>;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const CONFIG_KEYS = new Set(["workspace", "host", "port", "public-hostname", "tunnel", "tunnel-name"]);

function emptyConfig(): RuntimeConfigFile {
  return { version: 1, defaults: {}, instances: {} };
}

function validateSettings(value: unknown): RuntimeSettings {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("runtime settings must be an object");
  const raw = value as Record<string, unknown>;
  const out: RuntimeSettings = {};
  if (raw.workspace !== undefined) {
    if (typeof raw.workspace !== "string" || !raw.workspace.trim()) throw new Error("workspace must be a non-empty string");
    out.workspace = raw.workspace;
  }
  if (raw.host !== undefined) {
    if (typeof raw.host !== "string" || !raw.host.trim()) throw new Error("host must be a non-empty string");
    out.host = raw.host;
  }
  if (raw.port !== undefined) {
    if (typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) {
      throw new Error("port must be an integer from 1 to 65535");
    }
    out.port = raw.port;
  }
  if (raw.publicHostname !== undefined) {
    if (typeof raw.publicHostname !== "string" || !raw.publicHostname.trim()) {
      throw new Error("publicHostname must be a non-empty string");
    }
    out.publicHostname = raw.publicHostname;
  }
  if (raw.tunnel !== undefined) {
    if (raw.tunnel !== "none" && raw.tunnel !== "cloudflare") throw new Error("tunnel must be none or cloudflare");
    out.tunnel = raw.tunnel;
  }
  if (raw.tunnelName !== undefined) {
    if (typeof raw.tunnelName !== "string" || !raw.tunnelName.trim()) throw new Error("tunnelName must be a non-empty string");
    out.tunnelName = raw.tunnelName;
  }
  return out;
}

function configPath(configDir: string): string {
  return path.join(configDir, "config.json");
}

function runtimeEnvPath(configDir: string): string {
  return path.join(configDir, "runtime.env");
}

function secretsPath(stateDir: string): string {
  return path.join(stateDir, "secrets", "runtime.json");
}

async function atomicWrite(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: FILE_MODE });
  await rename(tmp, filePath);
}

export async function readRuntimeConfig(configDir: string): Promise<RuntimeConfigFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath(configDir), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyConfig();
    throw err;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid c2c config");
  const raw = parsed as Record<string, unknown>;
  if (raw.version !== 1) throw new Error("unsupported c2c config version");
  const defaults = validateSettings(raw.defaults);
  const instancesRaw = raw.instances;
  if (instancesRaw !== undefined && (!instancesRaw || typeof instancesRaw !== "object" || Array.isArray(instancesRaw))) {
    throw new Error("instances must be an object");
  }
  const instances: Record<string, RuntimeSettings> = {};
  for (const [name, settings] of Object.entries((instancesRaw ?? {}) as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new Error("invalid instance name in config: " + name);
    instances[name] = validateSettings(settings);
  }
  return { version: 1, defaults, instances };
}

export async function writeRuntimeConfig(configDir: string, config: RuntimeConfigFile): Promise<void> {
  const normalized: RuntimeConfigFile = {
    version: 1,
    defaults: validateSettings(config.defaults),
    instances: {},
  };
  for (const [name, settings] of Object.entries(config.instances)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new Error("invalid instance name in config: " + name);
    normalized.instances[name] = validateSettings(settings);
  }
  await atomicWrite(configPath(configDir), normalized);
}

function parseConfigValue(key: string, value: string): keyof RuntimeSettings | [keyof RuntimeSettings, string | number] {
  switch (key) {
    case "workspace": return ["workspace", value];
    case "host": return ["host", value];
    case "port": {
      const port = Number.parseInt(value, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be an integer from 1 to 65535");
      return ["port", port];
    }
    case "public-hostname": return ["publicHostname", value];
    case "tunnel":
      if (value !== "none" && value !== "cloudflare") throw new Error("tunnel must be none or cloudflare");
      return ["tunnel", value];
    case "tunnel-name": return ["tunnelName", value];
    default:
      throw new Error("unknown config key: " + key + " (expected " + [...CONFIG_KEYS].join(", ") + ")");
  }
}

export async function setRuntimeConfigValue(
  configDir: string,
  key: string,
  value: string,
  instance?: string,
): Promise<RuntimeConfigFile> {
  const config = await readRuntimeConfig(configDir);
  const parsed = parseConfigValue(key, value);
  if (!Array.isArray(parsed)) throw new Error("invalid config value");
  const [field, typedValue] = parsed;
  const target = instance ? (config.instances[instance] ??= {}) : config.defaults;
  (target as Record<string, unknown>)[field] = typedValue;
  await writeRuntimeConfig(configDir, config);
  return config;
}

export async function unsetRuntimeConfigValue(
  configDir: string,
  key: string,
  instance?: string,
): Promise<RuntimeConfigFile> {
  const config = await readRuntimeConfig(configDir);
  const parsed = parseConfigValue(key, key === "port" ? "1" : key === "tunnel" ? "none" : "_");
  if (!Array.isArray(parsed)) throw new Error("invalid config key");
  const [field] = parsed;
  const target = instance ? config.instances[instance] : config.defaults;
  if (target) delete (target as Record<string, unknown>)[field];
  if (instance && target && Object.keys(target).length === 0) delete config.instances[instance];
  await writeRuntimeConfig(configDir, config);
  return config;
}

export function resolveRuntimeSettings(
  config: RuntimeConfigFile,
  instance: string,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeSettings {
  const merged: RuntimeSettings = { ...config.defaults, ...(config.instances[instance] ?? {}) };
  if (env.WORKSPACE?.trim()) merged.workspace = env.WORKSPACE.trim();
  if (env.CHATGPT2CODEX_HOST?.trim()) merged.host = env.CHATGPT2CODEX_HOST.trim();
  if (env.PORT?.trim()) {
    const port = Number.parseInt(env.PORT, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535");
    merged.port = port;
  }
  if (env.PUBLIC_HOSTNAME?.trim()) merged.publicHostname = env.PUBLIC_HOSTNAME.trim();
  if (env.CLOUDFLARED_TUNNEL_NAME?.trim()) merged.tunnelName = env.CLOUDFLARED_TUNNEL_NAME.trim();
  if (
    env.CHATGPT2CODEX_EXPOSE_WEB === "1" ||
    Boolean(env.PUBLIC_HOSTNAME?.trim()) ||
    Boolean(env.CLOUDFLARED_TUNNEL_NAME?.trim()) ||
    Boolean(env.CLOUDFLARED_TUNNEL_TOKEN?.trim())
  ) {
    merged.tunnel = "cloudflare";
  }
  return merged;
}

export function settingsFromEnvironment(env: NodeJS.ProcessEnv = process.env): RuntimeSettings {
  const config: RuntimeConfigFile = emptyConfig();
  return resolveRuntimeSettings(config, "default", env);
}

export function resolveRuntimeSettingsWithLegacy(
  config: RuntimeConfigFile,
  instance: string,
  legacyEnv: NodeJS.ProcessEnv,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeSettings {
  const legacy = settingsFromEnvironment(legacyEnv);
  return resolveRuntimeSettings(
    {
      version: 1,
      defaults: { ...legacy, ...config.defaults },
      instances: config.instances,
    },
    instance,
    env,
  );
}

function parseRuntimeEnvValue(raw: string, lineNumber: number): string {
  const value = raw.trim();
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new Error("runtime.env line " + lineNumber + ": unterminated single-quoted value");
    }
    return value.slice(1, -1);
  }
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) {
      throw new Error("runtime.env line " + lineNumber + ": unterminated double-quoted value");
    }
    return value.slice(1, -1).replace(/\\(["\\$])/g, "$1");
  }
  return value;
}

export interface ParsedRuntimeEnvFile {
  values: Record<string, string>;
  unset: string[];
}

export function parseRuntimeEnvFile(content: string): ParsedRuntimeEnvFile {
  const values: Record<string, string> = {};
  const unset = new Set<string>();
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    let line = (lines[index] ?? "").trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "set -a" || line === "set +a") continue;
    const unsetMatch = /^unset\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(line);
    if (unsetMatch) {
      const name = unsetMatch[1]!;
      delete values[name];
      unset.add(name);
      continue;
    }
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      throw new Error(
        "runtime.env line " + (index + 1) + ": expected NAME=value; shell commands are not executed",
      );
    }
    const startLine = index + 1;
    let rawValue = match[2] ?? "";
    const first = rawValue.trimStart()[0];
    if (first === "'" || first === '"') {
      const trimmed = rawValue.trim();
      if (!(trimmed.length >= 2 && trimmed.endsWith(first))) {
        let closed = false;
        while (index + 1 < lines.length) {
          index += 1;
          rawValue += "\n" + (lines[index] ?? "");
          if (rawValue.trimEnd().endsWith(first)) {
            closed = true;
            break;
          }
        }
        if (!closed) {
          throw new Error(
            "runtime.env line " + startLine + ": unterminated quoted value",
          );
        }
      }
    }
    const name = match[1]!;
    values[name] = parseRuntimeEnvValue(rawValue, startLine);
    unset.delete(name);
  }
  return { values, unset: [...unset].sort() };
}

export async function loadRuntimeEnvironment(
  configDir: string,
  base: NodeJS.ProcessEnv = process.env,
): Promise<{
  env: NodeJS.ProcessEnv;
  fileEnv: NodeJS.ProcessEnv;
  runtimeEnvPath: string;
  loaded: string[];
  unset: string[];
}> {
  const filePath = runtimeEnvPath(configDir);
  let parsed: ParsedRuntimeEnvFile = { values: {}, unset: [] };
  try {
    parsed = parseRuntimeEnvFile(await readFile(filePath, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const env: NodeJS.ProcessEnv = { ...parsed.values, ...base };
  for (const name of parsed.unset) delete env[name];
  return {
    env,
    fileEnv: parsed.values,
    runtimeEnvPath: filePath,
    loaded: Object.keys(parsed.values).sort(),
    unset: parsed.unset,
  };
}

export function normalizeSecretName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(normalized)) {
    throw new Error("secret name must match /^[a-z0-9][a-z0-9_.-]{0,63}$/");
  }
  return normalized;
}

async function readSecretFile(stateDir: string): Promise<RuntimeSecretFile> {
  try {
    const raw = JSON.parse(await readFile(secretsPath(stateDir), "utf8")) as Partial<RuntimeSecretFile>;
    if (raw.version !== 1 || !raw.values || typeof raw.values !== "object" || Array.isArray(raw.values)) {
      throw new Error("invalid c2c runtime secret store");
    }
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw.values)) {
      if (typeof value !== "string") throw new Error("invalid c2c runtime secret value");
      values[normalizeSecretName(name)] = value;
    }
    return { version: 1, values };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, values: {} };
    throw err;
  }
}

export async function setRuntimeSecret(stateDir: string, name: string, value: string): Promise<void> {
  const normalized = normalizeSecretName(name);
  if (!value) throw new Error("secret value must not be empty");
  const file = await readSecretFile(stateDir);
  file.values[normalized] = value;
  await atomicWrite(secretsPath(stateDir), file);
}

export async function getRuntimeSecret(stateDir: string, name: string): Promise<string | undefined> {
  const file = await readSecretFile(stateDir);
  return file.values[normalizeSecretName(name)];
}

export async function listRuntimeSecrets(stateDir: string): Promise<string[]> {
  const file = await readSecretFile(stateDir);
  return Object.keys(file.values).sort();
}

export async function removeRuntimeSecret(stateDir: string, name: string): Promise<boolean> {
  const file = await readSecretFile(stateDir);
  const normalized = normalizeSecretName(name);
  if (!(normalized in file.values)) return false;
  delete file.values[normalized];
  if (Object.keys(file.values).length === 0) {
    await unlink(secretsPath(stateDir)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
  } else {
    await atomicWrite(secretsPath(stateDir), file);
  }
  return true;
}
