import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";

export type WorkspaceLockMode = "read" | "write";

interface LockRecord {
  version: 1;
  token: string;
  owner: string;
  pid: number;
  mode: WorkspaceLockMode;
  projectRoot: string;
  createdAt: number;
  expiresAt: number;
}

export interface WorkspaceLockSnapshot {
  projectRoot: string;
  writer: Omit<LockRecord, "token"> | null;
  readers: Array<Omit<LockRecord, "token">>;
}

export interface WorkspaceLockHandle {
  mode: WorkspaceLockMode;
  owner: string;
  projectRoot: string;
  release(): Promise<void>;
}

const LOCK_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_WAIT_MS = 5_000;
const RETRY_MS = 50;

function lockId(projectRoot: string): string {
  return createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 32);
}

function lockDir(stateDir: string, projectRoot: string): string {
  return path.join(stateDir, "locks", lockId(projectRoot));
}

function writerPath(dir: string): string {
  return path.join(dir, "writer.json");
}

function readersDir(dir: string): string {
  return path.join(dir, "readers");
}

function readerPath(dir: string, token: string): string {
  return path.join(readersDir(dir), token + ".json");
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isLockRecord(value: unknown): value is LockRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<LockRecord>;
  return (
    row.version === 1 &&
    typeof row.token === "string" &&
    typeof row.owner === "string" &&
    typeof row.pid === "number" &&
    (row.mode === "read" || row.mode === "write") &&
    typeof row.projectRoot === "string" &&
    typeof row.createdAt === "number" &&
    typeof row.expiresAt === "number"
  );
}

async function readRecord(filePath: string): Promise<LockRecord | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return isLockRecord(parsed) ? parsed : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function stale(record: LockRecord | null, now = Date.now()): boolean {
  return Boolean(record && (record.expiresAt < now || !isProcessAlive(record.pid)));
}

async function removeIfStale(filePath: string): Promise<boolean> {
  const record = await readRecord(filePath);
  if (!record) {
    await fs.unlink(filePath).catch(() => undefined);
    return true;
  }
  if (!stale(record)) return false;
  await fs.unlink(filePath).catch(() => undefined);
  return true;
}

async function activeWriter(dir: string): Promise<LockRecord | null> {
  const file = writerPath(dir);
  const record = await readRecord(file);
  if (record && stale(record)) {
    await fs.unlink(file).catch(() => undefined);
    return null;
  }
  return record;
}

async function activeReaders(dir: string): Promise<Array<{ file: string; record: LockRecord }>> {
  const root = readersDir(dir);
  const names = await fs.readdir(root).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [] as string[];
    throw err;
  });
  const active: Array<{ file: string; record: LockRecord }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(root, name);
    const record = await readRecord(file);
    if (!record || stale(record)) {
      await fs.unlink(file).catch(() => undefined);
      continue;
    }
    active.push({ file, record });
  }
  return active;
}

async function writeExclusive(filePath: string, record: LockRecord): Promise<boolean> {
  try {
    const handle = await fs.open(filePath, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record, null, 2) + "\n", "utf8");
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

function makeRecord(projectRoot: string, owner: string, mode: WorkspaceLockMode): LockRecord {
  const now = Date.now();
  return {
    version: 1,
    token: randomUUID(),
    owner,
    pid: process.pid,
    mode,
    projectRoot: path.resolve(projectRoot),
    createdAt: now,
    expiresAt: now + LOCK_TTL_MS,
  };
}

async function tryAcquireRead(dir: string, record: LockRecord): Promise<WorkspaceLockHandle | null> {
  if (await activeWriter(dir)) return null;
  const file = readerPath(dir, record.token);
  if (!(await writeExclusive(file, record))) return null;

  if (await activeWriter(dir)) {
    await fs.unlink(file).catch(() => undefined);
    return null;
  }

  return {
    mode: "read",
    owner: record.owner,
    projectRoot: record.projectRoot,
    release: async () => {
      const current = await readRecord(file);
      if (current?.token === record.token) await fs.unlink(file).catch(() => undefined);
    },
  };
}

async function tryAcquireWrite(dir: string, record: LockRecord): Promise<WorkspaceLockHandle | null> {
  const file = writerPath(dir);
  if (!(await writeExclusive(file, record))) {
    await removeIfStale(file);
    if (!(await writeExclusive(file, record))) return null;
  }

  const readers = await activeReaders(dir);
  if (readers.length > 0) {
    const current = await readRecord(file);
    if (current?.token === record.token) await fs.unlink(file).catch(() => undefined);
    return null;
  }

  return {
    mode: "write",
    owner: record.owner,
    projectRoot: record.projectRoot,
    release: async () => {
      const current = await readRecord(file);
      if (current?.token === record.token) await fs.unlink(file).catch(() => undefined);
    },
  };
}

export async function acquireWorkspaceLock(
  stateDir: string,
  projectRoot: string,
  mode: WorkspaceLockMode,
  owner: string,
  options: { waitMs?: number } = {},
): Promise<WorkspaceLockHandle> {
  const resolved = path.resolve(projectRoot);
  const dir = lockDir(stateDir, resolved);
  await fs.mkdir(readersDir(dir), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);

  while (true) {
    const record = makeRecord(resolved, owner, mode);
    const handle =
      mode === "read"
        ? await tryAcquireRead(dir, record)
        : await tryAcquireWrite(dir, record);
    if (handle) return handle;
    if (Date.now() >= deadline) {
      const writer = await activeWriter(dir);
      const readers = await activeReaders(dir);
      throw new DomainError(
        ErrorCode.WORKSPACE_LOCKED,
        "Workspace is busy with another c2c operation",
        {
          projectRoot: resolved,
          requestedMode: mode,
          writer: writer ? { owner: writer.owner, pid: writer.pid, createdAt: writer.createdAt } : null,
          readers: readers.map(({ record: item }) => ({
            owner: item.owner,
            pid: item.pid,
            createdAt: item.createdAt,
          })),
        },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}

export async function withWorkspaceLock<T>(
  stateDir: string,
  projectRoot: string,
  mode: WorkspaceLockMode,
  owner: string,
  fn: () => Promise<T>,
): Promise<T> {
  const handle = await acquireWorkspaceLock(stateDir, projectRoot, mode, owner);
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}

export async function listWorkspaceLocks(stateDir: string): Promise<WorkspaceLockSnapshot[]> {
  const root = path.join(stateDir, "locks");
  const dirs = await fs.readdir(root, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [] as import("node:fs").Dirent[];
    throw err;
  });
  const snapshots: WorkspaceLockSnapshot[] = [];
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const writer = await activeWriter(dir);
    const readers = await activeReaders(dir);
    const projectRoot = writer?.projectRoot ?? readers[0]?.record.projectRoot;
    if (!projectRoot) continue;
    snapshots.push({
      projectRoot,
      writer: writer ? {
        version: writer.version,
        owner: writer.owner,
        pid: writer.pid,
        mode: writer.mode,
        projectRoot: writer.projectRoot,
        createdAt: writer.createdAt,
        expiresAt: writer.expiresAt,
      } : null,
      readers: readers.map(({ record }) => ({
        version: record.version,
        owner: record.owner,
        pid: record.pid,
        mode: record.mode,
        projectRoot: record.projectRoot,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
      })),
    });
  }
  return snapshots.sort((a, b) => a.projectRoot.localeCompare(b.projectRoot));
}

export async function forceReleaseWorkspaceLock(stateDir: string, projectRoot: string): Promise<boolean> {
  const dir = lockDir(stateDir, projectRoot);
  try {
    await fs.rm(dir, { recursive: true, force: false });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
