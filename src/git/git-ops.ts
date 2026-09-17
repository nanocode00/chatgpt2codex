import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DomainError, ErrorCode } from "../types.js";
import { isSecretPath, redact } from "../policy/secrets.js";
import { gitStatus } from "./git.js";

const execFileAsync = promisify(execFile);

const EXEC_OPTS = {
  windowsHide: true,
  maxBuffer: 10 * 1024 * 1024,
  env: {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_EDITOR: "true",
  },
} as const;

const MAX_BRANCH_NAME = 255;
const MAX_STASH_MESSAGE = 256;
const MAX_PATHS = 100;
const MAX_HISTORY = 50;
const MAX_SHOW_BYTES = 256 * 1024;

export type GitOperationKind = "merge" | "cherry-pick" | "revert" | "rebase" | "none";

export interface GitBranchEntry {
  name: string;
  sha: string;
  current: boolean;
  upstream: string | null;
}

export interface GitBranchListResult {
  current: string;
  local: GitBranchEntry[];
  remote: Array<{ name: string; sha: string }>;
}

export interface GitStashEntry {
  index: number;
  ref: string;
  sha: string;
  message: string;
}

export interface GitConflictStatus {
  operation: GitOperationKind;
  conflicts: string[];
  branch: string;
  dirtyFiles: string[];
  staged: string[];
}

export interface GitHistoryEntry {
  sha: string;
  shortSha: string;
  author: string;
  authoredAt: string;
  subject: string;
}

export interface GitCompareFile {
  path: string;
  added: number;
  removed: number;
}

type GitResult = { stdout: string; stderr: string };
type GitAllowFailureResult = GitResult & { code: number };

async function runGit(root: string, args: string[]): Promise<GitResult> {
  return execFileAsync("git", args, { ...EXEC_OPTS, cwd: root });
}

async function runGitAllowFailure(root: string, args: string[]): Promise<GitAllowFailureResult> {
  try {
    const result = await runGit(root, args);
    return { ...result, code: 0 };
  } catch (err) {
    const e = err as Error & { code?: string | number; stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    if (e.code === "ENOENT") throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "git unavailable");
    if (e.killed || e.signal === "SIGTERM") throw new DomainError(ErrorCode.TIMEOUT, "git operation timed out");
    if (typeof e.code === "number") {
      return { code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "git operation failed");
  }
}

function commandFailure(operation: string): DomainError {
  return new DomainError(ErrorCode.NOT_IMPLEMENTED, `${operation} failed`);
}

async function validateBranchName(root: string, name: string): Promise<void> {
  if (
    !name ||
    name.length > MAX_BRANCH_NAME ||
    name.includes("\0") ||
    name.includes("\n") ||
    name.includes("\r") ||
    name.startsWith("-")
  ) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid git branch name");
  }
  try {
    await runGit(root, ["check-ref-format", "--branch", name]);
  } catch {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid git branch name");
  }
}

function assertFullSha(sha: string, label = "commit SHA"): void {
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Invalid ${label}`);
  }
}

async function currentBranch(root: string): Promise<string> {
  const branch = (await runGit(root, ["branch", "--show-current"])).stdout.trim();
  if (!branch) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Detached HEAD is not supported");
  return branch;
}

async function requireCleanWorktree(root: string): Promise<void> {
  const status = await gitStatus(root);
  if (status.dirtyFiles.length > 0 || status.staged.length > 0) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Working tree must be clean");
  }
}

function validateRelativePaths(root: string, paths: string[]): string[] {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_PATHS) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid git path list");
  }
  return paths.map((raw) => {
    if (
      !raw ||
      raw === "." ||
      raw.includes("\0") ||
      raw.includes("\n") ||
      raw.includes("\r") ||
      path.isAbsolute(raw) ||
      raw.startsWith("-")
    ) {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid git path");
    }
    const abs = path.resolve(root, raw);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "Git path must stay inside the project");
    }
    return rel.split(path.sep).join("/");
  });
}

async function requireTrackedPaths(root: string, paths: string[]): Promise<void> {
  for (const rel of paths) {
    const result = await runGitAllowFailure(root, ["ls-files", "--error-unmatch", "--", rel]);
    if (result.code !== 0) {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Path is not tracked: ${rel}`);
    }
  }
}

function assertNoSecretPaths(root: string, paths: string[]): void {
  const secret = paths.filter((rel) => isSecretPath(path.resolve(root, rel)));
  if (secret.length > 0) {
    throw new DomainError(ErrorCode.SECRET_BLOCKED, "Git operation blocked for secret-classified paths", { paths: secret });
  }
}

async function resolveCommitRef(root: string, ref: string): Promise<string> {
  let candidate: string;
  if (ref === "HEAD") {
    candidate = "HEAD";
  } else if (/^[0-9a-f]{40}$/i.test(ref)) {
    candidate = ref;
  } else if (ref.startsWith("origin/")) {
    const branch = ref.slice("origin/".length);
    await validateBranchName(root, branch);
    candidate = `refs/remotes/origin/${branch}`;
  } else {
    await validateBranchName(root, ref);
    candidate = `refs/heads/${ref}`;
  }
  try {
    return (await runGit(root, ["rev-parse", "--verify", `${candidate}^{commit}`])).stdout.trim();
  } catch {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Git ref does not resolve to a commit: ${ref}`);
  }
}

async function gitPathExists(root: string, gitPath: string): Promise<boolean> {
  try {
    const resolved = (await runGit(root, ["rev-parse", "--git-path", gitPath])).stdout.trim();
    await access(path.isAbsolute(resolved) ? resolved : path.resolve(root, resolved));
    return true;
  } catch {
    return false;
  }
}

async function detectOperation(root: string): Promise<GitOperationKind> {
  if (await gitPathExists(root, "MERGE_HEAD")) return "merge";
  if (await gitPathExists(root, "CHERRY_PICK_HEAD")) return "cherry-pick";
  if (await gitPathExists(root, "REVERT_HEAD")) return "revert";
  if ((await gitPathExists(root, "rebase-merge")) || (await gitPathExists(root, "rebase-apply"))) return "rebase";
  return "none";
}

async function conflictFiles(root: string): Promise<string[]> {
  try {
    return (await runGit(root, ["diff", "--name-only", "--diff-filter=U"]))
      .stdout.split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function gitListBranches(root: string): Promise<GitBranchListResult> {
  const current = await currentBranch(root);
  const result = await runGit(root, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD)",
    "refs/heads",
    "refs/remotes/origin",
  ]);
  const local: GitBranchEntry[] = [];
  const remote: Array<{ name: string; sha: string }> = [];
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const [refname = "", sha = "", upstream = "", head = ""] = line.split("\0");
    if (refname.startsWith("refs/heads/")) {
      local.push({
        name: refname.slice("refs/heads/".length),
        sha,
        current: head.trim() === "*",
        upstream: upstream || null,
      });
    } else if (refname.startsWith("refs/remotes/origin/")) {
      const name = refname.slice("refs/remotes/origin/".length);
      if (name !== "HEAD") remote.push({ name, sha });
    }
  }
  local.sort((a, b) => a.name.localeCompare(b.name));
  remote.sort((a, b) => a.name.localeCompare(b.name));
  return { current, local, remote };
}

export async function gitDeleteLocalBranch(root: string, branchName: string): Promise<{ deleted: true; branch: string }> {
  await validateBranchName(root, branchName);
  if ((await currentBranch(root)) === branchName) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Cannot delete the current branch");
  }
  const result = await runGitAllowFailure(root, ["branch", "-d", "--", branchName]);
  if (result.code !== 0) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Branch is missing or not safely merged");
  return { deleted: true, branch: branchName };
}

export async function gitListStashes(root: string): Promise<GitStashEntry[]> {
  const result = await runGit(root, ["stash", "list", "--format=%gd%x00%H%x00%gs"]);
  const entries: GitStashEntry[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const [ref = "", sha = "", message = ""] = line.split("\0");
    const match = ref.match(/^stash@\{(\d+)\}$/);
    if (!match || !/^[0-9a-f]{40}$/i.test(sha)) continue;
    entries.push({ index: Number(match[1]), ref, sha, message: redact(message) });
    if (entries.length >= MAX_HISTORY) break;
  }
  return entries;
}

async function requireStash(root: string, index: number, expectedSha: string): Promise<GitStashEntry> {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_HISTORY) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid stash index");
  }
  assertFullSha(expectedSha, "stash SHA");
  const entry = (await gitListStashes(root)).find((item) => item.index === index);
  if (!entry) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Stash entry does not exist");
  if (entry.sha.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new DomainError(ErrorCode.HASH_MISMATCH, "Stash changed; list stashes again");
  }
  return entry;
}

export async function gitStashPush(root: string, message = "chatgpt2codex stash"): Promise<GitStashEntry> {
  if (!message || message.length > MAX_STASH_MESSAGE || message.includes("\0") || message.includes("\n") || message.includes("\r")) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid stash message");
  }
  const status = await gitStatus(root);
  const changed = Array.from(new Set([...status.dirtyFiles, ...status.staged]));
  if (changed.length === 0) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "No changes to stash");
  assertNoSecretPaths(root, changed);
  const result = await runGitAllowFailure(root, ["stash", "push", "-u", "-m", message]);
  if (result.code !== 0) throw commandFailure("git stash push");
  await requireCleanWorktree(root);
  const entry = (await gitListStashes(root))[0];
  if (!entry) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Created stash could not be verified");
  return entry;
}

export async function gitStashApply(
  root: string,
  index: number,
  expectedStashSha: string,
): Promise<{ applied: boolean; conflicted: boolean; stash: GitStashEntry; conflicts: string[] }> {
  await requireCleanWorktree(root);
  const stash = await requireStash(root, index, expectedStashSha);
  const result = await runGitAllowFailure(root, ["stash", "apply", "--index", stash.ref]);
  const conflicts = await conflictFiles(root);
  if (result.code !== 0 && conflicts.length === 0) throw commandFailure("git stash apply");
  return { applied: result.code === 0, conflicted: conflicts.length > 0, stash, conflicts };
}

export async function gitStashDrop(
  root: string,
  index: number,
  expectedStashSha: string,
): Promise<{ dropped: true; index: number; sha: string }> {
  const stash = await requireStash(root, index, expectedStashSha);
  const result = await runGitAllowFailure(root, ["stash", "drop", stash.ref]);
  if (result.code !== 0) throw commandFailure("git stash drop");
  const remaining = await gitListStashes(root);
  if (remaining.some((item) => item.sha.toLowerCase() === stash.sha.toLowerCase())) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Dropped stash could not be verified");
  }
  return { dropped: true, index, sha: stash.sha };
}

export async function gitConflictStatus(root: string): Promise<GitConflictStatus> {
  const [operation, conflicts, status] = await Promise.all([detectOperation(root), conflictFiles(root), gitStatus(root)]);
  return {
    operation,
    conflicts,
    branch: status.branch,
    dirtyFiles: status.dirtyFiles,
    staged: status.staged,
  };
}

export async function gitMergeOriginBranch(
  root: string,
  baseBranch: string,
  expectedTargetSha: string,
): Promise<{
  merged: boolean;
  alreadyUpToDate: boolean;
  conflicted: boolean;
  branch: string;
  baseBranch: string;
  targetSha: string;
  beforeSha: string;
  afterSha: string;
  conflicts: string[];
}> {
  await requireCleanWorktree(root);
  await validateBranchName(root, baseBranch);
  assertFullSha(expectedTargetSha, "expected target SHA");
  const branch = await currentBranch(root);
  if (branch === baseBranch) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Current branch must differ from the base branch");
  const remoteRef = `refs/remotes/origin/${baseBranch}`;
  let targetSha: string;
  try {
    targetSha = (await runGit(root, ["rev-parse", "--verify", `${remoteRef}^{commit}`])).stdout.trim();
  } catch {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Base branch remote-tracking ref does not exist");
  }
  if (targetSha.toLowerCase() !== expectedTargetSha.toLowerCase()) {
    throw new DomainError(ErrorCode.HASH_MISMATCH, "Base branch changed; fetch and inspect again");
  }
  const beforeSha = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
  const merge = await runGitAllowFailure(root, ["merge", "--no-edit", "--no-ff", targetSha]);
  const conflicts = await conflictFiles(root);
  const afterSha = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
  if (merge.code !== 0) {
    if (conflicts.length > 0 && (await detectOperation(root)) === "merge") {
      return {
        merged: false,
        alreadyUpToDate: false,
        conflicted: true,
        branch,
        baseBranch,
        targetSha,
        beforeSha,
        afterSha,
        conflicts,
      };
    }
    if ((await detectOperation(root)) === "merge") await runGitAllowFailure(root, ["merge", "--abort"]);
    throw commandFailure("git merge");
  }
  return {
    merged: afterSha !== beforeSha,
    alreadyUpToDate: afterSha === beforeSha,
    conflicted: false,
    branch,
    baseBranch,
    targetSha,
    beforeSha,
    afterSha,
    conflicts: [],
  };
}

export async function gitContinueOperation(root: string): Promise<{ continued: true; operation: Exclude<GitOperationKind, "none" | "rebase">; commitSha: string }> {
  const operation = await detectOperation(root);
  if (operation === "none") throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "No Git operation is in progress");
  if (operation === "rebase") throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Rebase continuation is intentionally unsupported");
  const conflicts = await conflictFiles(root);
  if (conflicts.length > 0) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Resolve and stage all conflicts before continuing", { conflicts });
  }
  const args = operation === "merge" ? ["commit", "--no-edit"] : operation === "cherry-pick" ? ["cherry-pick", "--continue"] : ["revert", "--continue"];
  const result = await runGitAllowFailure(root, args);
  if (result.code !== 0) throw commandFailure(`git ${operation} continue`);
  const commitSha = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
  return { continued: true, operation, commitSha };
}

export async function gitAbortOperation(root: string): Promise<{ aborted: true; operation: Exclude<GitOperationKind, "none"> }> {
  const operation = await detectOperation(root);
  if (operation === "none") throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "No Git operation is in progress");
  const args = operation === "merge"
    ? ["merge", "--abort"]
    : operation === "cherry-pick"
      ? ["cherry-pick", "--abort"]
      : operation === "revert"
        ? ["revert", "--abort"]
        : ["rebase", "--abort"];
  const result = await runGitAllowFailure(root, args);
  if (result.code !== 0) throw commandFailure(`git ${operation} abort`);
  return { aborted: true, operation };
}

export async function gitUnstagePaths(root: string, rawPaths: string[]): Promise<{ unstaged: string[] }> {
  const paths = validateRelativePaths(root, rawPaths);
  await requireTrackedPaths(root, paths);
  const result = await runGitAllowFailure(root, ["restore", "--staged", "--", ...paths]);
  if (result.code !== 0) throw commandFailure("git restore --staged");
  return { unstaged: paths };
}

async function rawPathDiff(root: string, paths: string[]): Promise<string> {
  return (await runGit(root, ["diff", "--no-ext-diff", "--binary", "--", ...paths])).stdout;
}

export async function gitPathDiff(root: string, rawPaths: string[]): Promise<{ paths: string[]; diff: string; diffSha256: string; bytes: number }> {
  const paths = validateRelativePaths(root, rawPaths);
  await requireTrackedPaths(root, paths);
  assertNoSecretPaths(root, paths);
  const raw = await rawPathDiff(root, paths);
  return {
    paths,
    diff: redact(raw),
    diffSha256: createHash("sha256").update(raw).digest("hex"),
    bytes: Buffer.byteLength(raw, "utf8"),
  };
}

export async function gitRestorePaths(
  root: string,
  rawPaths: string[],
  expectedDiffSha256: string,
): Promise<{ restored: string[] }> {
  if (!/^[0-9a-f]{64}$/i.test(expectedDiffSha256)) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid expected diff hash");
  }
  const paths = validateRelativePaths(root, rawPaths);
  await requireTrackedPaths(root, paths);
  assertNoSecretPaths(root, paths);
  const status = await gitStatus(root);
  const stagedSet = new Set(status.staged);
  const staged = paths.filter((item) => stagedSet.has(item));
  if (staged.length > 0) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Unstage paths before restoring worktree changes", { staged });
  }
  const raw = await rawPathDiff(root, paths);
  const actual = createHash("sha256").update(raw).digest("hex");
  if (actual.toLowerCase() !== expectedDiffSha256.toLowerCase()) {
    throw new DomainError(ErrorCode.HASH_MISMATCH, "Worktree diff changed; inspect again");
  }
  if (!raw) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "No worktree changes to restore");
  const result = await runGitAllowFailure(root, ["restore", "--worktree", "--", ...paths]);
  if (result.code !== 0) throw commandFailure("git restore");
  if (await rawPathDiff(root, paths)) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Git restore postcondition failed");
  return { restored: paths };
}

export async function gitHistory(root: string, ref = "HEAD", limit = 20): Promise<GitHistoryEntry[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid history limit");
  }
  const sha = await resolveCommitRef(root, ref);
  const result = await runGit(root, ["log", `-${limit}`, "--format=%H%x00%h%x00%an%x00%aI%x00%s", sha]);
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [full = "", short = "", author = "", authoredAt = "", subject = ""] = line.split("\0");
      return { sha: full, shortSha: short, author: redact(author), authoredAt, subject: redact(subject) };
    });
}

export async function gitShowCommit(root: string, ref: string): Promise<{ sha: string; files: string[]; output: string; truncated: boolean }> {
  const sha = await resolveCommitRef(root, ref);
  const files = (await runGit(root, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", sha]))
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  assertNoSecretPaths(root, files);
  const raw = (await runGit(root, ["show", "--no-ext-diff", "--no-color", "--format=fuller", "--patch", "--stat", sha, "--"])).stdout;
  const bytes = Buffer.byteLength(raw, "utf8");
  const truncated = bytes > MAX_SHOW_BYTES;
  const output = truncated ? Buffer.from(raw, "utf8").subarray(0, MAX_SHOW_BYTES).toString("utf8") : raw;
  return { sha, files, output: redact(output), truncated };
}

function parseNumstat(raw: string): GitCompareFile[] {
  const files: GitCompareFile[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [addedRaw = "0", removedRaw = "0", ...pathParts] = line.split("\t");
    const filePath = pathParts.join("\t");
    if (!filePath) continue;
    files.push({
      path: filePath,
      added: addedRaw === "-" ? 0 : Number.parseInt(addedRaw, 10) || 0,
      removed: removedRaw === "-" ? 0 : Number.parseInt(removedRaw, 10) || 0,
    });
  }
  return files;
}

export async function gitCompareRefs(
  root: string,
  baseRef: string,
  headRef: string,
): Promise<{ baseSha: string; headSha: string; baseOnly: number; headOnly: number; files: GitCompareFile[]; secretFileCount: number }> {
  const [baseSha, headSha] = await Promise.all([resolveCommitRef(root, baseRef), resolveCommitRef(root, headRef)]);
  const counts = (await runGit(root, ["rev-list", "--left-right", "--count", `${baseSha}...${headSha}`])).stdout.trim().split(/\s+/);
  const parsed = parseNumstat((await runGit(root, ["diff", "--numstat", `${baseSha}...${headSha}`, "--"])).stdout);
  const safe: GitCompareFile[] = [];
  let secretFileCount = 0;
  for (const file of parsed) {
    if (isSecretPath(path.resolve(root, file.path))) secretFileCount += 1;
    else safe.push(file);
  }
  return {
    baseSha,
    headSha,
    baseOnly: Number.parseInt(counts[0] ?? "0", 10) || 0,
    headOnly: Number.parseInt(counts[1] ?? "0", 10) || 0,
    files: safe,
    secretFileCount,
  };
}

async function runSequencerOperation(
  root: string,
  operation: "cherry-pick" | "revert",
  commitSha: string,
): Promise<{ completed: boolean; conflicted: boolean; operation: "cherry-pick" | "revert"; commitSha: string; beforeSha: string; afterSha: string; conflicts: string[] }> {
  assertFullSha(commitSha);
  await requireCleanWorktree(root);
  await resolveCommitRef(root, commitSha);
  const beforeSha = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
  const args = operation === "cherry-pick" ? ["cherry-pick", commitSha] : ["revert", "--no-edit", commitSha];
  const result = await runGitAllowFailure(root, args);
  const conflicts = await conflictFiles(root);
  const afterSha = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
  if (result.code !== 0) {
    if (conflicts.length > 0 && (await detectOperation(root)) === operation) {
      return { completed: false, conflicted: true, operation, commitSha, beforeSha, afterSha, conflicts };
    }
    if ((await detectOperation(root)) === operation) {
      await runGitAllowFailure(root, [operation, "--abort"]);
    }
    throw commandFailure(`git ${operation}`);
  }
  return { completed: true, conflicted: false, operation, commitSha, beforeSha, afterSha, conflicts: [] };
}

export async function gitCherryPick(root: string, commitSha: string) {
  return runSequencerOperation(root, "cherry-pick", commitSha);
}

export async function gitRevertCommit(root: string, commitSha: string) {
  return runSequencerOperation(root, "revert", commitSha);
}
