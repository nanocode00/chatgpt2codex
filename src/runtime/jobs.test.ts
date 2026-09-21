import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  durableJobLogs,
  listDurableJobs,
  readDurableJob,
  setDurableJobStatus,
} from "./jobs.js";

describe("durable jobs", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-jobs-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  async function writeJob(id: string, payload: Record<string, unknown>, nested = ""): Promise<void> {
    const dir = path.join(stateDir, "goals", nested);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, id + ".loop.json"),
      JSON.stringify({ loopId: id, ...payload }, null, 2) + "\n",
      "utf8",
    );
  }

  it("lists jobs recursively and derives paused state at max turns", async () => {
    await writeJob("loop-100-a", {
      projectId: "proj",
      mode: "implement",
      maxTurns: 2,
      turns: [
        { turn: 1, lastResult: "one", nextActions: ["next one"] },
        { turn: 2, lastResult: "two", nextActions: ["next two"] },
      ],
    }, "instance-a");

    const jobs = await listDurableJobs(stateDir);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: "loop-100-a",
      status: "paused",
      projectId: "proj",
      turnCount: 2,
      maxTurns: 2,
      nextActions: ["next two"],
    });
  });

  it("changes durable status without losing turns", async () => {
    await writeJob("loop-200-b", {
      status: "active",
      maxTurns: 5,
      turns: [{ turn: 1, lastResult: "done slice", nextActions: ["verify"] }],
    });

    const canceled = await setDurableJobStatus(stateDir, "loop-200-b", "canceled");
    expect(canceled?.status).toBe("canceled");
    expect(canceled?.turnCount).toBe(1);

    const resumed = await setDurableJobStatus(stateDir, "loop-200-b", "active");
    expect(resumed?.status).toBe("active");
    expect((await readDurableJob(stateDir, "loop-200-b"))?.lastResult).toBe("done slice");
  });

  it("returns bounded recent job logs", async () => {
    await writeJob("loop-300-c", {
      turns: Array.from({ length: 5 }, (_, index) => ({
        turn: index + 1,
        lastResult: "result-" + (index + 1),
        nextActions: ["next-" + (index + 1)],
      })),
    });
    const logs = await durableJobLogs(stateDir, "loop-300-c", 2);
    expect(logs?.turns).toHaveLength(2);
    expect(logs?.lastResult).toBe("result-5");
  });
});
