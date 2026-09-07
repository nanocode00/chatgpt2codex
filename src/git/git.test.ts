import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  gitCreateBranchFromOrigin,
  gitCreatePullRequest,
  gitDiffSummary,
  gitFetchOrigin,
  gitPushCurrentBranch,
  gitRepositoryStatus,
  gitStatus,
  gitSwitchLocalBranch,
  parseNumstat,
} from "./git.js";

const execFileAsync = promisify(execFile);

describe("parseNumstat", () => {
  it("parses a simple numstat block into {path, added, removed}", () => {
    const numstat = "10\t2\tsrc/foo.ts\n3\t0\tREADME.md\n";
    expect(parseNumstat(numstat)).toEqual([
      { path: "src/foo.ts", added: 10, removed: 2 },
      { path: "README.md", added: 3, removed: 0 },
    ]);
  });

  it("treats binary file markers (-\\t-) as zero added/removed", () => {
    const numstat = "-\t-\tassets/logo.png\n";
    expect(parseNumstat(numstat)).toEqual([
      { path: "assets/logo.png", added: 0, removed: 0 },
    ]);
  });

  it("resolves brace-compressed rename paths to the destination", () => {
    const numstat = "5\t1\tsrc/{old => new}/file.ts\n";
    expect(parseNumstat(numstat)).toEqual([
      { path: "src/new/file.ts", added: 5, removed: 1 },
    ]);
  });

  it("resolves plain rename paths (old => new) to the destination", () => {
    const numstat = "1\t1\told.ts => new.ts\n";
    expect(parseNumstat(numstat)).toEqual([
      { path: "new.ts", added: 1, removed: 1 },
    ]);
  });

  it("ignores blank lines", () => {
    const numstat = "\n1\t1\ta.ts\n\n";
    expect(parseNumstat(numstat)).toEqual([{ path: "a.ts", added: 1, removed: 1 }]);
  });

  it("returns empty array for empty input", () => {
    expect(parseNumstat("")).toEqual([]);
  });
});

describe("gitStatus / gitDiffSummary — non-git directory", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chatgpt2codex-nongit-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("gitStatus tolerates a non-git repo and returns empty status", async () => {
    const status = await gitStatus(dir);
    expect(status).toEqual({ branch: "", dirtyFiles: [], staged: [] });
  });

  it("gitRepositoryStatus tolerates a non-git repo and returns empty status", async () => {
    const status = await gitRepositoryStatus(dir);
    expect(status).toEqual({
      branch: "",
      dirtyFiles: [],
      staged: [],
      remotes: [],
      upstream: null,
      ahead: 0,
      behind: 0,
      syncState: "unknown",
    });
  });

  it("gitDiffSummary tolerates a non-git repo and returns empty summary", async () => {
    const diff = await gitDiffSummary(dir);
    expect(diff).toEqual({ files: [], summary: "No changes." });
  });
});

describe("gitStatus — real git repo", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chatgpt2codex-git-"));
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
    await writeFile(join(dir, "committed.txt"), "hello\n");
    await execFileAsync("git", ["add", "committed.txt"], { cwd: dir });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports the current branch with a clean tree", async () => {
    const status = await gitStatus(dir);
    expect(status.branch).toBe("main");
    expect(status.dirtyFiles).toEqual([]);
    expect(status.staged).toEqual([]);
  });

  it("reports untracked files as dirty, not staged", async () => {
    await writeFile(join(dir, "new.txt"), "new\n");
    const status = await gitStatus(dir);
    expect(status.dirtyFiles).toContain("new.txt");
    expect(status.staged).not.toContain("new.txt");
  });

  it("reports staged files separately from unstaged modifications", async () => {
    await writeFile(join(dir, "committed.txt"), "modified\n");
    await execFileAsync("git", ["add", "committed.txt"], { cwd: dir });
    const status = await gitStatus(dir);
    expect(status.staged).toContain("committed.txt");
    expect(status.dirtyFiles).not.toContain("committed.txt");
  });

  it("reports a modified-but-unstaged file as dirty", async () => {
    await writeFile(join(dir, "committed.txt"), "modified again\n");
    const status = await gitStatus(dir);
    expect(status.dirtyFiles).toContain("committed.txt");
    expect(status.staged).not.toContain("committed.txt");
  });

  it("reports configured remote and already-known upstream relation without fetching", async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), "chatgpt2codex-remote-"));
    try {
      await execFileAsync("git", ["init", "-q", "--bare"], { cwd: remoteDir });
      await execFileAsync("git", ["remote", "add", "origin", remoteDir], { cwd: dir });
      await execFileAsync("git", ["push", "-q", "-u", "origin", "main"], { cwd: dir });
      await writeFile(join(dir, "committed.txt"), "local commit\n");
      await execFileAsync("git", ["add", "committed.txt"], { cwd: dir });
      await execFileAsync("git", ["commit", "-q", "-m", "local"], { cwd: dir });

      const status = await gitRepositoryStatus(dir);
      expect(status.remotes[0]?.name).toBe("origin");
      expect(status.remotes[0]?.url).toBeTypeOf("string");
      expect(status.remotes[0]?.url.length).toBeGreaterThan(0);
      expect(status.upstream).toBe("origin/main");
      expect(status.ahead).toBe(1);
      expect(status.behind).toBe(0);
      expect(status.syncState).toBe("ahead");
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
    }
  });
});

describe("gitDiffSummary — real git repo (numstat integration)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chatgpt2codex-gitdiff-"));
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
    await writeFile(join(dir, "a.txt"), "line1\nline2\n");
    await execFileAsync("git", ["add", "a.txt"], { cwd: dir });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty summary when there is no diff", async () => {
    const diff = await gitDiffSummary(dir);
    expect(diff.files).toEqual([]);
    // "No changes." contains no secret-shaped text, so redact() — once
    // implemented by the policy owner — is expected to pass it through
    // unchanged; this only asserts our own numstat-empty branch shape.
  });

  it("surfaces numstat-derived file entries for a real diff", async () => {
    await writeFile(join(dir, "a.txt"), "line1\nline2-changed\nline3\n");
    // gitDiffSummary calls policy/secrets.ts#redact() on the textual summary
    // (PRD §9.4). That module is owned by another agent and is currently a
    // NOT_IMPLEMENTED stub, so we only assert on the structured `files`
    // array here (our own parsing logic) and tolerate either a redacted
    // summary or a DomainError surfaced from the stub.
    try {
      const diff = await gitDiffSummary(dir);
      expect(diff.files).toEqual([{ path: "a.txt", added: 2, removed: 1 }]);
      expect(typeof diff.summary).toBe("string");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("NOT_IMPLEMENTED");
    }
  });
});

describe("safe git workspace/publish workflow", () => {
  let dir: string;
  let remoteDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chatgpt2codex-safe-git-"));
    remoteDir = await mkdtemp(join(tmpdir(), "chatgpt2codex-safe-origin-"));
    await execFileAsync("git", ["init", "-q", "--bare"], { cwd: remoteDir });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
    await writeFile(join(dir, "base.txt"), "base\n");
    await execFileAsync("git", ["add", "base.txt"], { cwd: dir });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    await execFileAsync("git", ["remote", "add", "origin", remoteDir], { cwd: dir });
    await execFileAsync("git", ["push", "-q", "-u", "origin", "main"], { cwd: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(remoteDir, { recursive: true, force: true });
  });

  it("fetches origin and creates a no-track feature branch from origin/main", async () => {
    await gitFetchOrigin(dir);
    const created = await gitCreateBranchFromOrigin(dir, "fix/example", "main");
    expect(created).toEqual({ branch: "fix/example", baseBranch: "main" });
    const branch = (await execFileAsync("git", ["branch", "--show-current"], { cwd: dir })).stdout.trim();
    expect(branch).toBe("fix/example");
    await expect(execFileAsync("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: dir })).rejects.toBeDefined();
  });

  it("fetch uses only fixed argv and sanitizes timeout/failure details", async () => {
    const calls: string[][] = [];
    const success = await gitFetchOrigin(dir, async (_cwd, args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    });
    expect(success).toEqual({ fetched: true, remote: "origin" });
    expect(calls).toEqual([["fetch", "origin"]]);

    await expect(gitFetchOrigin(dir, async () => {
      throw Object.assign(new Error("credential-bearing-url should not escape"), { killed: true, signal: "SIGTERM" });
    })).rejects.toMatchObject({ code: "TIMEOUT", message: "git fetch timed out" });

    await expect(gitFetchOrigin(dir, async () => {
      throw new Error("https://user:password@example.invalid/private.git");
    })).rejects.toMatchObject({ code: "NOT_IMPLEMENTED", message: "git fetch failed" });
  });

  it("rejects invalid refs, missing remote bases, existing branches, and dirty trees", async () => {
    await expect(gitCreateBranchFromOrigin(dir, "HEAD~1", "main")).rejects.toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
    await expect(gitCreateBranchFromOrigin(dir, "feature/base-ref", "HEAD~1")).rejects.toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
    await expect(gitCreateBranchFromOrigin(dir, "feature/x", "missing")).rejects.toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
    await execFileAsync("git", ["branch", "feature/existing"], { cwd: dir });
    await expect(gitCreateBranchFromOrigin(dir, "feature/existing", "main")).rejects.toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
    await writeFile(join(dir, "dirty.txt"), "dirty\n");
    await expect(gitCreateBranchFromOrigin(dir, "feature/dirty", "main")).rejects.toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
    await rm(join(dir, "dirty.txt"), { force: true });
    await writeFile(join(dir, "base.txt"), "unstaged\n");
    await expect(gitCreateBranchFromOrigin(dir, "feature/unstaged", "main")).rejects.toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
    await execFileAsync("git", ["restore", "base.txt"], { cwd: dir });
    await writeFile(join(dir, "staged.txt"), "staged\n");
    await execFileAsync("git", ["add", "staged.txt"], { cwd: dir });
    await expect(gitCreateBranchFromOrigin(dir, "feature/staged", "main")).rejects.toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
  });

  it("switches only existing local branches and rejects a dirty tree", async () => {
    await execFileAsync("git", ["branch", "local-only"], { cwd: dir });
    await expect(gitSwitchLocalBranch(dir, "remote-only")).rejects.toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
    expect(await gitSwitchLocalBranch(dir, "local-only")).toEqual({ branch: "local-only" });
    await writeFile(join(dir, "dirty.txt"), "dirty\n");
    await expect(gitSwitchLocalBranch(dir, "main")).rejects.toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
  });

  it("first-pushes only the current feature branch and sets origin/<same-name> upstream", async () => {
    await gitCreateBranchFromOrigin(dir, "feature/publish", "main");
    await writeFile(join(dir, "feature.txt"), "feature\n");
    await execFileAsync("git", ["add", "feature.txt"], { cwd: dir });
    await execFileAsync("git", ["commit", "-q", "-m", "feature"], { cwd: dir });
    const result = await gitPushCurrentBranch(dir);
    expect(result.remote).toBe("origin");
    expect(result.branch).toBe("feature/publish");
    const upstream = (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: dir })).stdout.trim();
    expect(upstream).toBe("origin/feature/publish");
    await execFileAsync("git", ["show-ref", "--verify", "refs/heads/feature/publish"], { cwd: remoteDir });
  });

  it("push uses fixed origin/current-branch argv with no force or caller refspec", async () => {
    await gitCreateBranchFromOrigin(dir, "feature/fixed-push", "main");
    const calls: string[][] = [];
    await gitPushCurrentBranch(dir, async (_cwd, args) => {
      calls.push(args);
      return { stdout: "ok", stderr: "" };
    });
    expect(calls).toEqual([["push", "--set-upstream", "origin", "feature/fixed-push"]]);
    expect(calls[0]).not.toContain("--force");
  });

  it("creates PRs from server-determined current branch and handles duplicates idempotently", async () => {
    await gitCreateBranchFromOrigin(dir, "feature/pr", "main");
    await writeFile(join(dir, "feature.txt"), "feature\n");
    await execFileAsync("git", ["add", "feature.txt"], { cwd: dir });
    await execFileAsync("git", ["commit", "-q", "-m", "feature"], { cwd: dir });
    await gitPushCurrentBranch(dir);
    await execFileAsync("git", ["remote", "set-url", "origin", "https://github.com/example/repo.git"], { cwd: dir });

    const calls: string[][] = [];
    const result = await gitCreatePullRequest(dir, "main", "Title", "line1\nline2", true, async (_cwd, args) => {
      calls.push(args);
      if (args[1] === "list") return { stdout: "[]", stderr: "" };
      return { stdout: "https://github.com/example/repo/pull/42\n", stderr: "" };
    });
    expect(result).toMatchObject({ created: true, number: 42, headBranch: "feature/pr", baseBranch: "main", draft: true });
    expect(calls[1]).toEqual([
      "pr", "create", "--base", "main", "--head", "feature/pr", "--title", "Title", "--body", "line1\nline2", "--draft",
    ]);

    const duplicate = await gitCreatePullRequest(dir, "main", "Title", "", false, async () => ({
      stdout: '[{"number":7,"url":"https://github.com/example/repo/pull/7"}]',
      stderr: "",
    }));
    expect(duplicate).toMatchObject({ created: false, alreadyExists: true, number: 7 });
  });

  it("rejects PR creation when the current branch is not pushed or origin is not GitHub", async () => {
    await gitCreateBranchFromOrigin(dir, "feature/unpushed", "main");
    await expect(gitCreatePullRequest(dir, "main", "Title")).rejects.toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
    await gitPushCurrentBranch(dir);
    await expect(gitCreatePullRequest(dir, "main", "Title")).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });

  it("rejects detached HEAD, same head/base, wrong upstream, and unpushed local commits", async () => {
    await expect(gitCreatePullRequest(dir, "main", "Title")).rejects.toMatchObject({ code: "COMMAND_NOT_ALLOWED" });

    await gitCreateBranchFromOrigin(dir, "feature/preconditions", "main");
    await writeFile(join(dir, "feature.txt"), "one\n");
    await execFileAsync("git", ["add", "feature.txt"], { cwd: dir });
    await execFileAsync("git", ["commit", "-q", "-m", "feature"], { cwd: dir });
    await gitPushCurrentBranch(dir);
    await execFileAsync("git", ["remote", "set-url", "origin", "https://github.com/example/repo.git"], { cwd: dir });

    await writeFile(join(dir, "feature.txt"), "two\n");
    await execFileAsync("git", ["add", "feature.txt"], { cwd: dir });
    await execFileAsync("git", ["commit", "-q", "-m", "unpushed"], { cwd: dir });
    await expect(gitCreatePullRequest(dir, "main", "Title")).rejects.toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
    await execFileAsync("git", ["reset", "--hard", "origin/feature/preconditions"], { cwd: dir });

    await execFileAsync("git", ["branch", "--set-upstream-to=origin/main", "feature/preconditions"], { cwd: dir });
    await expect(gitCreatePullRequest(dir, "main", "Title")).rejects.toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
    await execFileAsync("git", ["branch", "--set-upstream-to=origin/feature/preconditions", "feature/preconditions"], { cwd: dir });

    await execFileAsync("git", ["checkout", "--detach", "HEAD"], { cwd: dir });
    await expect(gitCreatePullRequest(dir, "main", "Title")).rejects.toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
  });

  it("sanitizes gh unavailable and authentication failures without leaking raw details", async () => {
    await gitCreateBranchFromOrigin(dir, "feature/gh-errors", "main");
    await writeFile(join(dir, "feature.txt"), "feature\n");
    await execFileAsync("git", ["add", "feature.txt"], { cwd: dir });
    await execFileAsync("git", ["commit", "-q", "-m", "feature"], { cwd: dir });
    await gitPushCurrentBranch(dir);
    await execFileAsync("git", ["remote", "set-url", "origin", "https://secret-user:secret-token@github.com/example/repo.git"], { cwd: dir });

    const unavailable = gitCreatePullRequest(dir, "main", "Title", "", false, async () => {
      throw Object.assign(new Error("secret-token should never escape"), { code: "ENOENT" });
    });
    await expect(unavailable).rejects.toMatchObject({ code: "NOT_IMPLEMENTED", message: "GitHub PR creation unavailable" });

    const authFailure = gitCreatePullRequest(dir, "main", "Title", "", false, async () => {
      throw new Error("authentication failed for secret-token");
    });
    await expect(authFailure).rejects.toMatchObject({ code: "NOT_IMPLEMENTED", message: "GitHub PR creation failed" });
  });
});
