import { promises as fs } from "node:fs";
import path from "node:path";

export type JobStatus = "active" | "paused" | "completed" | "blocked" | "canceled";

export interface DurableJobSummary {
  id: string;
  status: JobStatus;
  projectId?: string;
  mode?: string;
  turnCount: number;
  maxTurns?: number;
  sessionId?: string;
  updatedAt: string;
  goalPreview?: string;
  nextActions: string[];
}

export interface DurableJobDetail extends DurableJobSummary {
  turns: unknown[];
  lastResult?: string;
  filePath: string;
}

interface LocatedJob {
  filePath: string;
  payload: Record<string, unknown>;
  statMtimeMs: number;
}

function goalsRoot(stateDir: string): string {
  return path.join(stateDir, "goals");
}

function normalizeJobStatus(value: unknown, turnCount: number, maxTurns?: number): JobStatus {
  if (value === "active" || value === "paused" || value === "completed" || value === "blocked" || value === "canceled") {
    return value;
  }
  if (maxTurns !== undefined && turnCount >= maxTurns) return "paused";
  return "active";
}

function summaryFromLocated(job: LocatedJob): DurableJobDetail {
  const payload = job.payload;
  const turns = Array.isArray(payload.turns) ? payload.turns : [];
  const lastTurn =
    turns.length > 0 && turns[turns.length - 1] && typeof turns[turns.length - 1] === "object"
      ? turns[turns.length - 1] as Record<string, unknown>
      : undefined;
  const maxTurns =
    typeof payload.maxTurns === "number" && Number.isInteger(payload.maxTurns)
      ? payload.maxTurns
      : undefined;
  const nextActions = Array.isArray(lastTurn?.nextActions)
    ? lastTurn.nextActions.filter((item): item is string => typeof item === "string")
    : [];
  return {
    id: String(payload.loopId ?? path.basename(job.filePath, ".loop.json")),
    status: normalizeJobStatus(payload.status, turns.length, maxTurns),
    ...(typeof payload.projectId === "string" ? { projectId: payload.projectId } : {}),
    ...(typeof payload.mode === "string" ? { mode: payload.mode } : {}),
    turnCount: turns.length,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(typeof payload.sessionId === "string" ? { sessionId: payload.sessionId } : {}),
    updatedAt:
      typeof payload.updatedAt === "string"
        ? payload.updatedAt
        : new Date(job.statMtimeMs).toISOString(),
    ...(typeof payload.goalPreview === "string" ? { goalPreview: payload.goalPreview } : {}),
    nextActions,
    turns,
    ...(typeof lastTurn?.lastResult === "string" ? { lastResult: lastTurn.lastResult } : {}),
    filePath: job.filePath,
  };
}

async function collectLoopFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return [] as import("node:fs").Dirent[];
      throw err;
    });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".loop.json")) {
        result.push(full);
      }
    }
  }
  return result;
}

async function locateJobs(stateDir: string): Promise<LocatedJob[]> {
  const files = await collectLoopFiles(goalsRoot(stateDir));
  const jobs: LocatedJob[] = [];
  for (const filePath of files) {
    try {
      const [raw, stat] = await Promise.all([fs.readFile(filePath, "utf8"), fs.stat(filePath)]);
      const payload = JSON.parse(raw) as unknown;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
      jobs.push({ filePath, payload: payload as Record<string, unknown>, statMtimeMs: stat.mtimeMs });
    } catch {
      // Ignore incomplete/corrupt historical loop files.
    }
  }
  return jobs;
}

export async function listDurableJobs(stateDir: string): Promise<DurableJobSummary[]> {
  const jobs = (await locateJobs(stateDir)).map(summaryFromLocated);
  jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return jobs.map(({ turns: _turns, filePath: _filePath, lastResult: _lastResult, ...summary }) => summary);
}

export async function readDurableJob(stateDir: string, id: string): Promise<DurableJobDetail | null> {
  if (!/^loop-[A-Za-z0-9.-]+$/.test(id)) throw new Error("invalid job id");
  const matches = (await locateJobs(stateDir))
    .map(summaryFromLocated)
    .filter((job) => job.id === id);
  if (matches.length === 0) return null;
  if (matches.length > 1) throw new Error("job id is ambiguous across runtime namespaces: " + id);
  return matches[0]!;
}

async function atomicWriteJson(filePath: string, payload: Record<string, unknown>): Promise<void> {
  const tmp = filePath + "." + process.pid + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, filePath);
}

export async function setDurableJobStatus(
  stateDir: string,
  id: string,
  status: JobStatus,
): Promise<DurableJobDetail | null> {
  const job = await readDurableJob(stateDir, id);
  if (!job) return null;
  const raw = JSON.parse(await fs.readFile(job.filePath, "utf8")) as Record<string, unknown>;
  raw.status = status;
  raw.updatedAt = new Date().toISOString();
  await atomicWriteJson(job.filePath, raw);
  return await readDurableJob(stateDir, id);
}

export async function durableJobLogs(
  stateDir: string,
  id: string,
  limit = 10,
): Promise<{ job: DurableJobSummary; turns: unknown[]; lastResult?: string } | null> {
  const job = await readDurableJob(stateDir, id);
  if (!job) return null;
  const { turns, filePath: _filePath, lastResult, ...summary } = job;
  return {
    job: summary,
    turns: turns.slice(-Math.max(1, Math.min(limit, 50))),
    ...(lastResult ? { lastResult } : {}),
  };
}
