import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { DomainError, ErrorCode } from "../types.js";
import { isSecretPath, redact } from "../policy/secrets.js";

const execFileAsync = promisify(execFile);

/** Options threaded to execFile for every git invocation in this module. */
const EXEC_OPTS = {
  // Never shell:true — args are passed as an argv array, not interpolated.
  windowsHide: true,
  maxBuffer: 10 * 1024 * 1024,
} as const;

const NETWORK_EXEC_OPTS = {
  windowsHide: true,
  maxBuffer: 1024 * 1024,
  timeout: 30_000,
  env: {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GH_PROMPT_DISABLED: "1",
  },
} as const;

const MAX_BRANCH_NAME = 255;
const MAX_PR_TITLE = 256;
const MAX_PR_BODY = 64 * 1024;

/**
 * Run `git <args>` in `cwd` via execFile (array argv, never shell:true).
 * Returns stdout on success. Callers decide how to interpret failures.
 */
async function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { ...EXEC_OPTS, cwd });
}

async function runGitNetwork(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { ...NETWORK_EXEC_OPTS, cwd });
}

async function runGh(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("gh", args, { ...NETWORK_EXEC_OPTS, cwd });
}

function sanitizedProcessError(operation: string, err: unknown): DomainError {
  const e = err as { code?: string | number; killed?: boolean; signal?: string } | undefined;
  if (e?.code === "ENOENT") return new DomainError(ErrorCode.NOT_IMPLEMENTED, `${operation} unavailable`);
  if (e?.killed || e?.signal === "SIGTERM") return new DomainError(ErrorCode.TIMEOUT, `${operation} timed out`);
  return new DomainError(ErrorCode.NOT_IMPLEMENTED, `${operation} failed`);
}

async function validateBranchName(root: string, name: string): Promise<void> {
  if (!name || name.length > MAX_BRANCH_NAME || name.includes("\0") || name.includes("\n") || name.includes("\r") || name.startsWith("-")) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid git branch name");
  }
  try {
    await runGit(root, ["check-ref-format", "--branch", name]);
  } catch {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid git branch name");
  }
}

async function requireCleanWorktree(root: string): Promise<void> {
  const status = await gitStatus(root);
  if (status.dirtyFiles.length > 0 || status.staged.length > 0) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Working tree must be clean");
  }
}

async function refExists(root: string, ref: string): Promise<boolean> {
  try {
    await runGit(root, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

async function currentLocalBranch(root: string): Promise<string> {
  const branch = (await runGit(root, ["branch", "--show-current"])).stdout.trim();
  if (!branch) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Detached HEAD is not supported");
  return branch;
}

/** True if `err` looks like "not a git repository" / git missing, vs a real failure. */
function isNonGitError(err: unknown): boolean {
  const e = err as { code?: string; stderr?: string; message?: string } | undefined;
  if (!e) return false;
  if (e.code === "ENOENT") return true; // git binary not found
  const text = `${e.stderr ?? ""} ${e.message ?? ""}`.toLowerCase();
  return (
    text.includes("not a git repository") ||
    text.includes("not a git repo") ||
    text.includes("no such file or directory")
  );
}

/** Git status summary for a project (PRD §8.6 git_status). */
export async function gitStatus(
  root: string,
): Promise<{ branch: string; dirtyFiles: string[]; staged: string[] }> {
  try {
    let branch = "";
    let hasHead = true;
    try {
      const branchResult = await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
      branch = branchResult.stdout.trim();
    } catch (branchErr) {
      const e = branchErr as { stderr?: string; message?: string };
      const text = `${e.stderr ?? ""} ${e.message ?? ""}`.toLowerCase();
      if (text.includes("ambiguous argument") || text.includes("unknown revision") || text.includes("bad revision") || text.includes("needed a single revision")) {
        hasHead = false;
        branch = (await runGit(root, ["branch", "--show-current"]).catch(() => ({ stdout: "", stderr: "" }))).stdout.trim();
      } else {
        throw branchErr;
      }
    }

    const statusResult = await runGit(root, ["status", "--porcelain=v1"]);
    const dirtyFiles: string[] = [];
    const staged: string[] = [];

    for (const rawLine of statusResult.stdout.split("\n")) {
      if (rawLine.length === 0) continue;
      // Porcelain v1 format: XY PATH  (XY = 2 status chars, then space, then path)
      // For renames the path is "old -> new"; take the destination path.
      const indexStatus = rawLine[0] ?? " ";
      const worktreeStatus = rawLine[1] ?? " ";
      let path = rawLine.slice(3);
      const arrow = path.indexOf(" -> ");
      if (arrow !== -1) {
        path = path.slice(arrow + 4);
      }

      if (indexStatus === "?" && worktreeStatus === "?") {
        // Untracked file: counts as dirty, not staged.
        dirtyFiles.push(path);
        continue;
      }
      if (indexStatus !== " " && indexStatus !== "?") {
        staged.push(path);
      }
      if (worktreeStatus !== " " && worktreeStatus !== "?") {
        dirtyFiles.push(path);
      }
    }

    return { branch, dirtyFiles, staged };
  } catch (err) {
    if (isNonGitError(err)) {
      return { branch: "", dirtyFiles: [], staged: [] };
    }
    throw new DomainError(
      ErrorCode.NOT_IMPLEMENTED,
      `gitStatus failed: ${(err as Error).message ?? String(err)}`,
    );
  }
}

export interface GitRepositoryStatus {
  branch: string;
  dirtyFiles: string[];
  staged: string[];
  remotes: Array<{ name: string; url: string }>;
  upstream: string | null;
  ahead: number;
  behind: number;
  syncState: "unknown" | "up-to-date" | "ahead" | "behind" | "diverged";
}

/** Read-only repository state plus already-known upstream relation; never fetches. */
export async function gitRepositoryStatus(root: string): Promise<GitRepositoryStatus> {
  const status = await gitStatus(root);
  const [remotes, upstream, counts] = await Promise.all([
    listGitRemotes(root),
    readGitUpstream(root),
    readGitAheadBehind(root),
  ]);
  return {
    ...status,
    remotes,
    upstream,
    ahead: counts.ahead,
    behind: counts.behind,
    syncState: syncState(upstream, counts.ahead, counts.behind),
  };
}

async function listGitRemotes(root: string): Promise<Array<{ name: string; url: string }>> {
  try {
    const result = await runGit(root, ["remote", "-v"]);
    const remotes = new Map<string, string>();
    for (const line of result.stdout.split("\n")) {
      const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
      if (!match || match[3] !== "fetch") continue;
      remotes.set(match[1] ?? "", redact(match[2] ?? ""));
    }
    return Array.from(remotes, ([name, url]) => ({ name, url })).filter((remote) => remote.name.length > 0);
  } catch (err) {
    if (isNonGitError(err)) return [];
    return [];
  }
}

async function readGitUpstream(root: string): Promise<string | null> {
  try {
    const result = await runGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function readGitAheadBehind(root: string): Promise<{ ahead: number; behind: number }> {
  try {
    const result = await runGit(root, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
    const [aheadRaw, behindRaw] = result.stdout.trim().split(/\s+/);
    return {
      ahead: Number.parseInt(aheadRaw ?? "0", 10) || 0,
      behind: Number.parseInt(behindRaw ?? "0", 10) || 0,
    };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

function syncState(
  upstream: string | null,
  ahead: number,
  behind: number,
): GitRepositoryStatus["syncState"] {
  if (!upstream) return "unknown";
  if (ahead > 0 && behind > 0) return "diverged";
  if (ahead > 0) return "ahead";
  if (behind > 0) return "behind";
  return "up-to-date";
}

/**
 * Git diff summary with secret redaction applied (PRD §8.6
 * git_diff_summary, §9.4 outputGuard).
 */
export async function gitDiffSummary(
  root: string,
): Promise<{ files: { path: string; added: number; removed: number }[]; summary: string }> {
  let files: { path: string; added: number; removed: number }[];
  try {
    const result = await runGit(root, ["diff", "--numstat"]);
    files = parseNumstat(result.stdout);
  } catch (err) {
    if (isNonGitError(err)) {
      // Non-git repos have no diff to summarize; nothing textual to redact.
      return { files: [], summary: "No changes." };
    }
    throw new DomainError(
      ErrorCode.NOT_IMPLEMENTED,
      `gitDiffSummary failed: ${(err as Error).message ?? String(err)}`,
    );
  }
  const summary = redact(buildSummary(files));
  return { files, summary };
}

export async function gitStageAndCommit(
  root: string,
  message: string,
  paths?: string[],
): Promise<{ commit: string; branch: string; stagedFiles: string[]; stdout: string; stderr: string }> {
  const addArgs = paths && paths.length > 0 ? ["add", "--", ...paths] : ["add", "-A"];
  await runGit(root, addArgs);

  const stagedResult = await runGit(root, ["diff", "--cached", "--name-only"]);
  const stagedFiles = stagedResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const secretFiles = stagedFiles.filter((file) => isSecretPath(path.resolve(root, file)));
  if (secretFiles.length > 0) {
    await runGit(root, ["reset", "--", ...secretFiles]).catch(() => ({ stdout: "", stderr: "" }));
    throw new DomainError(ErrorCode.SECRET_BLOCKED, "Refusing to commit secret-classified paths", {
      paths: secretFiles,
    });
  }

  if (stagedFiles.length === 0) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "No staged changes to commit");
  }

  const commitResult = await runGit(root, ["commit", "-m", message]);
  const head = await runGit(root, ["rev-parse", "--short", "HEAD"]);
  const branch = await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return {
    commit: head.stdout.trim(),
    branch: branch.stdout.trim(),
    stagedFiles,
    stdout: redact(commitResult.stdout),
    stderr: redact(commitResult.stderr),
  };
}

export async function gitPush(
  root: string,
  remote = "origin",
  branch?: string,
): Promise<{ remote: string; branch: string; stdout: string; stderr: string }> {
  const targetBranch = branch || (await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  const result = await runGit(root, ["push", "-u", remote, targetBranch]);
  return {
    remote,
    branch: targetBranch,
    stdout: redact(result.stdout),
    stderr: redact(result.stderr),
  };
}

type GitProcessRunner = (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export async function gitFetchOrigin(
  root: string,
  runner: GitProcessRunner = runGitNetwork,
): Promise<{ fetched: true; remote: "origin" }> {
  try {
    await runner(root, ["fetch", "origin"]);
    return { fetched: true, remote: "origin" };
  } catch (err) {
    throw sanitizedProcessError("git fetch", err);
  }
}

export async function gitCreateBranchFromOrigin(
  root: string,
  branchName: string,
  baseBranch: string,
): Promise<{ branch: string; baseBranch: string }> {
  await validateBranchName(root, branchName);
  await validateBranchName(root, baseBranch);
  await requireCleanWorktree(root);
  if (await refExists(root, `refs/heads/${branchName}`)) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Local branch already exists");
  }
  const baseRef = `refs/remotes/origin/${baseBranch}`;
  if (!(await refExists(root, baseRef))) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Remote base branch does not exist");
  }
  await runGit(root, ["switch", "--no-track", "-c", branchName, baseRef]);
  return { branch: branchName, baseBranch };
}

export async function gitSwitchLocalBranch(root: string, branchName: string): Promise<{ branch: string }> {
  await validateBranchName(root, branchName);
  await requireCleanWorktree(root);
  if (!(await refExists(root, `refs/heads/${branchName}`))) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Local branch does not exist");
  }
  await runGit(root, ["switch", branchName]);
  return { branch: branchName };
}

export interface GitFastForwardResult {
  branch: string;
  updated: boolean;
  alreadyUpToDate: boolean;
  beforeSha: string;
  afterSha: string;
  advancedBy: number;
}

async function readAheadBehindAgainst(root: string, target: string): Promise<{ ahead: number; behind: number }> {
  const result = await runGit(root, ["rev-list", "--left-right", "--count", `HEAD...${target}`]);
  const [aheadRaw, behindRaw] = result.stdout.trim().split(/\s+/);
  return {
    ahead: Number.parseInt(aheadRaw ?? "0", 10) || 0,
    behind: Number.parseInt(behindRaw ?? "0", 10) || 0,
  };
}

async function verifyFastForwardPostconditions(
  root: string,
  branch: string,
  expectedUpstream: string,
  targetSha: string,
): Promise<string> {
  const afterBranch = await currentLocalBranch(root);
  const afterSha = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
  const afterUpstream = await readGitUpstream(root);
  await requireCleanWorktree(root);
  const postRelation = await readAheadBehindAgainst(root, `refs/remotes/origin/${branch}`);
  if (
    afterBranch !== branch ||
    afterSha !== targetSha ||
    afterUpstream !== expectedUpstream ||
    postRelation.ahead !== 0 ||
    postRelation.behind !== 0
  ) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Git fast-forward postcondition verification failed");
  }
  return afterSha;
}

export async function gitFastForwardCurrentBranch(
  root: string,
  mutationRunner: GitProcessRunner = runGit,
): Promise<GitFastForwardResult> {
  const branch = await currentLocalBranch(root);
  await requireCleanWorktree(root);

  const expectedUpstream = `origin/${branch}`;
  const upstream = await readGitUpstream(root);
  if (upstream !== expectedUpstream) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Current branch must track origin/<current-branch>");
  }

  const remoteRef = `refs/remotes/origin/${branch}`;
  if (!(await refExists(root, remoteRef))) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Current branch remote-tracking ref does not exist");
  }

  const beforeSha = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
  const targetSha = (await runGit(root, ["rev-parse", "--verify", `${remoteRef}^{commit}`])).stdout.trim();
  const relation = await readAheadBehindAgainst(root, targetSha);

  if (relation.ahead > 0 && relation.behind > 0) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Current branch has diverged from origin");
  }
  if (relation.ahead > 0) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Current branch has local commits");
  }

  if (relation.behind === 0) {
    const afterSha = await verifyFastForwardPostconditions(root, branch, expectedUpstream, targetSha);
    return {
      branch,
      updated: false,
      alreadyUpToDate: true,
      beforeSha,
      afterSha,
      advancedBy: 0,
    };
  }

  try {
    await runGit(root, ["merge-base", "--is-ancestor", "HEAD", targetSha]);
  } catch {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Current branch is not an ancestor of origin");
  }

  try {
    await mutationRunner(root, ["merge", "--ff-only", targetSha]);
  } catch {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Git fast-forward failed");
  }

  const afterSha = await verifyFastForwardPostconditions(root, branch, expectedUpstream, targetSha);

  return {
    branch,
    updated: true,
    alreadyUpToDate: false,
    beforeSha,
    afterSha,
    advancedBy: relation.behind,
  };
}

export async function gitPushCurrentBranch(
  root: string,
  runner: GitProcessRunner = runGitNetwork,
): Promise<{ remote: "origin"; branch: string; stdout: string; stderr: string }> {
  const branch = await currentLocalBranch(root);
  const upstream = await readGitUpstream(root);
  if (upstream && upstream !== `origin/${branch}`) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Current branch has an unexpected upstream");
  }
  try {
    const args = upstream ? ["push", "origin", branch] : ["push", "--set-upstream", "origin", branch];
    const result = await runner(root, args);
    return { remote: "origin", branch, stdout: redact(result.stdout), stderr: redact(result.stderr) };
  } catch (err) {
    throw sanitizedProcessError("git push", err);
  }
}

function assertTextInput(value: string, label: string, maxLength: number): void {
  if (!value || value.length > maxLength || value.includes("\0")) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Invalid ${label}`);
  }
}

export function githubRepositoryFromOrigin(url: string): string | null {
  if (!url || url.includes("\0") || url.includes("\n") || url.includes("\r")) return null;

  let pathname: string | null = null;
  try {
    if (/^https?:\/\//i.test(url) || /^ssh:\/\//i.test(url)) {
      const parsed = new URL(url);
      if (parsed.hostname.toLowerCase() !== "github.com") return null;
      pathname = parsed.pathname;
    } else {
      const scpLike = url.match(/^[^@\s]+@github\.com:(.+)$/i);
      if (!scpLike) return null;
      pathname = scpLike[1] ?? null;
    }
  } catch {
    return null;
  }

  if (!pathname) return null;
  const parts = pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2) return null;
  const owner = parts[0] ?? "";
  const repo = (parts[1] ?? "").replace(/\.git$/i, "");
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

async function originUrl(root: string): Promise<string> {
  try {
    return (await runGit(root, ["remote", "get-url", "origin"])).stdout.trim();
  } catch {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "origin remote is required");
  }
}

export interface GitPullRequestResult {
  created: boolean;
  alreadyExists: boolean;
  number: number;
  url: string;
  headBranch: string;
  baseBranch: string;
  draft: boolean;
}

export interface GitPrChecksSummary {
  total: number;
  pending: number;
  successful: number;
  failed: number;
}

export interface GitPrInspection {
  number: number;
  url: string;
  state: string;
  draft: boolean;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  mergeable: boolean | null;
  mergeState: string | null;
  reviewDecision: string | null;
  checks: GitPrChecksSummary;
  merged: boolean;
  mergedCommitSha: string | null;
}

function assertPrNumber(prNumber: number): void {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid PR number");
  }
}

function assertFullGitSha(sha: string): void {
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid expected PR head SHA");
  }
}

function summarizeStatusChecks(value: unknown): GitPrChecksSummary {
  const rows = Array.isArray(value) ? value : [];
  const result: GitPrChecksSummary = { total: rows.length, pending: 0, successful: 0, failed: 0 };
  const successful = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  const failed = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"]);
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      result.pending += 1;
      continue;
    }
    const record = row as Record<string, unknown>;
    const raw = [record.conclusion, record.state, record.status].find((item) => typeof item === "string") as string | undefined;
    const status = raw?.toUpperCase() ?? "UNKNOWN";
    if (successful.has(status)) result.successful += 1;
    else if (failed.has(status)) result.failed += 1;
    else result.pending += 1;
  }
  return result;
}

function normalizeGitPrView(raw: unknown): GitPrInspection {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "GitHub PR inspection returned an unexpected response");
  }
  const record = raw as Record<string, unknown>;
  const number = record.number;
  const url = record.url;
  const state = record.state;
  const draft = record.isDraft;
  const baseBranch = record.baseRefName;
  const headBranch = record.headRefName;
  const headSha = record.headRefOid;
  const mergeableRaw = record.mergeable;
  if (
    typeof number !== "number" || !Number.isInteger(number) || number <= 0 ||
    typeof url !== "string" || typeof state !== "string" || typeof draft !== "boolean" ||
    typeof baseBranch !== "string" || typeof headBranch !== "string" ||
    typeof headSha !== "string" || !/^[0-9a-f]{40}$/i.test(headSha)
  ) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "GitHub PR inspection returned an unexpected response");
  }
  const mergeCommit = record.mergeCommit;
  const mergedCommitSha = mergeCommit && typeof mergeCommit === "object" && typeof (mergeCommit as Record<string, unknown>).oid === "string"
    ? String((mergeCommit as Record<string, unknown>).oid)
    : null;
  const stateUpper = state.toUpperCase();
  const merged = stateUpper === "MERGED" || typeof record.mergedAt === "string";
  return {
    number,
    url,
    state: stateUpper,
    draft,
    baseBranch,
    headBranch,
    headSha,
    mergeable: mergeableRaw === "MERGEABLE" ? true : mergeableRaw === "CONFLICTING" ? false : null,
    mergeState: typeof record.mergeStateStatus === "string" ? record.mergeStateStatus : null,
    reviewDecision: typeof record.reviewDecision === "string" && record.reviewDecision.length > 0 ? record.reviewDecision : null,
    checks: summarizeStatusChecks(record.statusCheckRollup),
    merged,
    mergedCommitSha,
  };
}

async function githubRepositoryForRoot(root: string): Promise<string> {
  const remoteUrl = await originUrl(root);
  const repository = githubRepositoryFromOrigin(remoteUrl);
  if (!repository) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "GitHub origin is required for PR operations");
  return repository;
}

export async function gitInspectPullRequest(
  root: string,
  prNumber: number,
  ghRunner: GitProcessRunner = runGh,
): Promise<GitPrInspection> {
  assertPrNumber(prNumber);
  const repository = await githubRepositoryForRoot(root);
  try {
    const viewed = await ghRunner(root, [
      "pr", "view", String(prNumber), "--repo", repository,
      "--json", "number,url,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,mergedAt,mergeCommit",
    ]);
    return normalizeGitPrView(JSON.parse(viewed.stdout));
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw sanitizedProcessError("GitHub PR inspection", err);
  }
}

export interface GitPrMergeResult {
  merged: true;
  alreadyMerged: boolean;
  number: number;
  url: string;
  mergeMethod: "merge" | "squash" | "rebase";
  expectedHeadSha: string;
  mergedCommitSha: string;
  baseBranch: string;
  headBranch: string;
}

export async function gitMergePullRequest(
  root: string,
  prNumber: number,
  expectedHeadSha: string,
  mergeMethod: "merge" | "squash" | "rebase" = "merge",
  ghRunner: GitProcessRunner = runGh,
): Promise<GitPrMergeResult> {
  assertPrNumber(prNumber);
  assertFullGitSha(expectedHeadSha);
  const repository = await githubRepositoryForRoot(root);
  const before = await gitInspectPullRequest(root, prNumber, ghRunner);
  if (before.headSha.toLowerCase() !== expectedHeadSha.toLowerCase()) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "PR head changed; inspect again");
  }
  if (before.merged) {
    if (!before.mergedCommitSha) {
      throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Merged PR commit could not be verified");
    }
    return {
      merged: true,
      alreadyMerged: true,
      number: before.number,
      url: before.url,
      mergeMethod,
      expectedHeadSha,
      mergedCommitSha: before.mergedCommitSha,
      baseBranch: before.baseBranch,
      headBranch: before.headBranch,
    };
  }
  if (before.state !== "OPEN") throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "PR is not open");
  if (before.draft) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Draft PR cannot be merged");
  if (!before.baseBranch || !before.headBranch || before.baseBranch === before.headBranch) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "PR head/base is invalid");
  }
  if (before.mergeable !== true) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "PR is not mergeable yet");
  if (before.reviewDecision === "CHANGES_REQUESTED") throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "PR has requested changes");
  if (before.checks.failed > 0) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "PR has failing checks");
  if (before.checks.pending > 0) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "PR has pending checks");

  const methodFlag = mergeMethod === "squash" ? "--squash" : mergeMethod === "rebase" ? "--rebase" : "--merge";
  try {
    await ghRunner(root, [
      "pr", "merge", String(prNumber), "--repo", repository, methodFlag,
      "--match-head-commit", expectedHeadSha,
    ]);
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw sanitizedProcessError("GitHub PR merge", err);
  }
  const after = await gitInspectPullRequest(root, prNumber, ghRunner);
  if (!after.merged || !after.mergedCommitSha || after.headSha.toLowerCase() !== expectedHeadSha.toLowerCase()) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "GitHub PR merge could not be verified");
  }
  return {
    merged: true,
    alreadyMerged: false,
    number: after.number,
    url: after.url,
    mergeMethod,
    expectedHeadSha,
    mergedCommitSha: after.mergedCommitSha,
    baseBranch: after.baseBranch,
    headBranch: after.headBranch,
  };
}

export async function gitCreatePullRequest(
  root: string,
  baseBranch: string,
  title: string,
  body = "",
  draft = false,
  ghRunner: (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string }> = runGh,
): Promise<GitPullRequestResult> {
  await validateBranchName(root, baseBranch);
  assertTextInput(title, "PR title", MAX_PR_TITLE);
  if (body.length > MAX_PR_BODY || body.includes("\0")) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid PR body");
  const headBranch = await currentLocalBranch(root);
  if (headBranch === baseBranch) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Head and base branch must differ");
  if (!(await refExists(root, `refs/remotes/origin/${baseBranch}`))) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Remote base branch does not exist");
  }
  if (!(await refExists(root, `refs/remotes/origin/${headBranch}`))) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Push current branch first");
  }
  const upstream = await readGitUpstream(root);
  if (upstream !== `origin/${headBranch}`) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Current branch upstream must match origin");
  const localHead = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
  const remoteHead = (await runGit(root, ["rev-parse", `refs/remotes/origin/${headBranch}`])).stdout.trim();
  if (localHead !== remoteHead) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Push current branch first");
  const remoteUrl = await originUrl(root);
  const repository = githubRepositoryFromOrigin(remoteUrl);
  if (!repository) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "GitHub origin is required for PR creation");

  try {
    const existing = await ghRunner(root, [
      "pr", "list", "--repo", repository, "--state", "open", "--head", headBranch, "--base", baseBranch,
      "--json", "number,url", "--limit", "1",
    ]);
    const rows = JSON.parse(existing.stdout || "[]") as Array<{ number?: number; url?: string }>;
    const first = rows[0];
    if (first?.number && first.url) {
      return { created: false, alreadyExists: true, number: first.number, url: first.url, headBranch, baseBranch, draft };
    }
    const args = ["pr", "create", "--repo", repository, "--base", baseBranch, "--head", headBranch, "--title", title, "--body", body];
    if (draft) args.push("--draft");
    const created = await ghRunner(root, args);
    const url = created.stdout.trim().split(/\s+/).find((part: string) => /^https:\/\/github\.com\/.+\/pull\/\d+$/.test(part));
    const numberMatch = url?.match(/\/pull\/(\d+)$/);
    if (!url || !numberMatch) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "GitHub PR creation returned an unexpected response");
    return { created: true, alreadyExists: false, number: Number(numberMatch[1]), url, headBranch, baseBranch, draft };
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw sanitizedProcessError("GitHub PR creation", err);
  }
}

/**
 * Parse `git diff --numstat` output into structured file entries.
 * Format per line: "<added>\t<removed>\t<path>" (binary files use "-\t-\tpath").
 * Exported for testing.
 */
export function parseNumstat(
  numstat: string,
): { path: string; added: number; removed: number }[] {
  const files: { path: string; added: number; removed: number }[] = [];
  for (const rawLine of numstat.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const addedRaw = parts[0] ?? "0";
    const removedRaw = parts[1] ?? "0";
    // path may contain tabs in exotic cases; rejoin remainder defensively.
    let path = parts.slice(2).join("\t");
    const arrow = path.indexOf(" => ");
    if (arrow !== -1) {
      // Rename/copy with common-prefix compression, e.g. "src/{old => new}.ts"
      // or plain "old => new". Prefer the destination side.
      path = resolveRenamePath(path);
    }
    const added = addedRaw === "-" ? 0 : Number.parseInt(addedRaw, 10) || 0;
    const removed = removedRaw === "-" ? 0 : Number.parseInt(removedRaw, 10) || 0;
    files.push({ path, added, removed });
  }
  return files;
}

/** Resolve a numstat rename path like "a/{b => c}/d" or "a/b => a/c" to the destination. */
function resolveRenamePath(path: string): string {
  const braceMatch = path.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braceMatch) {
    const [, prefix, , to, suffix] = braceMatch;
    return `${prefix ?? ""}${to ?? ""}${suffix ?? ""}`;
  }
  const plainArrow = path.split(" => ");
  if (plainArrow.length === 2) {
    return plainArrow[1] ?? path;
  }
  return path;
}

/** Build a short human-readable diff summary line, pre-redaction. */
function buildSummary(
  files: { path: string; added: number; removed: number }[],
): string {
  if (files.length === 0) return "No changes.";
  const totalAdded = files.reduce((sum, f) => sum + f.added, 0);
  const totalRemoved = files.reduce((sum, f) => sum + f.removed, 0);
  const fileList = files
    .map((f) => `${f.path} (+${f.added}/-${f.removed})`)
    .join(", ");
  return `${files.length} file(s) changed, +${totalAdded}/-${totalRemoved}: ${fileList}`;
}
