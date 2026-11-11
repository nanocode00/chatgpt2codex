/** The CLI's job IDs are durable loop IDs, not project IDs. Untrusted CLI JSON is narrowed before display. */
export interface JobListItem {
  id: string;
  status: string;
  projectId?: string;
  goalPreview?: string;
}

export function parseJobList(input: unknown): JobListItem[] | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const list = (input as { jobs?: unknown }).jobs;
  if (!Array.isArray(list)) return null;
  return list.filter((value): value is JobListItem => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const job = value as Record<string, unknown>;
    return typeof job.id === "string" && job.id.length <= 128 &&
      /^loop-[A-Za-z0-9.-]+$/.test(job.id) && !job.id.includes("..") &&
      typeof job.status === "string" && job.status.length <= 32 &&
      (job.projectId === undefined || (typeof job.projectId === "string" && job.projectId.length <= 160)) &&
      (job.goalPreview === undefined || (typeof job.goalPreview === "string" && job.goalPreview.length <= 200));
  }).slice(0, 128).map(job => ({
    id: job.id, status: job.status, ...(job.projectId ? { projectId: job.projectId } : {}),
    ...(job.goalPreview ? { goalPreview: job.goalPreview } : {})
  }));
}
