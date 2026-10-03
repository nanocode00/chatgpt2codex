import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  gitArchiveAndDeleteLocalBranch,
  gitCherryPick,
  gitCreateIssue,
  gitCompare,
  gitDeleteLocalBranch,
  gitDeleteRemoteBranch,
  gitDiffCheck,
  gitListBranches,
  gitListBranchArchives,
  gitListIssues,
  gitListStashes,
  gitLog,
  gitRestoreWorktree,
  gitRestoreBranchArchive,
  gitRevertCommit,
  gitShowCommit,
  gitStashApply,
  gitStashDrop,
  gitStashPush,
  gitUnstage,
  gitUpdatePullRequest,
  gitUpdateIssue,
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

  it("refuses regular deletion of an unmerged branch but preserves it before explicit archive-deletion", async () => {
    await git(root, "switch", "-c", "unmerged-feature");
    const featureSha = await commitFile(root, "feature.txt", "unmerged\n", "new feature");
    await git(root, "switch", "main");
    await expect(gitDeleteLocalBranch(root, "unmerged-feature", featureSha)).rejects.toThrow(/merge/i);
    await expect(gitArchiveAndDeleteLocalBranch(root, "unmerged-feature", "f".repeat(40))).rejects.toThrow(/changed/i);

    const result = await gitArchiveAndDeleteLocalBranch(root, "unmerged-feature", featureSha);
    expect(result.archiveRef).toContain("refs/c2c-archive/unmerged-feature/");
    expect(await git(root, "rev-parse", result.archiveRef)).toBe(featureSha);
    expect((await gitListBranches(root)).some((branch) => branch.name === "unmerged-feature")).toBe(false);
    expect(await git(root, "show", `${result.archiveRef}:feature.txt`)).toBe("unmerged");
    expect(await gitListBranchArchives(root)).toContainEqual({ branch: "unmerged-feature", sha: featureSha, archiveRef: result.archiveRef });
    const restored = await gitRestoreBranchArchive(root, "unmerged-feature", featureSha);
    expect(restored).toMatchObject({ restored: true, branch: "unmerged-feature", sha: featureSha });
    expect(await git(root, "rev-parse", "unmerged-feature")).toBe(featureSha);
    await expect(gitRestoreBranchArchive(root, "unmerged-feature", featureSha)).rejects.toThrow(/already exist/i);
    await expect(gitArchiveAndDeleteLocalBranch(root, "main", await git(root, "rev-parse", "main"))).rejects.toThrow(/Protected/i);
  });

  it("checks both working and staged whitespace while leaving files unchanged", async () => {
    expect(await gitDiffCheck(root)).toMatchObject({ ok: true, issues: [] });
    await writeFile(path.join(root, "a.txt"), "one\ntrailing   \n", "utf8");
    const working = await gitDiffCheck(root, "working");
    expect(working.ok).toBe(false);
    expect(working.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "working", message: expect.stringContaining("trailing whitespace") }),
    ]));
    expect((await gitDiffCheck(root, "staged")).ok).toBe(true);
    await git(root, "add", "a.txt");
    const staged = await gitDiffCheck(root, "all");
    expect(staged.ok).toBe(false);
    expect(staged.issues.every((issue) => issue.source === "staged")).toBe(true);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("one\ntrailing   \n");
  });

  it("documents that untracked files are excluded from diff checks", async () => {
    await writeFile(path.join(root, "untracked.txt"), "bad  \n", "utf8");
    const result = await gitDiffCheck(root);
    expect(result.ok).toBe(true);
    expect(result.note).toContain("untracked");
  });

  it("deletes an exact remote branch only after verifying it is merged into the requested origin base", async () => {
    const bare = await mkdtemp(path.join(os.tmpdir(), "c2c-git-remote-"));
    try {
      await git(bare, "init", "--bare");
      await git(root, "remote", "add", "origin", bare);
      await git(root, "push", "-u", "origin", "main");
      await git(root, "branch", "merged-remote");
      await git(root, "push", "origin", "merged-remote");
      const branches = await gitListBranches(root);
      const remote = branches.find((branch) => branch.name === "origin/merged-remote");
      expect(remote?.sha).toMatch(/^[0-9a-f]{40}$/);
      const result = await gitDeleteRemoteBranch(root, "merged-remote", remote!.sha, "main");
      expect(result).toMatchObject({ deleted: true, branch: "merged-remote", baseBranch: "main" });
      await git(root, "fetch", "--prune", "origin");
      expect((await gitListBranches(root)).some((branch) => branch.name === "origin/merged-remote")).toBe(false);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("does not delete a remote branch advanced since the inspected SHA", async () => {
    const bare = await mkdtemp(path.join(os.tmpdir(), "c2c-git-remote-race-"));
    try {
      await git(bare, "init", "--bare");
      await git(root, "remote", "add", "origin", bare);
      await git(root, "push", "-u", "origin", "main");
      await git(root, "branch", "merged-remote");
      await git(root, "push", "origin", "merged-remote");
      const inspectedSha = await git(root, "rev-parse", "refs/remotes/origin/merged-remote");
      await git(root, "switch", "-c", "advance");
      const newerSha = await commitFile(root, "new.txt", "new\n", "advance remote");
      await git(root, "push", "origin", "HEAD:refs/heads/merged-remote");
      await git(root, "update-ref", "refs/remotes/origin/merged-remote", inspectedSha);

      await expect(gitDeleteRemoteBranch(root, "merged-remote", inspectedSha, "main")).rejects.toThrow();
      const remoteTip = await git(root, "ls-remote", "origin", "refs/heads/merged-remote");
      expect(remoteTip.split(/\s+/)[0]).toBe(newerSha);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("updates a PR base through GitHub with an exact head concurrency guard", async () => {
    await git(root, "remote", "add", "origin", "https://github.com/example/repo.git");
    const expectedHead = "a".repeat(40);
    const calls: string[][] = [];
    const result = await gitUpdatePullRequest(root, 9, expectedHead, { baseBranch: "main" }, async (_cwd, args) => {
      calls.push(args);
      if (args[0] === "pr") {
        return { stdout: JSON.stringify({ headRefOid: expectedHead, state: "OPEN" }), stderr: "" };
      }
      return { stdout: JSON.stringify({
        number: 9, state: "open", title: "Retarget me", html_url: "https://github.com/example/repo/pull/9",
        base: { ref: "main" },
      }), stderr: "" };
    });
    expect(result).toMatchObject({ updated: true, number: 9, baseBranch: "main" });
    expect(calls).toContainEqual(["api", "--method", "PATCH", "repos/example/repo/pulls/9", "-f", "base=main"]);
  });

  it("lists issues and updates one only when updatedAt still matches", async () => {
    await git(root, "remote", "add", "origin", "https://github.com/example/repo.git");
    const updatedAt = "2026-09-28T00:00:00Z";
    const calls: string[][] = [];
    const runner = async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "list") {
        return { stdout: JSON.stringify([{ number: 3, title: "Issue", url: "https://github.com/example/repo/issues/3", state: "OPEN", updatedAt, labels: [{ name: "bug" }], assignees: [{ login: "alice" }] }]), stderr: "" };
      }
      if (args[0] === "issue" && args[1] === "view") {
        return { stdout: JSON.stringify({ number: 3, title: "Issue", body: "old", url: "https://github.com/example/repo/issues/3", state: "OPEN", updatedAt, labels: [], assignees: [] }), stderr: "" };
      }
      return { stdout: JSON.stringify({ number: 3, title: "Updated", body: "new", html_url: "https://github.com/example/repo/issues/3", state: "open", updated_at: "2026-09-28T00:01:00Z", labels: [], assignees: [] }), stderr: "" };
    };

    const issues = await gitListIssues(root, "open", 20, runner);
    expect(issues[0]).toMatchObject({ number: 3, labels: ["bug"], assignees: ["alice"], updatedAt });
    const updated = await gitUpdateIssue(root, 3, updatedAt, { title: "Updated", body: "new" }, runner);
    expect(updated).toMatchObject({ number: 3, title: "Updated", body: "new" });
    expect(calls).toContainEqual(["api", "--method", "PATCH", "repos/example/repo/issues/3", "-f", "title=Updated", "-f", "body=new"]);
  });

  it("creates an issue through the repository-scoped GitHub API", async () => {
    await git(root, "remote", "add", "origin", "https://github.com/example/repo.git");
    const calls: string[][] = [];
    const result = await gitCreateIssue(root, "New issue", "Details", async (_cwd, args) => {
      calls.push(args);
      return { stdout: JSON.stringify({ number: 4, title: "New issue", body: "Details", html_url: "https://github.com/example/repo/issues/4", state: "open", updated_at: "2026-09-28T00:02:00Z", labels: [], assignees: [] }), stderr: "" };
    });
    expect(result).toMatchObject({ number: 4, title: "New issue", body: "Details" });
    expect(calls[0]).toEqual(["api", "--method", "POST", "repos/example/repo/issues", "-f", "title=New issue", "-f", "body=Details"]);
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
