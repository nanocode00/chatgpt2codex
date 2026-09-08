import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { buildSafeChildEnv } from "../exec/command-runner.js";
import { resolveInProject } from "../policy/paths.js";
import { isSecretPath, redact } from "../policy/secrets.js";
import { DomainError, ErrorCode } from "../types.js";

export const DOCKER_PROFILES_ENV = "CHATGPT2CODEX_DOCKER_PROFILES";
export const DOCKER_LOG_DEFAULT_LINES = 100;
export const DOCKER_LOG_MAX_LINES = 500;
export const DOCKER_OUTPUT_MAX_BYTES = 64 * 1024;
export const DOCKER_STOP_TIMEOUT_SECONDS = 10;
export const DOCKER_CONTROL_EXEC_TIMEOUT_MS = 20_000;
export const TRUSTED_LOCAL_DOCKER_HOST = process.platform === "win32"
  ? "npipe:////./pipe/docker_engine"
  : "unix:///var/run/docker.sock";

interface DockerProfileConfig {
  composeFile: string;
  projectName: string;
  services: readonly string[];
  controlServices: readonly string[];
}

interface ResolvedDockerProfile extends DockerProfileConfig {
  composePath: string;
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

type DockerExec = (file: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; shell: false; windowsHide: true; maxBuffer: number; timeout?: number }) => Promise<ExecResult>;

const execFileAsync = promisify(execFile);
const defaultDockerExec: DockerExec = async (file, args, options) => {
  const result = await execFileAsync(file, [...args], { ...options, encoding: "utf8" });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};
let dockerExec: DockerExec = defaultDockerExec;

/** Test seam only: production always uses node:child_process execFile. */
export function setDockerExecForTests(value?: DockerExec): void {
  dockerExec = value ?? defaultDockerExec;
}

function reject(message: string): never {
  throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, message);
}

function parseProfiles(): ReadonlyMap<string, DockerProfileConfig> {
  const raw = process.env[DOCKER_PROFILES_ENV];
  if (!raw) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    reject("Docker profiles configuration is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) reject("Docker profiles configuration is invalid");

  const result = new Map<string, DockerProfileConfig>();
  for (const [alias, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(alias)) reject("Docker profile alias is invalid");
    if (!value || typeof value !== "object" || Array.isArray(value)) reject("Docker profile configuration is invalid");
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["composeFile", "projectName", "services", "controlServices"].includes(key))) reject("Docker profile configuration is invalid");
    const composeFile = record.composeFile;
    const projectName = record.projectName;
    const services = record.services;
    const controlServices = record.controlServices ?? [];
    if (typeof composeFile !== "string" || composeFile.length === 0 || composeFile.length > 4096) reject("Docker compose file is invalid");
    if (path.isAbsolute(composeFile) || composeFile.includes("\0")) reject("Docker compose file must be project-relative");
    const normalized = path.normalize(composeFile);
    if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) reject("Docker compose file must stay within the project");
    if (isSecretPath(composeFile)) throw new DomainError(ErrorCode.SECRET_BLOCKED, "Docker compose file may not use a secret-classified path");
    if (typeof projectName !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(projectName)) reject("Docker project name is invalid");
    if (!Array.isArray(services) || services.length === 0 || services.length > 100) reject("Docker services allowlist is invalid");
    const unique = new Set<string>();
    for (const service of services) {
      if (typeof service !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(service)) reject("Docker service allowlist is invalid");
      if (unique.has(service)) reject("Docker service allowlist is invalid");
      unique.add(service);
    }
    if (!Array.isArray(controlServices) || controlServices.length > 100) reject("Docker control services allowlist is invalid");
    const controlUnique = new Set<string>();
    for (const service of controlServices) {
      if (typeof service !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(service)) reject("Docker control services allowlist is invalid");
      if (controlUnique.has(service)) reject("Docker control services allowlist contains duplicates");
      if (!unique.has(service)) reject("Docker control services must be a subset of services");
      controlUnique.add(service);
    }
    result.set(alias, Object.freeze({ composeFile, projectName, services: Object.freeze([...unique]), controlServices: Object.freeze([...controlUnique]) }));
  }
  return result;
}

export function listDockerProfiles(): { profiles: string[] } {
  return { profiles: [...parseProfiles().keys()].sort() };
}

async function resolveProfile(projectRoot: string, alias: string): Promise<ResolvedDockerProfile> {
  const profile = parseProfiles().get(alias);
  if (!profile) reject("Docker profile is not configured");
  const composePath = await resolveInProject(projectRoot, profile.composeFile, { allowSymlink: false, rejectRoot: true });
  return { ...profile, composePath };
}

function requireService(profile: DockerProfileConfig, service: string): string {
  if (!profile.services.includes(service)) reject("Docker service is not allowlisted for this profile");
  return service;
}

function requireControlService(profile: DockerProfileConfig, service: string): string {
  if (!profile.controlServices.includes(service)) reject("Docker service is not allowlisted for control in this profile");
  return service;
}

async function runDocker(projectRoot: string, args: readonly string[], timeout?: number): Promise<ExecResult> {
  try {
    const env = buildSafeChildEnv();
    // Force the Docker CLI onto the local daemon. buildSafeChildEnv() does not
    // inherit Docker/Compose routing variables; setting this fixed endpoint also
    // prevents a user-level current context from redirecting these operations.
    env.DOCKER_HOST = TRUSTED_LOCAL_DOCKER_HOST;
    return await dockerExec("docker", args, {
      cwd: projectRoot,
      env,
      shell: false,
      windowsHide: true,
      maxBuffer: DOCKER_OUTPUT_MAX_BYTES,
      ...(timeout === undefined ? {} : { timeout }),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Docker adapter unavailable");
    }
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Docker command failed");
  }
}

function composePrefix(profile: ResolvedDockerProfile): string[] {
  return ["compose", "-p", profile.projectName, "-f", profile.composePath];
}

function safeScalar(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return undefined;
  if (/\r|\n|\0/.test(value)) return undefined;
  return redact(value);
}

function parseStatusRows(stdout: string): Array<Record<string, unknown>> {
  if (Buffer.byteLength(stdout, "utf8") > DOCKER_OUTPUT_MAX_BYTES) reject("Docker status output exceeded the bounded limit");
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row));
    if (parsed && typeof parsed === "object") return [parsed as Record<string, unknown>];
  } catch {
    const rows: Array<Record<string, unknown>> = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const row = JSON.parse(line) as unknown;
      if (!row || typeof row !== "object" || Array.isArray(row)) reject("Docker status output was not valid bounded metadata");
      rows.push(row as Record<string, unknown>);
    }
    return rows;
  }
  reject("Docker status output was not valid bounded metadata");
}

function sanitizePublishers(value: unknown): Array<{ url?: string; targetPort?: number; publishedPort?: number; protocol?: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.slice(0, 32).flatMap((publisher) => {
    if (!publisher || typeof publisher !== "object" || Array.isArray(publisher)) return [];
    const row = publisher as Record<string, unknown>;
    const item: { url?: string; targetPort?: number; publishedPort?: number; protocol?: string } = {};
    const url = safeScalar(row.URL, 255);
    if (url) item.url = url;
    if (Number.isInteger(row.TargetPort) && Number(row.TargetPort) >= 1 && Number(row.TargetPort) <= 65535) item.targetPort = Number(row.TargetPort);
    if (Number.isInteger(row.PublishedPort) && Number(row.PublishedPort) >= 1 && Number(row.PublishedPort) <= 65535) item.publishedPort = Number(row.PublishedPort);
    const protocol = safeScalar(row.Protocol, 16);
    if (protocol) item.protocol = protocol;
    return Object.keys(item).length ? [item] : [];
  });
  return result.length ? result : undefined;
}

export async function dockerStatus(projectRoot: string, profileAlias: string, service?: string): Promise<{ services: Array<Record<string, unknown>> }> {
  const profile = await resolveProfile(projectRoot, profileAlias);
  if (service !== undefined) requireService(profile, service);
  const args = [...composePrefix(profile), "ps", "--format", "json"];
  if (service !== undefined) args.push(service);
  const { stdout } = await runDocker(projectRoot, args);
  const allowed = new Set(profile.services);
  const services = parseStatusRows(stdout).flatMap((row) => {
    const serviceName = safeScalar(row.Service, 128);
    if (!serviceName || !allowed.has(serviceName)) return [];
    const item: Record<string, unknown> = { service: serviceName };
    const state = safeScalar(row.State, 64);
    const status = safeScalar(row.Status, 256);
    const health = safeScalar(row.Health, 64);
    const name = safeScalar(row.Name, 256);
    const image = safeScalar(row.Image, 512);
    const ports = sanitizePublishers(row.Publishers);
    if (state) item.state = state;
    if (status) item.status = status;
    if (health) item.health = health;
    if (name) item.containerName = name;
    if (image) item.image = image;
    if (ports) item.publishedPorts = ports;
    return [item];
  });
  return { services };
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  let result = buffer.subarray(0, Math.max(0, maxBytes)).toString("utf8");
  while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
  return result;
}

export async function dockerLogs(projectRoot: string, profileAlias: string, service: string, lines = DOCKER_LOG_DEFAULT_LINES): Promise<{ service: string; lines: number; logs: string; stderr?: string }> {
  const profile = await resolveProfile(projectRoot, profileAlias);
  requireService(profile, service);
  if (!Number.isInteger(lines) || lines < 1 || lines > DOCKER_LOG_MAX_LINES) reject("Docker log lines must be between 1 and 500");
  const { stdout, stderr } = await runDocker(projectRoot, [
    ...composePrefix(profile), "logs", "--no-color", "--tail", String(lines), service,
  ]);
  let remaining = DOCKER_OUTPUT_MAX_BYTES;
  const logs = truncateUtf8(redact(stdout), remaining);
  remaining = Math.max(0, remaining - Buffer.byteLength(logs, "utf8"));
  const safeStderr = remaining > 0 ? truncateUtf8(redact(stderr), remaining) : "";
  return { service, lines, logs, ...(safeStderr ? { stderr: safeStderr } : {}) };
}

type DockerControlAction = "start" | "stop";

async function dockerControl(projectRoot: string, profileAlias: string, service: string, action: DockerControlAction): Promise<{
  profile: string;
  service: string;
  action: DockerControlAction;
  status: Record<string, unknown>;
}> {
  const profile = await resolveProfile(projectRoot, profileAlias);
  requireControlService(profile, service);
  const args = action === "start"
    ? [...composePrefix(profile), "start", service]
    : [...composePrefix(profile), "stop", "--timeout", String(DOCKER_STOP_TIMEOUT_SECONDS), service];
  await runDocker(projectRoot, args, DOCKER_CONTROL_EXEC_TIMEOUT_MS);
  const postState = await dockerStatus(projectRoot, profileAlias, service);
  const status = postState.services[0] ?? { service };
  return { profile: profileAlias, service, action, status };
}

/** Starts only an already-existing Compose service container; never creates, builds, pulls, or recreates. */
export function dockerStart(projectRoot: string, profileAlias: string, service: string) {
  return dockerControl(projectRoot, profileAlias, service, "start");
}

/** Stops a Compose service container with a fixed graceful timeout; never removes or kills it. */
export function dockerStop(projectRoot: string, profileAlias: string, service: string) {
  return dockerControl(projectRoot, profileAlias, service, "stop");
}
