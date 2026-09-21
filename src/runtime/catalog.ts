import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

export interface ManagedDockerProfile {
  composeFile: string;
  projectName: string;
  services: string[];
  controlServices: string[];
}

export interface ManagedProfilesFile {
  version: 1;
  python: Record<string, string>;
  docker: Record<string, ManagedDockerProfile>;
}

export interface ManagedRepository {
  id: string;
  name: string;
  root: string;
}

export interface ManagedRepositoriesFile {
  version: 1;
  repositories: ManagedRepository[];
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const PROFILE_ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REPOSITORY_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function profilesPath(configDir: string): string {
  return path.join(configDir, "profiles.json");
}

function repositoriesPath(configDir: string): string {
  return path.join(configDir, "repositories.json");
}

async function atomicWrite(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
  const tmp = filePath + "." + process.pid + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: FILE_MODE });
  await fs.rename(tmp, filePath);
}

function validAlias(alias: string): boolean {
  return PROFILE_ALIAS_RE.test(alias) && !alias.includes("..");
}

export function normalizeManagedProfileAlias(alias: string): string {
  const normalized = alias.trim().toLowerCase();
  if (!validAlias(normalized) || normalized === "auto") {
    throw new Error("profile alias must match /^[a-z0-9][a-z0-9._-]{0,63}$/ and may not be 'auto'");
  }
  return normalized;
}

export function normalizeRepositoryId(id: string): string {
  const normalized = id.trim().toLowerCase();
  if (!REPOSITORY_ID_RE.test(normalized) || normalized.includes("..")) {
    throw new Error("repository id must match /^[a-z0-9][a-z0-9._-]{0,63}$/");
  }
  return normalized;
}

function validateDockerProfile(value: unknown): ManagedDockerProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("docker profile must be an object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["composeFile", "projectName", "services", "controlServices"].includes(key))) {
    throw new Error("docker profile contains unsupported keys");
  }
  const composeFile = raw.composeFile;
  const projectName = raw.projectName;
  const services = raw.services;
  const controlServices = raw.controlServices ?? [];
  if (typeof composeFile !== "string" || !composeFile || path.isAbsolute(composeFile) || composeFile.includes("\0")) {
    throw new Error("docker composeFile must be a project-relative path");
  }
  const normalized = path.normalize(composeFile);
  if (normalized === ".." || normalized.startsWith(".." + path.sep)) {
    throw new Error("docker composeFile must stay within the project");
  }
  if (typeof projectName !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(projectName)) {
    throw new Error("docker projectName is invalid");
  }
  if (!Array.isArray(services) || services.length === 0 || services.length > 100) {
    throw new Error("docker services must contain 1..100 entries");
  }
  const serviceList = services.map((service) => {
    if (typeof service !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(service)) {
      throw new Error("docker service name is invalid");
    }
    return service;
  });
  if (new Set(serviceList).size !== serviceList.length) throw new Error("docker services contain duplicates");
  if (!Array.isArray(controlServices) || controlServices.length > 100) throw new Error("docker controlServices are invalid");
  const controlList = controlServices.map((service) => {
    if (typeof service !== "string" || !serviceList.includes(service)) {
      throw new Error("docker controlServices must be a subset of services");
    }
    return service;
  });
  if (new Set(controlList).size !== controlList.length) throw new Error("docker controlServices contain duplicates");
  return { composeFile, projectName, services: serviceList, controlServices: controlList };
}

export async function readManagedProfiles(configDir: string): Promise<ManagedProfilesFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(profilesPath(configDir), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, python: {}, docker: {} };
    throw err;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid profiles.json");
  const raw = parsed as Record<string, unknown>;
  if (raw.version !== 1) throw new Error("unsupported profiles.json version");
  const pythonRaw = raw.python ?? {};
  const dockerRaw = raw.docker ?? {};
  if (!pythonRaw || typeof pythonRaw !== "object" || Array.isArray(pythonRaw)) throw new Error("python profiles must be an object");
  if (!dockerRaw || typeof dockerRaw !== "object" || Array.isArray(dockerRaw)) throw new Error("docker profiles must be an object");

  const python: Record<string, string> = {};
  for (const [aliasRaw, executable] of Object.entries(pythonRaw as Record<string, unknown>)) {
    const alias = normalizeManagedProfileAlias(aliasRaw);
    if (typeof executable !== "string" || !path.isAbsolute(executable)) throw new Error("python profile paths must be absolute");
    python[alias] = executable;
  }
  const docker: Record<string, ManagedDockerProfile> = {};
  for (const [aliasRaw, profile] of Object.entries(dockerRaw as Record<string, unknown>)) {
    docker[normalizeManagedProfileAlias(aliasRaw)] = validateDockerProfile(profile);
  }
  return { version: 1, python, docker };
}

export async function writeManagedProfiles(configDir: string, profiles: ManagedProfilesFile): Promise<void> {
  const validated: ManagedProfilesFile = { version: 1, python: {}, docker: {} };
  for (const [alias, executable] of Object.entries(profiles.python)) {
    const normalized = normalizeManagedProfileAlias(alias);
    if (!path.isAbsolute(executable)) throw new Error("python profile paths must be absolute");
    validated.python[normalized] = executable;
  }
  for (const [alias, profile] of Object.entries(profiles.docker)) {
    validated.docker[normalizeManagedProfileAlias(alias)] = validateDockerProfile(profile);
  }
  await atomicWrite(profilesPath(configDir), validated);
}

export async function testPythonProfile(executable: string): Promise<{ available: boolean; resolved?: string }> {
  const resolved = await fs.realpath(executable).catch(() => undefined);
  if (!resolved) return { available: false };
  const st = await fs.stat(resolved).catch(() => undefined);
  if (!st?.isFile()) return { available: false };
  if (process.platform !== "win32") {
    try {
      await fs.access(resolved, fsConstants.X_OK);
    } catch {
      return { available: false, resolved };
    }
  }
  return { available: true, resolved };
}

export async function applyManagedProfiles(
  configDir: string,
  baseEnv: NodeJS.ProcessEnv,
  processEnv: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const profiles = await readManagedProfiles(configDir);
  const env = { ...baseEnv };
  if (!processEnv.CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES?.trim() && Object.keys(profiles.python).length > 0) {
    env.CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES = JSON.stringify(profiles.python);
  }
  if (!processEnv.CHATGPT2CODEX_DOCKER_PROFILES?.trim() && Object.keys(profiles.docker).length > 0) {
    env.CHATGPT2CODEX_DOCKER_PROFILES = JSON.stringify(profiles.docker);
  }
  return env;
}

export async function readManagedRepositories(configDir: string): Promise<ManagedRepositoriesFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(repositoriesPath(configDir), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, repositories: [] };
    throw err;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid repositories.json");
  const raw = parsed as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.repositories)) throw new Error("invalid repositories.json");
  const repositories = raw.repositories.map((item): ManagedRepository => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("repository entry must be an object");
    const row = item as Record<string, unknown>;
    const id = normalizeRepositoryId(String(row.id ?? ""));
    const name = String(row.name ?? "").trim();
    const root = String(row.root ?? "");
    if (!name) throw new Error("repository name must not be empty");
    if (!path.isAbsolute(root)) throw new Error("repository root must be absolute");
    return { id, name, root: path.resolve(root) };
  });
  const ids = repositories.map((repo) => repo.id);
  if (new Set(ids).size !== ids.length) throw new Error("repository ids must be unique");
  return { version: 1, repositories };
}

export async function writeManagedRepositories(configDir: string, data: ManagedRepositoriesFile): Promise<void> {
  const repositories: ManagedRepository[] = [];
  for (const repo of data.repositories) {
    repositories.push({
      id: normalizeRepositoryId(repo.id),
      name: repo.name.trim(),
      root: path.resolve(repo.root),
    });
  }
  if (repositories.some((repo) => !repo.name)) throw new Error("repository name must not be empty");
  if (new Set(repositories.map((repo) => repo.id)).size !== repositories.length) throw new Error("repository ids must be unique");
  await atomicWrite(repositoriesPath(configDir), { version: 1, repositories });
}

export function slugRepositoryName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9.-]/g, "");
  return normalizeRepositoryId(slug || "repository");
}
