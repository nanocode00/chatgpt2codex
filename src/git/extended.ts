import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DomainError, ErrorCode } from "../types.js";
import { redact } from "../policy/secrets.js";

const execFileAsync = promisify(execFile);
const EXEC_OPTS = { windowsHide: true, maxBuffer: 10 * 1024 * 1024 } as const;
const NETWORK_EXEC_OPTS = {
  windowsHide: true,
  maxBuffer: 2 * 1024 * 1024,
  timeout: 30_000,
  env: {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GH_PROMPT_DISABLED: "1",
  },
} as const;

export type ProcessRunner = (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

async function runGit(cwd: string, args: string[]) {
  return execFileAsync("git", args, { ...EXEC_OPTS, cwd });
}

async function runGitNetwork(cwd: string, args: string[]) {
  return execFileAsync("git", args, { ...NETWORK_EXEC_OPTS, cwd });
}

async function runGh(cwd: string, args: string[]) {
  return execFileAsync("gh", args, { ...NETWORK_EXEC_OPTS, cwd });
}

function sanitizedProcessError(operation: string, err: unknown): DomainError {
  const e = err as { code?: string | number; killed?: boolean; signal?: string } | undefined;
  if (e?.code === "ENOENT") return new DomainError(ErrorCode.NOT_IMPLEMENTED, `${operation} unavailable`);
  if (e?.killed || e?.signal === "SIGTERM") return new DomainError(ErrorCode.TIMEOUT, `${operation} timed out`);
  return new DomainError(ErrorCode.NOT_IMPLEMENTED, `${operation} failed`);
}

function assertFullSha(value: string, label = "commit SHA"): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Invalid ${label}`);
}

function assertBranch(value: string): void {
  if (!value || value.length > 255 || value.startsWith("-") || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid branch name");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(value) || value.includes("..") || value.endsWith("/") || value.endsWith(".")) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid branch name");
  }
}

function assertSafeRef(value: string): void {
  if (/^[0-9a-f]{40}$/i.test(value)) return;
  assertBranch(value);
}

function assertPath(value: string): void {
  if (!value || value.startsWith("-") || value.startsWith("/") || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid git path");
  }
  const parts = value.replace(/\\/g, "/").split("/");
  if (parts.includes("..")) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid git path");
}

function assertText(value: string, label: string, maxLength = 64 * 1024): void {
  if (!value.trim() || value.length > maxLength || value.includes("\0")) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Invalid ${label}`);
  }
}

async function currentBranch(root: string): Promise<string> {
  const branch = (await runGit(root, ["branch", "--show-current"])).stdout.trim();
  if (!branch) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Detached HEAD is not supported");
  return branch;
}

async function headSha(root: string): Promise<string> {
  return (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
}

async function assertExpectedHead(root: string, expectedHeadSha: string): Promise<void> {
  assertFullSha(expectedHeadSha, "expected HEAD SHA");
  if ((await headSha(root)).toLowerCase() !== expectedHeadSha.toLowerCase()) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "HEAD changed; inspect again");
  }
}

async function requireClean(root: string): Promise<void> {
  const status = (await runGit(root, ["status", "--porcelain=v1"])).stdout.trim();
  if (status) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Working tree must be clean");
}

async function refSha(root: string, ref: string): Promise<string> {
  assertSafeRef(ref);
  try {
    return (await runGit(root, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
  } catch {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Git ref does not exist");
  }
}

export interface GitBranchInfo {
  name: string;
  scope: "local" | "remote";
  current: boolean;
  sha: string;
  upstream: string | null;
}

export async function gitListBranches(root: string): Promise<GitBranchInfo[]> {
  const current = await currentBranch(root).catch(() => "");
  const local = await runGit(root, ["for-each-ref", "--format=%(refname:short)%09%(objectname)%09%(upstream:short)", "refs/heads"]);
  const remote = await runGit(root, ["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/remotes/origin"]);
  const rows: GitBranchInfo[] = [];
  for (const line of local.stdout.split("\n")) {
    if (!line) continue;
    const [name = "", sha = "", upstream = ""] = line.split("\t");
    if (!name || !/^[0-9a-f]{40}$/i.test(sha)) continue;
    rows.push({ name, scope: "local", current: name === current, sha, upstream: upstream || null });
  }
  for (const line of remote.stdout.split("\n")) {
    if (!line) continue;
    const [name = "", sha = ""] = line.split("\t");
    if (!name || name === "origin/HEAD" || !/^[0-9a-f]{40}$/i.test(sha)) continue;
    rows.push({ name, scope: "remote", current: false, sha, upstream: null });
  }
  return rows.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
}

export async function gitDeleteLocalBranch(root: string, branchName: string, expectedSha: string): Promise<{ deleted: true; branch: string; sha: string }> {
  assertBranch(branchName);
  assertFullSha(expectedSha, "expected branch SHA");
  if ((await currentBranch(root)) === branchName) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Cannot delete the current branch");
  const actual = await refSha(root, `refs/heads/${branchName}`);
  if (actual.toLowerCase() !== expectedSha.toLowerCase()) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Branch changed; list branches again");
  try {
    await runGit(root, ["branch", "-d", branchName]);
  } catch {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Branch is not safely deletable; merge it first");
  }
  return { deleted: true, branch: branchName, sha: actual };
}

export interface GitStashInfo { ref: string; sha: string; subject: string }

export async function gitListStashes(root: string): Promise<GitStashInfo[]> {
  const out = await runGit(root, ["stash", "list", "--format=%gd%x09%H%x09%gs"]);
  return out.stdout.split("\n").filter(Boolean).map((line) => {
    const [ref = "", sha = "", ...subject] = line.split("\t");
    return { ref, sha, subject: redact(subject.join("\t")) };
  }).filter((row) => /^stash@\{\d+\}$/.test(row.ref) && /^[0-9a-f]{40}$/i.test(row.sha));
}

export async function gitStashPush(root: string, message = "chatgpt2codex stash", includeUntracked = true): Promise<{ created: boolean; stash: GitStashInfo | null }> {
  assertText(message, "stash message", 256);
  const before = await gitListStashes(root);
  const args = ["stash", "push"];
  if (includeUntracked) args.push("--include-untracked");
  args.push("-m", message);
  await runGit(root, args);
  const after = await gitListStashes(root);
  const top = after[0] ?? null;
  return { created: Boolean(top && top.sha !== before[0]?.sha), stash: top };
}

function assertStashRef(ref: string): void {
  if (!/^stash@\{\d+\}$/.test(ref)) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid stash ref");
}

async function conflictedFiles(root: string): Promise<string[]> {
  const out = await runGit(root, ["diff", "--name-only", "--diff-filter=U"]);
  return out.stdout.split("\n").map((x) => x.trim()).filter(Boolean);
}

export async function gitStashApply(root: string, stashRef: string, expectedStashSha: string): Promise<{ applied: boolean; conflicted: boolean; conflicts: string[] }> {
  assertStashRef(stashRef);
  assertFullSha(expectedStashSha, "expected stash SHA");
  await requireClean(root);
  const actual = (await runGit(root, ["rev-parse", "--verify", stashRef])).stdout.trim();
  if (actual.toLowerCase() !== expectedStashSha.toLowerCase()) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Stash changed; list stashes again");
  try {
    await runGit(root, ["stash", "apply", stashRef]);
    return { applied: true, conflicted: false, conflicts: [] };
  } catch {
    const conflicts = await conflictedFiles(root);
    if (conflicts.length > 0) return { applied: false, conflicted: true, conflicts };
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "git stash apply failed");
  }
}

export async function gitStashDrop(root: string, stashRef: string, expectedStashSha: string): Promise<{ dropped: true; ref: string; sha: string }> {
  assertStashRef(stashRef);
  assertFullSha(expectedStashSha, "expected stash SHA");
  const actual = (await runGit(root, ["rev-parse", "--verify", stashRef])).stdout.trim();
  if (actual.toLowerCase() !== expectedStashSha.toLowerCase()) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Stash changed; list stashes again");
  await runGit(root, ["stash", "drop", stashRef]);
  return { dropped: true, ref: stashRef, sha: actual };
}

export async function gitUnstage(root: string, paths: string[]): Promise<{ unstaged: string[] }> {
  if (!paths.length) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "At least one path is required");
  paths.forEach(assertPath);
  await runGit(root, ["restore", "--staged", "--", ...paths]);
  return { unstaged: paths };
}

export async function gitRestoreWorktree(root: string, paths: string[], expectedHeadSha: string): Promise<{ restored: string[] }> {
  if (!paths.length) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "At least one path is required");
  paths.forEach(assertPath);
  await assertExpectedHead(root, expectedHeadSha);
  await runGit(root, ["restore", "--worktree", "--", ...paths]);
  return { restored: paths };
}

export interface GitLogEntry { sha: string; shortSha: string; author: string; authoredAt: string; subject: string }

export async function gitLog(root: string, limit = 20, ref = "HEAD"): Promise<GitLogEntry[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid log limit");
  assertSafeRef(ref);
  const out = await runGit(root, ["log", `-${limit}`, "--format=%H%x00%h%x00%an%x00%aI%x00%s", ref]);
  return out.stdout.split("\n").filter(Boolean).map((line) => {
    const [sha = "", shortSha = "", author = "", authoredAt = "", subject = ""] = line.split("\0");
    return { sha, shortSha, author: redact(author), authoredAt, subject: redact(subject) };
  }).filter((row) => /^[0-9a-f]{40}$/i.test(row.sha));
}

export async function gitShowCommit(root: string, sha: string): Promise<{ sha: string; text: string }> {
  assertFullSha(sha);
  const out = await runGit(root, ["show", "--no-ext-diff", "--stat", "--format=fuller", sha]);
  return { sha, text: redact(out.stdout) };
}

export async function gitCompare(root: string, base: string, head: string): Promise<{ base: string; head: string; ahead: number; behind: number; summary: string }> {
  assertSafeRef(base);
  assertSafeRef(head);
  const counts = await runGit(root, ["rev-list", "--left-right", "--count", `${base}...${head}`]);
  const [behindRaw = "0", aheadRaw = "0"] = counts.stdout.trim().split(/\s+/);
  const stat = await runGit(root, ["diff", "--stat", `${base}...${head}`]);
  return { base, head, ahead: Number.parseInt(aheadRaw, 10) || 0, behind: Number.parseInt(behindRaw, 10) || 0, summary: redact(stat.stdout) };
}

async function abortSequence(root: string, kind: "revert" | "cherry-pick"): Promise<void> {
  await runGit(root, [kind, "--abort"]).catch(() => ({ stdout: "", stderr: "" }));
}

export async function gitRevertCommit(root: string, commitSha: string, expectedHeadSha: string): Promise<{ reverted: true; sourceCommit: string; newHeadSha: string }> {
  assertFullSha(commitSha);
  await assertExpectedHead(root, expectedHeadSha);
  await requireClean(root);
  try {
    await runGit(root, ["revert", "--no-edit", commitSha]);
  } catch {
    await abortSequence(root, "revert");
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Revert conflicted and was aborted");
  }
  return { reverted: true, sourceCommit: commitSha, newHeadSha: await headSha(root) };
}

export async function gitCherryPick(root: string, commitSha: string, expectedHeadSha: string): Promise<{ cherryPicked: true; sourceCommit: string; newHeadSha: string }> {
  assertFullSha(commitSha);
  await assertExpectedHead(root, expectedHeadSha);
  await requireClean(root);
  try {
    await runGit(root, ["cherry-pick", commitSha]);
  } catch {
    await abortSequence(root, "cherry-pick");
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Cherry-pick conflicted and was aborted");
  }
  return { cherryPicked: true, sourceCommit: commitSha, newHeadSha: await headSha(root) };
}

async function mergeInProgress(root: string): Promise<boolean> {
  try {
    await runGit(root, ["rev-parse", "--verify", "MERGE_HEAD"]);
    return true;
  } catch {
    return false;
  }
}

export async function gitMergeConflictStatus(root: string): Promise<{ mergeInProgress: boolean; conflicts: string[]; headSha: string; branch: string }> {
  return { mergeInProgress: await mergeInProgress(root), conflicts: await conflictedFiles(root), headSha: await headSha(root), branch: await currentBranch(root) };
}

export async function gitMergeFromOriginBranch(root: string, baseBranch: string, expectedTargetSha: string, expectedHeadSha: string): Promise<{ mergeInProgress: boolean; conflicted: boolean; conflicts: string[]; targetSha: string }> {
  assertBranch(baseBranch);
  assertFullSha(expectedTargetSha, "expected target SHA");
  await assertExpectedHead(root, expectedHeadSha);
  await requireClean(root);
  const targetRef = `refs/remotes/origin/${baseBranch}`;
  const actual = await refSha(root, targetRef);
  if (actual.toLowerCase() !== expectedTargetSha.toLowerCase()) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Base branch changed; fetch and inspect again");
  try {
    await runGit(root, ["merge", "--no-commit", "--no-ff", actual]);
  } catch {
    const conflicts = await conflictedFiles(root);
    if (conflicts.length === 0) {
      await runGit(root, ["merge", "--abort"]).catch(() => ({ stdout: "", stderr: "" }));
      throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Git merge failed and was aborted");
    }
    return { mergeInProgress: true, conflicted: true, conflicts, targetSha: actual };
  }
  return { mergeInProgress: await mergeInProgress(root), conflicted: false, conflicts: [], targetSha: actual };
}

export async function gitAbortMerge(root: string): Promise<{ aborted: true }> {
  if (!(await mergeInProgress(root))) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "No merge is in progress");
  await runGit(root, ["merge", "--abort"]);
  return { aborted: true };
}

async function originRepository(root: string): Promise<string> {
  const url = (await runGit(root, ["remote", "get-url", "origin"])).stdout.trim();
  let pathName: string | null = null;
  try {
    if (/^https?:\/\//i.test(url) || /^ssh:\/\//i.test(url)) {
      const parsed = new URL(url);
      if (parsed.hostname.toLowerCase() !== "github.com") throw new Error("not github");
      pathName = parsed.pathname;
    } else {
      const m = url.match(/^[^@\s]+@github\.com:(.+)$/i);
      pathName = m?.[1] ?? null;
    }
  } catch {
    pathName = null;
  }
  if (!pathName) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "GitHub origin is required");
  const parts = pathName.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "GitHub origin is required");
  return `${parts[0]}/${parts[1]}`;
}

export interface GitPrListItem { number: number; title: string; url: string; state: string; draft: boolean; baseBranch: string; headBranch: string; headSha: string; updatedAt: string | null }

export async function gitListPullRequests(root: string, state: "open" | "closed" | "merged" | "all" = "open", limit = 20, ghRunner: ProcessRunner = runGh): Promise<GitPrListItem[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid PR list limit");
  const repository = await originRepository(root);
  try {
    const out = await ghRunner(root, ["pr", "list", "--repo", repository, "--state", state, "--limit", String(limit), "--json", "number,title,url,state,isDraft,baseRefName,headRefName,headRefOid,updatedAt"]);
    const rows = JSON.parse(out.stdout || "[]");
    if (!Array.isArray(rows)) throw new Error("unexpected response");
    return rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        number: Number(r.number), title: redact(String(r.title ?? "")), url: String(r.url ?? ""), state: String(r.state ?? "").toUpperCase(), draft: Boolean(r.isDraft),
        baseBranch: String(r.baseRefName ?? ""), headBranch: String(r.headRefName ?? ""), headSha: String(r.headRefOid ?? ""), updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : null,
      };
    }).filter((r) => Number.isInteger(r.number) && r.number > 0 && /^[0-9a-f]{40}$/i.test(r.headSha));
  } catch (err) {
    throw sanitizedProcessError("GitHub PR list", err);
  }
}

async function inspectPrHead(root: string, prNumber: number, ghRunner: ProcessRunner): Promise<{ repository: string; headSha: string; state: string }> {
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid PR number");
  const repository = await originRepository(root);
  try {
    const out = await ghRunner(root, ["pr", "view", String(prNumber), "--repo", repository, "--json", "headRefOid,state"]);
    const row = JSON.parse(out.stdout) as Record<string, unknown>;
    const head = String(row.headRefOid ?? "");
    if (!/^[0-9a-f]{40}$/i.test(head)) throw new Error("unexpected response");
    return { repository, headSha: head, state: String(row.state ?? "").toUpperCase() };
  } catch (err) {
    throw sanitizedProcessError("GitHub PR inspect", err);
  }
}

async function assertPrHead(root: string, prNumber: number, expectedHeadSha: string, ghRunner: ProcessRunner): Promise<{ repository: string; state: string }> {
  assertFullSha(expectedHeadSha, "expected PR head SHA");
  const current = await inspectPrHead(root, prNumber, ghRunner);
  if (current.headSha.toLowerCase() !== expectedHeadSha.toLowerCase()) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "PR head changed; inspect again");
  return { repository: current.repository, state: current.state };
}

export async function gitCommentPullRequest(root: string, prNumber: number, expectedHeadSha: string, body: string, ghRunner: ProcessRunner = runGh): Promise<{ commented: true; commentId: number; url: string }> {
  assertText(body, "PR comment");
  const { repository, state } = await assertPrHead(root, prNumber, expectedHeadSha, ghRunner);
  if (state !== "OPEN") throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "PR is not open");
  try {
    const out = await ghRunner(root, ["api", "--method", "POST", `repos/${repository}/issues/${prNumber}/comments`, "-f", `body=${body}`]);
    const row = JSON.parse(out.stdout) as Record<string, unknown>;
    const id = Number(row.id);
    const url = String(row.html_url ?? "");
    if (!Number.isInteger(id) || id <= 0 || !url) throw new Error("unexpected response");
    return { commented: true, commentId: id, url };
  } catch (err) {
    throw sanitizedProcessError("GitHub PR comment", err);
  }
}

export async function gitUpdatePullRequest(root: string, prNumber: number, expectedHeadSha: string, changes: { title?: string; body?: string; state?: "open" | "closed" }, ghRunner: ProcessRunner = runGh): Promise<{ updated: true; number: number; state: string; title: string; url: string }> {
  if (changes.title !== undefined) assertText(changes.title, "PR title", 256);
  if (changes.body !== undefined && (changes.body.length > 64 * 1024 || changes.body.includes("\0"))) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid PR body");
  if (changes.title === undefined && changes.body === undefined && changes.state === undefined) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "No PR changes requested");
  const { repository } = await assertPrHead(root, prNumber, expectedHeadSha, ghRunner);
  const args = ["api", "--method", "PATCH", `repos/${repository}/pulls/${prNumber}`];
  if (changes.title !== undefined) args.push("-f", `title=${changes.title}`);
  if (changes.body !== undefined) args.push("-f", `body=${changes.body}`);
  if (changes.state !== undefined) args.push("-f", `state=${changes.state}`);
  try {
    const out = await ghRunner(root, args);
    const row = JSON.parse(out.stdout) as Record<string, unknown>;
    const number = Number(row.number);
    const state = String(row.state ?? "").toUpperCase();
    const title = redact(String(row.title ?? ""));
    const url = String(row.html_url ?? "");
    if (number !== prNumber || !url || !state) throw new Error("unexpected response");
    return { updated: true, number, state, title, url };
  } catch (err) {
    throw sanitizedProcessError("GitHub PR update", err);
  }
}

export async function gitSetPullRequestDraft(root: string, prNumber: number, expectedHeadSha: string, draft: boolean, ghRunner: ProcessRunner = runGh): Promise<{ updated: true; draft: boolean; number: number }> {
  const { repository, state } = await assertPrHead(root, prNumber, expectedHeadSha, ghRunner);
  if (state !== "OPEN") throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "PR is not open");
  try {
    const args = ["pr", "ready", String(prNumber), "--repo", repository];
    if (draft) args.push("--undo");
    await ghRunner(root, args);
    return { updated: true, draft, number: prNumber };
  } catch (err) {
    throw sanitizedProcessError(draft ? "GitHub PR convert to draft" : "GitHub PR mark ready", err);
  }
}
