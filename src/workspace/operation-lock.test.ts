import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErrorCode } from "../types.js";
import {
  acquireWorkspaceLock,
  forceReleaseWorkspaceLock,
  listWorkspaceLocks,
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
});
