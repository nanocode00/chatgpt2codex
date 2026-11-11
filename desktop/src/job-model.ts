import { parseJobList, type JobListItem } from "./job-list";

export type JobState = "active" | "paused" | "completed" | "blocked" | "canceled";
export type JobFilter = "all" | JobState;
export interface JobDetail {
  id: string;
  status: JobState;
  projectId: string | null;
  mode: string | null;
  turnCount: number;
  maxTurns: number | null;
  updatedAt: string | null;
  goalPreview: string | null;
  nextActions: string[];
}
export interface JobLogs {
  job: JobDetail;
  turns: unknown[];
  lastResult: string | null;
}

export function validJobId(id: string): boolean {
  return id.length <= 128 && /^loop-[A-Za-z0-9.-]+$/.test(id) && !id.includes("..");
}
function bounded(value: unknown, limit: number): string | null {
  return typeof value === "string" && value.length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    ? value : null;
}
function integer(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
}
const states: JobState[] = ["active", "paused", "completed", "blocked", "canceled"];
export function isJobState(status: unknown): status is JobState {
  return typeof status === "string" && states.includes(status as JobState);
}
export function parseJobDetail(raw: unknown, selectedId: string): JobDetail | null {
  if (!validJobId(selectedId) || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.id !== selectedId || !isJobState(o.status)) return null;
  const turnCount = integer(o.turnCount, 1_000_000);
  if (turnCount === null) return null;
  const maxTurns = o.maxTurns === undefined ? null : integer(o.maxTurns, 1_000_000);
  if (o.maxTurns !== undefined && maxTurns === null) return null;
  const next = Array.isArray(o.nextActions) ? o.nextActions : [];
  return {
    id: selectedId,
    status: o.status,
    projectId: bounded(o.projectId, 160),
    mode: bounded(o.mode, 80),
    turnCount,
    maxTurns,
    updatedAt: bounded(o.updatedAt, 64),
    goalPreview: bounded(o.goalPreview, 1024),
    nextActions: next.filter((s): s is string => bounded(s, 300) !== null).slice(0, 8),
  };
}
export function parseJobLogs(raw: unknown, selectedId: string): JobLogs | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const job = parseJobDetail(o.job, selectedId);
  if (!job || !Array.isArray(o.turns)) return null;
  return {
    job,
    turns: o.turns.slice(0, 10),
    lastResult: bounded(o.lastResult, 2048)
  };
}
export function filterJobs(items: JobListItem[], filter: JobFilter, query: string): JobListItem[] {
  const needle = query.trim().toLocaleLowerCase();
  return items.filter(item => (filter === "all" || item.status === filter) &&
    (!needle || item.id.toLocaleLowerCase().includes(needle) ||
      (item.projectId ?? "").toLocaleLowerCase().includes(needle)));
}
export function jobStatusText(status: string): string {
  return ({
    active: "활성", paused: "일시 중단", completed: "완료", blocked: "차단됨", canceled: "취소됨"
  } as Record<string, string>)[status] ?? "알 수 없음";
}

/** Don't offer a destructive state transition without a selected, validated job. */
export function permittedJobAction(status: JobState, action: "resume" | "cancel"): boolean {
  if (action === "resume") return status === "paused" || status === "blocked" || status === "canceled";
  return status === "active" || status === "paused" || status === "blocked";
}

export function safeTurnPreview(value: unknown): string {
  // Rust already recursively redacts known secret fields. The WebView still
  // limits previews and masks additional common inline credential formats.
  let raw = "";
  try { raw = JSON.stringify(value, null, 2) ?? ""; }
  catch { return "[표시할 수 없는 작업 기록]"; }
  return raw.replace(/(bearer\s+)[a-z0-9._~+/-]+/gi, "$1[숨김]")
    .replace(/("(?:token|password|secret|api[_-]?key)"\s*:\s*")[^"]*"/gi, '$1[숨김]"')
    .slice(0, 4000);
}
export { parseJobList };
