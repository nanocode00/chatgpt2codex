import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  filterJobs, isJobState, jobStatusText, parseJobDetail, parseJobList, parseJobLogs,
  permittedJobAction, safeTurnPreview, validJobId
} from "../desktop/src/job-model";

const sample = {
  id: "loop-demo.1", status: "paused", projectId: "sample", mode: "coding",
  turnCount: 4, maxTurns: 7, updatedAt: "2026-11-11T10:00:00.000Z",
  goalPreview: "Fix login bug", nextActions: ["Review PR"], 
  owner_token: "private"
};
describe("Tauri durable job management", () => {
  it("rejects project IDs, traversal and ambiguous job selectors", () => {
    for (const id of ["sample", "loop-", "loop-../secret", "loop-a_b", "../x", "loop-a/b", "loop-a..b"]) {
      expect(validJobId(id)).toBe(false);
    }
    expect(validJobId("loop-safe.1")).toBe(true);
  });
  it("distinguishes a genuinely empty list from malformed CLI output", () => {
    expect(parseJobList({ jobs: [] })).toEqual([]);
    expect(parseJobList({ jobs: "missing" })).toBeNull();
    expect(parseJobList({ jobs: [{ id: "sample", status: "active" }, { id: "loop-safe.1", status: "active" }] }))
      .toEqual([{ id: "loop-safe.1", status: "active" }]);
  });
  it("shows only a bounded whitelisted job detail, never extra internal metadata", () => {
    expect(parseJobDetail(sample, sample.id)).toEqual({
      id: sample.id, status: "paused", projectId: "sample", mode: "coding", turnCount: 4,
      maxTurns: 7, updatedAt: sample.updatedAt,
      goalPreview: "Fix login bug", nextActions: ["Review PR"]
    });
    expect(JSON.stringify(parseJobDetail(sample, sample.id))).not.toContain("private");
    expect(parseJobDetail(sample, "loop-another")).toBeNull();
    expect(parseJobDetail({ ...sample, status: "running" }, sample.id)).toBeNull();
    expect(parseJobDetail({ ...sample, turnCount: -1 }, sample.id)).toBeNull();
    expect(parseJobDetail({ ...sample, goalPreview: "a".repeat(1025) }, sample.id)?.goalPreview).toBeNull();
    expect(isJobState("blocked")).toBe(true);
    expect(isJobState("unknown")).toBe(false);
    expect(jobStatusText("paused")).toBe("일시 중단");
  });
  it("only renders the 10 most recent CLI-returned turns, with a validated identity", () => {
    const result = parseJobLogs({ job: sample, turns: Array.from({ length: 12 }, (_, i) => ({ turn: i })), lastResult: "done" }, sample.id);
    expect(result?.turns).toHaveLength(10);
    expect(result?.lastResult).toBe("done");
    expect(parseJobLogs({ job: sample, turns: "wrong" }, sample.id)).toBeNull();
    expect(parseJobLogs({ job: { ...sample, id: "loop-other" }, turns: [] }, sample.id)).toBeNull();
  });
  it("filters by workflow status and project text without changing source ordering", () => {
    const jobs = [
      { id: "loop-a", status: "active", projectId: "alpha" },
      { id: "loop-b", status: "blocked", projectId: "beta" },
      { id: "loop-c", status: "paused", projectId: "gamma" },
      { id: "loop-d", status: "completed", projectId: "alpha" },
      { id: "loop-e", status: "canceled", projectId: "omega" }
    ];
    expect(filterJobs(jobs, "all", "ALPHA").map(j => j.id)).toEqual(["loop-a", "loop-d"]);
    expect(filterJobs(jobs, "attention", "").map(j => j.id)).toEqual(["loop-b", "loop-c"]);
    expect(filterJobs(jobs, "history", "").map(j => j.id)).toEqual(["loop-d", "loop-e"]);
    expect(filterJobs(jobs, "active", "").map(j => j.id)).toEqual(["loop-a"]);
    expect(jobs[0]?.id).toBe("loop-a");
  });
  it("never offers a state transition as a process start/kill operation", () => {
    expect(permittedJobAction("paused", "resume")).toBe(true);
    expect(permittedJobAction("blocked", "resume")).toBe(true);
    expect(permittedJobAction("completed", "resume")).toBe(false);
    expect(permittedJobAction("active", "cancel")).toBe(true);
    expect(permittedJobAction("completed", "cancel")).toBe(false);
    const ui = readFileSync("desktop/src/JobsScreen.tsx", "utf8");
    expect(ui).toContain("에이전트를 실행하거나 중지하지 않습니다.");
    expect(ui).toContain('window.confirm(');
    expect(ui).toContain('operation: action === "resume" ? "job-resume" : "job-cancel"');
  });
  it("limits logs and masks common embedded credentials", () => {
    const rendered = safeTurnPreview({ token: "very-secret", body: "Bearer abc.xyz", notes: "ok" });
    expect(rendered).not.toContain("very-secret");
    expect(rendered).not.toContain("abc.xyz");
    expect(rendered).toContain("ok");
    expect(safeTurnPreview({ long: "a".repeat(8000) }).length).toBeLessThanOrEqual(4000);
  });
  it("keeps a three-item scroll catalog and a dedicated Jobs navigation entry", () => {
    const css = readFileSync("desktop/src/jobs.css", "utf8");
    const screen = readFileSync("desktop/src/JobsScreen.tsx", "utf8");
    const app = readFileSync("desktop/src/App.tsx", "utf8");
    expect(css).toContain(".jobs-items{display:flex;flex-direction:column;gap:5px;height:202px;min-height:202px;max-height:202px");
    expect(css).toContain("@container jobs");
    expect(screen).toContain("role=\"region\" aria-label=\"작업 목록 스크롤 영역\"");
    expect(app).toContain('{ name: "jobs", label: "작업"');
    expect(app).toContain('screen === "jobs" && <JobsScreen');
  });
});
