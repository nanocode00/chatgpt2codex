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
  operation?: string;
}

interface RecoveryRecord {
  version: 1;
  token: string;
  pid: number;
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

export type WorkspaceLockRecordState = "live" | "stale";

export interface WorkspaceLockDiagnosticHolder {
  owner: string;
  pid: number;
  mode: WorkspaceLockMode;
  operation: string | null;
  createdAt: number;
  expiresAt: number;
  ageMs: number;
  expiresInMs: number;
  state: WorkspaceLockRecordState;
  staleReason: "expired" | "process-dead" | null;
}

export interface WorkspaceLockDiagnostic {
  projectRoot: string;
  snapshotId: string | null;
  writer: WorkspaceLockDiagnosticHolder | null;
  readers: WorkspaceLockDiagnosticHolder[];
  invalidRecords: number;
  liveCount: number;
  staleCount: number;
  safeStaleRecoveryAvailable: boolean;
}

const LOCK_TTL_MS = 6 * 60 * 60 * 1000;
const RECOVERY_TTL_MS = 30_000;
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

function recoveryPath(dir: string): string {
  return path.join(dir, "recovery.json");
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
    typeof row.expiresAt === "number" &&
    (row.operation === undefined || typeof row.operation === "string")
  );
}

function isRecoveryRecord(value: unknown): value is RecoveryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<RecoveryRecord>;
  return (
    row.version === 1 &&
    typeof row.token === "string" &&
    typeof row.pid === "number" &&
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

async function readRecoveryRecord(filePath: string): Promise<RecoveryRecord | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return isRecoveryRecord(parsed) ? parsed : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function stale(record: LockRecord | null, now = Date.now()): boolean {
  return Boolean(record && (record.expiresAt < now || !isProcessAlive(record.pid)));
}

function staleReason(record: LockRecord, now = Date.now()): "expired" | "process-dead" | null {
  if (record.expiresAt < now) return "expired";
  if (!isProcessAlive(record.pid)) return "process-dead";
  return null;
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

async function activeRecoveryGuard(dir: string): Promise<RecoveryRecord | null> {
  const file = recoveryPath(dir);
  const record = await readRecoveryRecord(file);
  if (!record) {
    await fs.unlink(file).catch(() => undefined);
    return null;
  }
  if (record.expiresAt < Date.now() || !isProcessAlive(record.pid)) {
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

async function writeExclusive(filePath: string, record: unknown): Promise<boolean> {
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

async function acquireRecoveryGuard(dir: string): Promise<{ release(): Promise<void> }> {
  await fs.mkdir(readersDir(dir), { recursive: true, mode: 0o700 });
  const now = Date.now();
  const record: RecoveryRecord = {
    version: 1,
    token: randomUUID(),
    pid: process.pid,
    createdAt: now,
    expiresAt: now + RECOVERY_TTL_MS,
  };
  const file = recoveryPath(dir);
  if (!(await writeExclusive(file, record))) {
    await activeRecoveryGuard(dir);
    if (!(await writeExclusive(file, record))) {
      throw new DomainError(ErrorCode.WORKSPACE_LOCKED, "Another workspace lock recovery is active");
    }
  }
  return {
    release: async () => {
      const current = await readRecoveryRecord(file);
      if (current?.token === record.token) await fs.unlink(file).catch(() => undefined);
    },
  };
}

function makeRecord(projectRoot: string, owner: string, mode: WorkspaceLockMode, operation?: string): LockRecord {
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
    ...(operation ? { operation } : {}),
  };
}

async function tryAcquireRead(dir: string, record: LockRecord): Promise<WorkspaceLockHandle | null> {
  if (await activeRecoveryGuard(dir)) return null;
  if (await activeWriter(dir)) return null;
  const file = readerPath(dir, record.token);
  if (!(await writeExclusive(file, record))) return null;

  if ((await activeRecoveryGuard(dir)) || (await activeWriter(dir))) {
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
  if (await activeRecoveryGuard(dir)) return null;
  const file = writerPath(dir);
  if (!(await writeExclusive(file, record))) {
    await removeIfStale(file);
    if (!(await writeExclusive(file, record))) return null;
  }

  if (await activeRecoveryGuard(dir)) {
    const current = await readRecord(file);
    if (current?.token === record.token) await fs.unlink(file).catch(() => undefined);
    return null;
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
  options: { waitMs?: number; operation?: string } = {},
): Promise<WorkspaceLockHandle> {
  const resolved = path.resolve(projectRoot);
  const dir = lockDir(stateDir, resolved);
  await fs.mkdir(readersDir(dir), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);

  while (true) {
    const record = makeRecord(resolved, owner, mode, options.operation);
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
          requestedOperation: options.operation ?? null,
          writer: writer ? {
            owner: writer.owner,
            pid: writer.pid,
            mode: writer.mode,
            operation: writer.operation ?? null,
            createdAt: writer.createdAt,
            expiresAt: writer.expiresAt,
            ageMs: Math.max(0, Date.now() - writer.createdAt),
            expiresInMs: Math.max(0, writer.expiresAt - Date.now()),
          } : null,
          readers: readers.map(({ record: item }) => ({
            owner: item.owner,
            pid: item.pid,
            mode: item.mode,
            operation: item.operation ?? null,
            createdAt: item.createdAt,
            expiresAt: item.expiresAt,
            ageMs: Math.max(0, Date.now() - item.createdAt),
            expiresInMs: Math.max(0, item.expiresAt - Date.now()),
          })),
          recovery: "Inspect workspace_lock_status. Provably stale records can be recovered; live/ambiguous records require an exact snapshot and explicit force-release authorization.",
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
  options: { operation?: string } = {},
): Promise<T> {
  const handle = await acquireWorkspaceLock(stateDir, projectRoot, mode, owner, options);
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}

type DiagnosticEntry = {
  file: string;
  kind: "writer" | "reader";
  record: LockRecord | null;
  rawHash: string;
  state: WorkspaceLockRecordState | "invalid";
  reason: "expired" | "process-dead" | null;
};

async function diagnosticEntry(
  file: string,
  kind: "writer" | "reader",
  now: number,
): Promise<DiagnosticEntry | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const rawHash = createHash("sha256").update(raw).digest("hex");
  let record: LockRecord | null = null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isLockRecord(parsed)) record = parsed;
  } catch {
    // Invalid JSON is intentionally diagnosed but never auto-removed.
  }
  if (!record) return { file, kind, record: null, rawHash, state: "invalid", reason: null };
  const reason = staleReason(record, now);
  return {
    file,
    kind,
    record,
    rawHash,
    state: reason ? "stale" : "live",
    reason,
  };
}

async function collectDiagnosticEntries(stateDir: string, projectRoot: string): Promise<{
  dir: string;
  entries: DiagnosticEntry[];
  snapshotId: string | null;
}> {
  const dir = lockDir(stateDir, projectRoot);
  const entries: DiagnosticEntry[] = [];
  const now = Date.now();
  const writer = await diagnosticEntry(writerPath(dir), "writer", now);
  if (writer) entries.push(writer);
  const root = readersDir(dir);
  const names = await fs.readdir(root).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [] as string[];
    throw err;
  });
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const entry = await diagnosticEntry(path.join(root, name), "reader", now);
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) return { dir, entries, snapshotId: null };
  const fingerprint = entries
    .map((entry) => `${entry.kind}:${path.basename(entry.file)}:${entry.rawHash}`)
    .sort()
    .join("\n");
  return {
    dir,
    entries,
    snapshotId: createHash("sha256").update(fingerprint).digest("hex"),
  };
}

function toDiagnosticHolder(entry: DiagnosticEntry, now = Date.now()): WorkspaceLockDiagnosticHolder | null {
  if (!entry.record || entry.state === "invalid") return null;
  return {
    owner: entry.record.owner,
    pid: entry.record.pid,
    mode: entry.record.mode,
    operation: entry.record.operation ?? null,
    createdAt: entry.record.createdAt,
    expiresAt: entry.record.expiresAt,
    ageMs: Math.max(0, now - entry.record.createdAt),
    expiresInMs: Math.max(0, entry.record.expiresAt - now),
    state: entry.state,
    staleReason: entry.reason,
  };
}

export async function inspectWorkspaceLock(
  stateDir: string,
  projectRoot: string,
): Promise<WorkspaceLockDiagnostic> {
  const resolved = path.resolve(projectRoot);
  const collected = await collectDiagnosticEntries(stateDir, resolved);
  const now = Date.now();
  const valid = collected.entries.filter((entry) => entry.state !== "invalid");
  const liveCount = valid.filter((entry) => entry.state === "live").length;
  const staleCount = valid.filter((entry) => entry.state === "stale").length;
  const writerEntry = collected.entries.find((entry) => entry.kind === "writer") ?? null;
  return {
    projectRoot: resolved,
    snapshotId: collected.snapshotId,
    writer: writerEntry ? toDiagnosticHolder(writerEntry, now) : null,
    readers: collected.entries
      .filter((entry) => entry.kind === "reader")
      .map((entry) => toDiagnosticHolder(entry, now))
      .filter((entry): entry is WorkspaceLockDiagnosticHolder => entry !== null),
    invalidRecords: collected.entries.filter((entry) => entry.state === "invalid").length,
    liveCount,
    staleCount,
    safeStaleRecoveryAvailable: staleCount > 0,
  };
}

function assertExpectedSnapshot(actual: string | null, expected: string): void {
  if (!/^[0-9a-f]{64}$/i.test(expected)) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid workspace lock snapshot id");
  }
  if (!actual || actual.toLowerCase() !== expected.toLowerCase()) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Workspace lock changed; inspect again");
  }
}

export async function recoverStaleWorkspaceLock(
  stateDir: string,
  projectRoot: string,
  expectedSnapshotId: string,
): Promise<{ recovered: number; remaining: WorkspaceLockDiagnostic }> {
  const initial = await collectDiagnosticEntries(stateDir, projectRoot);
  assertExpectedSnapshot(initial.snapshotId, expectedSnapshotId);
  const guard = await acquireRecoveryGuard(initial.dir);
  try {
    const collected = await collectDiagnosticEntries(stateDir, projectRoot);
    assertExpectedSnapshot(collected.snapshotId, expectedSnapshotId);
    const staleEntries = collected.entries.filter((entry) => entry.state === "stale");
    for (const entry of staleEntries) {
      await fs.unlink(entry.file).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
    }
    return {
      recovered: staleEntries.length,
      remaining: await inspectWorkspaceLock(stateDir, projectRoot),
    };
  } finally {
    await guard.release();
  }
}

export async function guardedForceReleaseWorkspaceLock(
  stateDir: string,
  projectRoot: string,
  expectedSnapshotId: string,
): Promise<{ released: boolean; liveCount: number; staleCount: number; invalidRecords: number }> {
  const initial = await collectDiagnosticEntries(stateDir, projectRoot);
  assertExpectedSnapshot(initial.snapshotId, expectedSnapshotId);
  const guard = await acquireRecoveryGuard(initial.dir);
  try {
    const collected = await collectDiagnosticEntries(stateDir, projectRoot);
    assertExpectedSnapshot(collected.snapshotId, expectedSnapshotId);
    const liveCount = collected.entries.filter((entry) => entry.state === "live").length;
    const staleCount = collected.entries.filter((entry) => entry.state === "stale").length;
    const invalidRecords = collected.entries.filter((entry) => entry.state === "invalid").length;
    if (!collected.snapshotId) return { released: false, liveCount, staleCount, invalidRecords };
    for (const entry of collected.entries) {
      await fs.unlink(entry.file).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
    }
    return { released: true, liveCount, staleCount, invalidRecords };
  } finally {
    await guard.release();
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
