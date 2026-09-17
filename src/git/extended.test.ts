import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  gitCherryPick,
  gitCompare,
  gitDeleteLocalBranch,
  gitListBranches,
  gitListStashes,
  gitLog,
  gitRestoreWorktree,
  gitRevertCommit,
  gitShowCommit,
  gitStashApply,
  gitStashDrop,
  gitStashPush,
  gitUnstage,
} from "./extended.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function commitFile(root: string, name: string, content: string, message: string): Promise<string> {
  await writeFile(path.join(root, name), content, "utf8");
  await git(root, "add", name);
  await git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

describe("extended safe git operations", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "c2c-git-extended-"));
    await git(root, "init", "-b", "main");
    await git(root, "config", "user.name", "Test User");
    await git(root, "config", "user.email", "test@example.com");
    await commitFile(root, "a.txt", "one\n", "initial");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists branches and safely deletes a merged non-current branch with an exact SHA", async () => {
    await git(root, "branch", "merged-feature");
    const branches = await gitListBranches(root);
    const feature = branches.find((branch) => branch.name === "merged-feature");
    expect(feature?.scope).toBe("local");
    expect(feature?.current).toBe(false);
    expect(feature?.sha).toMatch(/^[0-9a-f]{40}$/);

    const result = await gitDeleteLocalBranch(root, "merged-feature", feature!.sha);
    expect(result.deleted).toBe(true);
    expect((await gitListBranches(root)).some((branch) => branch.name === "merged-feature")).toBe(false);
  });

  it("creates, lists, applies, and drops a stash without pop semantics", async () => {
    await writeFile(path.join(root, "a.txt"), "changed\n", "utf8");
    const pushed = await gitStashPush(root, "test stash", false);
    expect(pushed.created).toBe(true);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("one\n");

    const stashes = await gitListStashes(root);
    expect(stashes).toHaveLength(1);
    expect(stashes[0]?.subject).toContain("test stash");

    const applied = await gitStashApply(root, stashes[0]!.ref, stashes[0]!.sha);
    expect(applied).toEqual({ applied: true, conflicted: false, conflicts: [] });
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("changed\n");

    await git(root, "restore", "a.txt");
    const dropped = await gitStashDrop(root, stashes[0]!.ref, stashes[0]!.sha);
    expect(dropped.dropped).toBe(true);
    expect(await gitListStashes(root)).toHaveLength(0);
  });

  it("unstages paths and restores tracked worktree paths against an exact HEAD", async () => {
    const head = await git(root, "rev-parse", "HEAD");
    await writeFile(path.join(root, "a.txt"), "two\n", "utf8");
    await git(root, "add", "a.txt");
    expect(await git(root, "diff", "--cached", "--name-only")).toBe("a.txt");

    await gitUnstage(root, ["a.txt"]);
    expect(await git(root, "diff", "--cached", "--name-only")).toBe("");
    await gitRestoreWorktree(root, ["a.txt"], head);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("one\n");
  });

  it("reads bounded history, shows a commit, and compares refs", async () => {
    const first = await git(root, "rev-parse", "HEAD");
    const second = await commitFile(root, "b.txt", "two\n", "second");
    const log = await gitLog(root, 10);
    expect(log[0]?.sha).toBe(second);
    expect(log[0]?.subject).toBe("second");

    const shown = await gitShowCommit(root, second);
    expect(shown.text).toContain("second");
    expect(shown.text).toContain("b.txt");

    const compared = await gitCompare(root, first, second);
    expect(compared.ahead).toBe(1);
    expect(compared.behind).toBe(0);
    expect(compared.summary).toContain("b.txt");
  });

  it("reverts a commit with a HEAD concurrency guard", async () => {
    const added = await commitFile(root, "b.txt", "two\n", "add b");
    const before = await git(root, "rev-parse", "HEAD");
    const result = await gitRevertCommit(root, added, before);
    expect(result.reverted).toBe(true);
    expect(result.newHeadSha).not.toBe(before);
    await expect(readFile(path.join(root, "b.txt"), "utf8")).rejects.toThrow();
  });

  it("cherry-picks a commit with a HEAD concurrency guard", async () => {
    await git(root, "switch", "-c", "feature");
    const sourceCommit = await commitFile(root, "feature.txt", "feature\n", "feature commit");
    await git(root, "switch", "main");
    const before = await git(root, "rev-parse", "HEAD");

    const result = await gitCherryPick(root, sourceCommit, before);
    expect(result.cherryPicked).toBe(true);
    expect(await readFile(path.join(root, "feature.txt"), "utf8")).toBe("feature\n");
  });
});
