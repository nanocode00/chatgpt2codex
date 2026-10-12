export interface GitPrChecksSummary {
  total: number;
  pending: number;
  successful: number;
  failed: number;
}

export type GitPrCheckClassification = "successful" | "pending" | "failed";

export interface GitPrCheckDetail {
  name: string;
  status: string;
  classification: GitPrCheckClassification;
  workflowName: string | null;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface GitPrCheckRollup {
  summary: GitPrChecksSummary;
  details: GitPrCheckDetail[];
  failedCheckNames: string[];
}

const SUCCESSFUL = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"]);

function boundedString(value: unknown, maxLength = 2048): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function safeDetailsUrl(value: unknown): string | null {
  const raw = boundedString(value, 4096);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().slice(0, 2048);
  } catch {
    return null;
  }
}

function checkName(record: Record<string, unknown>, index: number): string {
  return (
    boundedString(record.name, 256) ??
    boundedString(record.context, 256) ??
    boundedString(record.workflowName, 256) ??
    `check-${index + 1}`
  );
}

function checkStatus(record: Record<string, unknown>): string {
  const raw = [record.conclusion, record.state, record.status]
    .find((item) => typeof item === "string") as string | undefined;
  return raw?.trim().toUpperCase() || "UNKNOWN";
}

function classification(status: string): GitPrCheckClassification {
  if (SUCCESSFUL.has(status)) return "successful";
  if (FAILED.has(status)) return "failed";
  return "pending";
}

export function normalizeStatusChecks(value: unknown): GitPrCheckRollup {
  const rows = Array.isArray(value) ? value : [];
  const details: GitPrCheckDetail[] = rows.map((row, index) => {
    const record = row && typeof row === "object" && !Array.isArray(row)
      ? row as Record<string, unknown>
      : {};
    const status = checkStatus(record);
    return {
      name: checkName(record, index),
      status,
      classification: classification(status),
      workflowName: boundedString(record.workflowName, 256),
      detailsUrl: safeDetailsUrl(record.detailsUrl ?? record.targetUrl),
      startedAt: boundedString(record.startedAt, 128),
      completedAt: boundedString(record.completedAt, 128),
    };
  });

  const summary: GitPrChecksSummary = {
    total: details.length,
    pending: details.filter((check) => check.classification === "pending").length,
    successful: details.filter((check) => check.classification === "successful").length,
    failed: details.filter((check) => check.classification === "failed").length,
  };

  return {
    summary,
    details,
    failedCheckNames: [...new Set(
      details
        .filter((check) => check.classification === "failed")
        .map((check) => check.name),
    )],
  };
}
