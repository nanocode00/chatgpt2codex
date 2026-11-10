import { describe, expect, it } from "vitest";
import { parseJobList } from "../desktop/src/job-list";

describe("Tauri job-list presentation", () => {
  it("reports a genuine empty durable job list", () => {
    expect(parseJobList({ stateDir: "redacted", jobs: [] })).toEqual([]);
  });
  it("keeps only validated job IDs and ignores project IDs", () => {
    expect(parseJobList({ jobs: [
      { id: "loop-a1", status: "paused", projectId: "proj" },
      { id: "proj", status: "active" }, { id: "loop-a/../../b", status: "active" },
      { id: "loop-valid", status: 3 }
    ] })).toEqual([{ id: "loop-a1", status: "paused", projectId: "proj" }]);
  });
  it("distinguishes malformed output from empty jobs", () => {
    expect(parseJobList(null)).toBeNull();
    expect(parseJobList({ jobs: {} })).toBeNull();
  });
});
