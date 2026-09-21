import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface RuntimeInstanceRecord {
  version: 1;
  name: string;
  pid: number;
  tunnelPid?: number;
  tunnelMode?: "none" | "cloudflare";
  tunnelLogPath?: string;
  workspace: string;
  host: string;
  port: number;
  publicUrl: string;
  startedAt: number;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function normalizeInstanceName(value: string | boolean | undefined): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "default";
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(raw)) {
    throw new Error("instance name must match /^[A-Za-z0-9_.-]{1,64}$/");
  }
  return raw;
}

function runtimeDir(stateDir: string): string {
  return path.join(stateDir, "runtime");
}

function recordPath(stateDir: string, name: string): string {
  return path.join(runtimeDir(stateDir), `${normalizeInstanceName(name)}.json`);
}

async function ensureRuntimeDir(stateDir: string): Promise<void> {
  await mkdir(runtimeDir(stateDir), { recursive: true, mode: DIR_MODE });
}

export async function writeRuntimeInstance(stateDir: string, record: RuntimeInstanceRecord): Promise<void> {
  await ensureRuntimeDir(stateDir);
  const target = recordPath(stateDir, record.name);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(record, null, 2), { encoding: "utf8", mode: FILE_MODE });
  await rename(tmp, target);
}

export async function readRuntimeInstance(stateDir: string, name: string): Promise<RuntimeInstanceRecord | null> {
  try {
    const raw = JSON.parse(await readFile(recordPath(stateDir, name), "utf8")) as Partial<RuntimeInstanceRecord>;
    if (
      raw.version !== 1 ||
      typeof raw.name !== "string" ||
      typeof raw.pid !== "number" ||
      !Number.isInteger(raw.pid) ||
      raw.pid <= 0 ||
      (raw.tunnelPid !== undefined &&
        (typeof raw.tunnelPid !== "number" || !Number.isInteger(raw.tunnelPid) || raw.tunnelPid <= 0)) ||
      (raw.tunnelMode !== undefined && raw.tunnelMode !== "none" && raw.tunnelMode !== "cloudflare") ||
      (raw.tunnelLogPath !== undefined && typeof raw.tunnelLogPath !== "string") ||
      typeof raw.workspace !== "string" ||
      typeof raw.host !== "string" ||
      typeof raw.port !== "number" ||
      !Number.isInteger(raw.port) ||
      raw.port <= 0 ||
      raw.port > 65535 ||
      typeof raw.publicUrl !== "string" ||
      typeof raw.startedAt !== "number"
    ) {
      return null;
    }
    return raw as RuntimeInstanceRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export async function removeRuntimeInstance(stateDir: string, name: string): Promise<void> {
  await unlink(recordPath(stateDir, name)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
}

export async function listRuntimeInstances(stateDir: string): Promise<RuntimeInstanceRecord[]> {
  let names: string[];
  try {
    names = await readdir(runtimeDir(stateDir));
  } catch {
    return [];
  }
  const records: RuntimeInstanceRecord[] = [];
  for (const filename of names.filter((name) => name.endsWith(".json")).sort()) {
    const name = filename.slice(0, -5);
    const record = await readRuntimeInstance(stateDir, name);
    if (record) records.push(record);
  }
  return records;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
