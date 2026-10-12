import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErrorCode } from "../types.js";
import {
  acquireWorkspaceLock,
  forceReleaseWorkspaceLock,
  guardedForceReleaseWorkspaceLock,
  inspectWorkspaceLock,
  listWorkspaceLocks,
  recoverStaleWorkspaceLock,
} from "./operation-lock.js";

describe("workspace operation locks", () => {
  let stateDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-lock-state-"));
    projectRoot = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-lock-project-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("allows concurrent readers and rejects a writer until readers release", async () => {
    const read1 = await acquireWorkspaceLock(stateDir, projectRoot, "read", "chat-1", { waitMs: 0 });
    const read2 = await acquireWorkspaceLock(stateDir, projectRoot, "read", "chat-2", { waitMs: 0 });

    await expect(
      acquireWorkspaceLock(stateDir, projectRoot, "write", "chat-3", { waitMs: 0 }),
    ).rejects.toMatchObject({ code: ErrorCode.WORKSPACE_LOCKED });

    const locks = await listWorkspaceLocks(stateDir);
    expect(locks).toHaveLength(1);
    expect(locks[0]?.readers.map((reader) => reader.owner).sort()).toEqual(["chat-1", "chat-2"]);
    expect(locks[0]?.writer).toBeNull();

    await read1.release();
    await read2.release();

    const write = await acquireWorkspaceLock(stateDir, projectRoot, "write", "chat-3", { waitMs: 0 });
    expect((await listWorkspaceLocks(stateDir))[0]?.writer?.owner).toBe("chat-3");
    await write.release();
  });

  it("blocks readers while a writer is active and releases safely", async () => {
    const write = await acquireWorkspaceLock(stateDir, projectRoot, "write", "writer", { waitMs: 0 });
    await expect(
      acquireWorkspaceLock(stateDir, projectRoot, "read", "reader", { waitMs: 0 }),
    ).rejects.toMatchObject({ code: ErrorCode.WORKSPACE_LOCKED });

    await write.release();
    const read = await acquireWorkspaceLock(stateDir, projectRoot, "read", "reader", { waitMs: 0 });
    await read.release();
    expect(await listWorkspaceLocks(stateDir)).toEqual([]);
  });

  it("can force-release a lock directory for operator recovery", async () => {
    await acquireWorkspaceLock(stateDir, projectRoot, "write", "writer", { waitMs: 0 });
    expect(await forceReleaseWorkspaceLock(stateDir, projectRoot)).toBe(true);
    expect(await listWorkspaceLocks(stateDir)).toEqual([]);
    expect(await forceReleaseWorkspaceLock(stateDir, projectRoot)).toBe(false);
  });

  it("diagnoses live holders with operation metadata and returns actionable lock failure details", async () => {
    const write = await acquireWorkspaceLock(
      stateDir,
      projectRoot,
      "write",
      "session:owner",
      { waitMs: 0, operation: "git_publish" },
    );

    const diagnostic = await inspectWorkspaceLock(stateDir, projectRoot);
    expect(diagnostic.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    expect(diagnostic).toMatchObject({
      liveCount: 1,
      staleCount: 0,
      invalidRecords: 0,
      safeStaleRecoveryAvailable: false,
      writer: {
        owner: "session:owner",
        pid: process.pid,
        mode: "write",
        operation: "git_publish",
        state: "live",
        staleReason: null,
      },
    });

    await expect(
      acquireWorkspaceLock(
        stateDir,
        projectRoot,
        "read",
        "session:waiter",
        { waitMs: 0, operation: "git_pr" },
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.WORKSPACE_LOCKED,
      details: {
        requestedMode: "read",
        requestedOperation: "git_pr",
        writer: {
          owner: "session:owner",
          pid: process.pid,
          mode: "write",
          operation: "git_publish",
        },
      },
    });

    await write.release();
  });

  it("recovers only provably stale records using an exact snapshot id", async () => {
    await acquireWorkspaceLock(
      stateDir,
      projectRoot,
      "write",
      "session:stale",
      { waitMs: 0, operation: "file_apply_patch" },
    );
    const lockRoots = await readdir(path.join(stateDir, "locks"));
    expect(lockRoots).toHaveLength(1);
    const writer = path.join(stateDir, "locks", lockRoots[0]!, "writer.json");
    const record = JSON.parse(await readFile(writer, "utf8")) as Record<string, unknown>;
    record.expiresAt = Date.now() - 1;
    await writeFile(writer, JSON.stringify(record, null, 2) + "\n", "utf8");

    const before = await inspectWorkspaceLock(stateDir, projectRoot);
    expect(before).toMatchObject({
      liveCount: 0,
      staleCount: 1,
      safeStaleRecoveryAvailable: true,
      writer: {
        state: "stale",
        staleReason: "expired",
        operation: "file_apply_patch",
      },
    });
    expect(before.snapshotId).toMatch(/^[0-9a-f]{64}$/);

    const recovered = await recoverStaleWorkspaceLock(stateDir, projectRoot, before.snapshotId!);
    expect(recovered.recovered).toBe(1);
    expect(recovered.remaining).toMatchObject({
      snapshotId: null,
      liveCount: 0,
      staleCount: 0,
      invalidRecords: 0,
    });
  });

  it("classifies a dead-PID record as provably stale even before TTL expiry", async () => {
    await acquireWorkspaceLock(
      stateDir,
      projectRoot,
      "write",
      "session:dead",
      { waitMs: 0, operation: "command_run" },
    );
    const lockRoots = await readdir(path.join(stateDir, "locks"));
    const writer = path.join(stateDir, "locks", lockRoots[0]!, "writer.json");
    const record = JSON.parse(await readFile(writer, "utf8")) as Record<string, unknown>;
    record.pid = 99_999_999;
    record.expiresAt = Date.now() + 60_000;
    await writeFile(writer, JSON.stringify(record, null, 2) + "\n", "utf8");

    const diagnostic = await inspectWorkspaceLock(stateDir, projectRoot);
    expect(diagnostic).toMatchObject({
      liveCount: 0,
      staleCount: 1,
      writer: {
        state: "stale",
        staleReason: "process-dead",
        operation: "command_run",
      },
    });
    const recovered = await recoverStaleWorkspaceLock(stateDir, projectRoot, diagnostic.snapshotId!);
    expect(recovered.recovered).toBe(1);
  });

  it("refuses stale recovery or force release when the inspected lock snapshot changed", async () => {
    const first = await acquireWorkspaceLock(stateDir, projectRoot, "write", "session:first", { waitMs: 0 });
    const inspected = await inspectWorkspaceLock(stateDir, projectRoot);
    expect(inspected.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    await first.release();

    const second = await acquireWorkspaceLock(stateDir, projectRoot, "write", "session:second", { waitMs: 0 });
    await expect(
      recoverStaleWorkspaceLock(stateDir, projectRoot, inspected.snapshotId!),
    ).rejects.toMatchObject({
      code: ErrorCode.COMMAND_NOT_ALLOWED,
      message: "Workspace lock changed; inspect again",
    });
    await expect(
      guardedForceReleaseWorkspaceLock(stateDir, projectRoot, inspected.snapshotId!),
    ).rejects.toMatchObject({
      code: ErrorCode.COMMAND_NOT_ALLOWED,
      message: "Workspace lock changed; inspect again",
    });

    const current = await inspectWorkspaceLock(stateDir, projectRoot);
    const released = await guardedForceReleaseWorkspaceLock(stateDir, projectRoot, current.snapshotId!);
    expect(released).toMatchObject({ released: true, liveCount: 1, staleCount: 0, invalidRecords: 0 });
    expect((await inspectWorkspaceLock(stateDir, projectRoot)).snapshotId).toBeNull();
    await second.release();
  });

  it("does not classify malformed lock records as safely stale", async () => {
    const handle = await acquireWorkspaceLock(stateDir, projectRoot, "write", "session:seed", { waitMs: 0 });
    const lockRoots = await readdir(path.join(stateDir, "locks"));
    expect(lockRoots).toHaveLength(1);
    const lockRoot = path.join(stateDir, "locks", lockRoots[0]!);
    await handle.release();
    await writeFile(path.join(lockRoot, "writer.json"), "{not-json\n", "utf8");

    const diagnostic = await inspectWorkspaceLock(stateDir, projectRoot);
    expect(diagnostic).toMatchObject({
      invalidRecords: 1,
      liveCount: 0,
      staleCount: 0,
      safeStaleRecoveryAvailable: false,
    });
    expect(diagnostic.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    const recovered = await recoverStaleWorkspaceLock(stateDir, projectRoot, diagnostic.snapshotId!);
    expect(recovered).toMatchObject({
      recovered: 0,
      remaining: {
        invalidRecords: 1,
        liveCount: 0,
        staleCount: 0,
      },
    });
  });
});
