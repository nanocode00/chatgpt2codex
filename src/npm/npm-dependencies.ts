import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { buildSafeChildEnv } from "../exec/command-runner.js";
import { DomainError, ErrorCode } from "../types.js";

export const NPM_MAX_PACKAGES = 16;
export const NPM_MAX_PACKAGE_SPEC_LENGTH = 256;
export const NPM_OPERATION_TIMEOUT_MS = 120_000;
const NPM_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_DEPENDENCIES = 512;

export interface NpmExecOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  timeout: number;
  maxBuffer: number;
  windowsHide: true;
}

export type NpmExec = (
  file: string,
  args: readonly string[],
  options: NpmExecOptions,
) => Promise<void>;

export interface ParsedPackageSpec {
  raw: string;
  name: string;
  version?: string;
}

const PACKAGE_PART = "[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?";
const PACKAGE_NAME_RE = new RegExp(`^(?:@${PACKAGE_PART}/${PACKAGE_PART}|${PACKAGE_PART})$`);
const VERSION_RE = /^\^?\d+\.\d+\.\d+$/;

function fail(message: string): never {
  throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, message);
}

export function parseNpmPackageSpec(value: string): ParsedPackageSpec {
  if (typeof value !== "string" || value.length === 0 || value.length > NPM_MAX_PACKAGE_SPEC_LENGTH) {
    fail("npm package spec is invalid");
  }
  if (/\s|[\u0000-\u001f\u007f]/u.test(value) || value.startsWith("-")) fail("npm package spec is invalid");

  let name = value;
  let version: string | undefined;
  const versionAt = value.lastIndexOf("@");
  if (versionAt > 0) {
    const scopedSlash = value.startsWith("@") ? value.indexOf("/") : -1;
    if (!value.startsWith("@") || versionAt > scopedSlash) {
      name = value.slice(0, versionAt);
      version = value.slice(versionAt + 1);
    }
  }

  if (!PACKAGE_NAME_RE.test(name) || name.length > 214) fail("npm package spec is invalid");
  if (name.toLowerCase().endsWith(".tgz")) fail("npm package spec is invalid");
  if (version !== undefined && !VERSION_RE.test(version)) fail("npm package spec is invalid");
  return { raw: value, name, ...(version === undefined ? {} : { version }) };
}

export function validateNpmPackageSpecs(values: unknown): ParsedPackageSpec[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > NPM_MAX_PACKAGES) fail("npm packages are invalid");
  const parsed = values.map((value) => {
    if (typeof value !== "string") fail("npm package spec is invalid");
    return parseNpmPackageSpec(value);
  });
  const names = new Set<string>();
  for (const item of parsed) {
    if (names.has(item.name)) fail("npm packages contain duplicates");
    names.add(item.name);
  }
  return parsed;
}

async function packageJsonPath(projectRoot: string): Promise<string> {
  const file = path.join(projectRoot, "package.json");
  let stat;
  try {
    stat = await lstat(file);
  } catch {
    fail("npm project is not configured");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail("npm project is not configured");
  return file;
}

type PackageJson = {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
};

async function readPackage(projectRoot: string): Promise<{ raw: string; data: PackageJson }> {
  const file = await packageJsonPath(projectRoot);
  try {
    const raw = await readFile(file, "utf8");
    const data = JSON.parse(raw) as PackageJson;
    if (!data || typeof data !== "object" || Array.isArray(data)) fail("npm project is not configured");
    return { raw, data };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    fail("npm project is not configured");
  }
}

function sanitizeDependencies(value: Record<string, unknown> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value || typeof value !== "object") return result;
  for (const name of Object.keys(value).sort().slice(0, MAX_DEPENDENCIES)) {
    const spec = value[name];
    if (typeof spec !== "string" || name.length > 214 || spec.length > NPM_MAX_PACKAGE_SPEC_LENGTH) continue;
    result[name] = spec;
  }
  return result;
}

export async function inspectNpmProject(projectRoot: string): Promise<{
  manager: "npm";
  packageJson: true;
  lockfile: boolean;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}> {
  const { data } = await readPackage(projectRoot);
  return {
    manager: "npm",
    packageJson: true,
    lockfile: existsSync(path.join(projectRoot, "package-lock.json")),
    dependencies: sanitizeDependencies(data.dependencies),
    devDependencies: sanitizeDependencies(data.devDependencies),
  };
}

function npmExecutable(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function npmEnv(): NodeJS.ProcessEnv {
  const env = buildSafeChildEnv();
  delete env.NODE_AUTH_TOKEN;
  delete env.NPM_TOKEN;
  delete env.npm_config_userconfig;
  delete env.npm_config_registry;
  delete env.npm_config_prefix;
  return env;
}

const defaultExec: NpmExec = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, [...args], options, (error) => error ? reject(error) : resolve());
});

async function runNpmMutation(
  projectRoot: string,
  action: "install" | "remove",
  parsed: ParsedPackageSpec[],
  dev: boolean,
  exec: NpmExec,
): Promise<{ manager: "npm"; action: "install" | "remove"; packages: string[]; dev?: boolean; packageJsonChanged: boolean; lockfile: boolean }> {
  const before = await readPackage(projectRoot);
  const args = action === "install"
    ? ["install", ...(dev ? ["--save-dev"] : []), "--ignore-scripts", "--no-audit", "--no-fund", ...parsed.map((item) => item.raw)]
    : ["uninstall", "--ignore-scripts", "--no-audit", "--no-fund", ...parsed.map((item) => item.raw)];

  try {
    await exec(npmExecutable(), args, {
      cwd: projectRoot,
      env: npmEnv(),
      shell: false,
      timeout: NPM_OPERATION_TIMEOUT_MS,
      maxBuffer: NPM_MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ETIMEDOUT") throw new DomainError(ErrorCode.TIMEOUT, "npm dependency operation timed out");
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `npm dependency ${action} failed`);
  }

  const after = await readPackage(projectRoot);
  const deps = after.data.dependencies ?? {};
  const devDeps = after.data.devDependencies ?? {};
  for (const item of parsed) {
    if (action === "install") {
      const target = dev ? devDeps : deps;
      if (typeof target[item.name] !== "string") throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "npm dependency install failed");
    } else if (item.name in deps || item.name in devDeps) {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "npm dependency remove failed");
    }
  }

  return {
    manager: "npm",
    action,
    packages: parsed.map((item) => item.raw),
    ...(action === "install" ? { dev } : {}),
    packageJsonChanged: before.raw !== after.raw,
    lockfile: existsSync(path.join(projectRoot, "package-lock.json")),
  };
}

export async function installNpmDependencies(projectRoot: string, packages: unknown, dev: boolean, exec: NpmExec = defaultExec) {
  return runNpmMutation(projectRoot, "install", validateNpmPackageSpecs(packages), dev, exec);
}

export async function removeNpmDependencies(projectRoot: string, packages: unknown, exec: NpmExec = defaultExec) {
  return runNpmMutation(projectRoot, "remove", validateNpmPackageSpecs(packages), false, exec);
}
