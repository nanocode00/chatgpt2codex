import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DomainError, ErrorCode, makeResult, type ProjectRegistryEntry, type ToolContext, type ToolResult } from "../types.js";
import { requireProjectLease } from "../workspace/lease-guard.js";
import { redact } from "../policy/secrets.js";
import { addToolCallProof } from "./tool-proof.js";
import {
  gitAbortMerge,
  gitCherryPick,
  gitCommentPullRequest,
  gitCompare,
  gitDeleteLocalBranch,
  gitListBranches,
  gitListPullRequests,
  gitListStashes,
  gitLog,
  gitMergeConflictStatus,
  gitMergeFromOriginBranch,
  gitRestoreWorktree,
  gitRevertCommit,
  gitSetPullRequestDraft,
  gitShowCommit,
  gitStashApply,
  gitStashDrop,
  gitStashPush,
  gitUnstage,
  gitUpdatePullRequest,
} from "../git/extended.js";

const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const LOCAL_WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;
const REMOTE_WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;
const SECURITY_SCHEMES = [{ type: "oauth2", scopes: ["chatgpt2codex"] }] as const;

interface CallToolResultLike {
  content: ToolResult["content"];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

async function resolveProject(ctx: ToolContext, projectId: string): Promise<ProjectRegistryEntry> {
  let entry = ctx.registry.find((project) => project.projectId === projectId);
  if (!entry && ctx.registry.length === 0) {
    const loaded = await ctx.store.loadProjects();
    ctx.registry.splice(0, ctx.registry.length, ...loaded);
    entry = ctx.registry.find((project) => project.projectId === projectId);
  }
  if (!entry) throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Project not found: ${projectId}`);
  return entry;
}

function mappedError(tool: string, err: unknown): CallToolResultLike {
  const code = err instanceof DomainError ? err.code : ErrorCode.NOT_IMPLEMENTED;
  const message = redact(err instanceof Error ? err.message : String(err));
  return {
    content: [{ type: "text", text: `Error [${code}]: ${message}` }],
    structuredContent: addToolCallProof({ error: message, code }, tool, false),
    isError: true,
  };
}

async function invoke<T extends Record<string, unknown>>(
  ctx: ToolContext,
  tool: string,
  input: unknown,
  fn: () => Promise<ToolResult<T>>,
): Promise<CallToolResultLike> {
  try {
    const result = await fn();
    await ctx.ledger.append({ type: "tool.call.completed", tool, input });
    return {
      content: result.content,
      structuredContent: addToolCallProof(result.structuredContent, tool, true),
      ...(result.isError ? { isError: true } : {}),
    };
  } catch (err) {
    const mapped = mappedError(tool, err);
    await ctx.ledger.append({ type: "tool.call.failed", tool, code: mapped.structuredContent.code, error: mapped.structuredContent.error });
    return mapped;
  }
}

function meta(invoking: string, invoked: string) {
  return {
    securitySchemes: SECURITY_SCHEMES,
    ui: { visibility: ["model"] },
    "openai/visibility": "public",
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
  };
}

export function registerExtendedGitTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "git_branch",
    {
      title: "List or safely delete Git branches",
      description: "List local/origin branches or delete a non-current local branch only when its exact SHA still matches and normal git branch -d considers it safely merged.",
      securitySchemes: SECURITY_SCHEMES,
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: meta("Checking Git branches...", "Git branch operation completed"),
      inputSchema: z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("list"), projectId: z.string() }).strict(),
        z.object({ mode: z.literal("delete"), projectId: z.string(), branchName: z.string(), expectedSha: z.string().regex(/^[0-9a-fA-F]{40}$/) }).strict(),
      ]),
    },
    async (input) => invoke(ctx, "git_branch", input, async () => {
      const capability = input.mode === "list" ? "read" : "write";
      await requireProjectLease(ctx, input.projectId, capability);
      const entry = await resolveProject(ctx, input.projectId);
      if (input.mode === "list") {
        const branches = await gitListBranches(entry.root);
        return makeResult({ branches }, `Found ${branches.length} branch ref(s).`);
      }
      const result = await gitDeleteLocalBranch(entry.root, input.branchName, input.expectedSha);
      return makeResult({ ...result }, `Deleted local branch ${result.branch}.`);
    }),
  );

  server.registerTool(
    "git_stash",
    {
      title: "Manage Git stash safely",
      description: "List, create, apply, or drop local stashes. Apply/drop require an exact stash SHA so a moved stash index cannot target the wrong entry.",
      securitySchemes: SECURITY_SCHEMES,
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: meta("Managing Git stash...", "Git stash operation completed"),
      inputSchema: z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("list"), projectId: z.string() }).strict(),
        z.object({ mode: z.literal("push"), projectId: z.string(), message: z.string().max(256).optional(), includeUntracked: z.boolean().optional() }).strict(),
        z.object({ mode: z.literal("apply"), projectId: z.string(), stashRef: z.string(), expectedStashSha: z.string().regex(/^[0-9a-fA-F]{40}$/) }).strict(),
        z.object({ mode: z.literal("drop"), projectId: z.string(), stashRef: z.string(), expectedStashSha: z.string().regex(/^[0-9a-fA-F]{40}$/) }).strict(),
      ]),
    },
    async (input) => invoke(ctx, "git_stash", input, async () => {
      await requireProjectLease(ctx, input.projectId, input.mode === "list" ? "read" : "write");
      const entry = await resolveProject(ctx, input.projectId);
      if (input.mode === "list") {
        const stashes = await gitListStashes(entry.root);
        return makeResult({ stashes }, `Found ${stashes.length} stash entr${stashes.length === 1 ? "y" : "ies"}.`);
      }
      if (input.mode === "push") {
        const result = await gitStashPush(entry.root, input.message, input.includeUntracked);
        return makeResult({ ...result }, result.created ? `Created ${result.stash?.ref ?? "stash"}.` : "No stash was created because there were no changes.");
      }
      if (input.mode === "apply") {
        const result = await gitStashApply(entry.root, input.stashRef, input.expectedStashSha);
        return makeResult({ ...result }, result.conflicted ? `Stash apply produced ${result.conflicts.length} conflict(s).` : "Applied stash without dropping it.");
      }
      const result = await gitStashDrop(entry.root, input.stashRef, input.expectedStashSha);
      return makeResult({ ...result }, `Dropped ${result.ref}.`);
    }),
  );

  server.registerTool(
    "git_worktree",
    {
      title: "Adjust staged or working-tree files",
      description: "Unstage selected paths or restore selected tracked working-tree files. Restore is destructive and requires the exact current HEAD SHA.",
      securitySchemes: SECURITY_SCHEMES,
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: meta("Updating Git worktree...", "Git worktree operation completed"),
      inputSchema: z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("unstage"), projectId: z.string(), paths: z.array(z.string()).min(1).max(100) }).strict(),
        z.object({ mode: z.literal("restore"), projectId: z.string(), paths: z.array(z.string()).min(1).max(100), expectedHeadSha: z.string().regex(/^[0-9a-fA-F]{40}$/) }).strict(),
      ]),
    },
    async (input) => invoke(ctx, "git_worktree", input, async () => {
      await requireProjectLease(ctx, input.projectId, "write");
      const entry = await resolveProject(ctx, input.projectId);
      if (input.mode === "unstage") {
        const result = await gitUnstage(entry.root, input.paths);
        return makeResult({ ...result }, `Unstaged ${result.unstaged.length} path(s).`);
      }
      const result = await gitRestoreWorktree(entry.root, input.paths, input.expectedHeadSha);
      return makeResult({ ...result }, `Restored ${result.restored.length} path(s) from HEAD.`);
    }),
  );

  server.registerTool(
    "git_history",
    {
      title: "Inspect Git history and compare refs",
      description: "Read bounded commit history, show one exact commit, or compare two conservative refs without mutating the repository.",
      securitySchemes: SECURITY_SCHEMES,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: meta("Reading Git history...", "Git history loaded"),
      inputSchema: z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("log"), projectId: z.string(), limit: z.number().int().min(1).max(50).optional(), ref: z.string().optional() }).strict(),
        z.object({ mode: z.literal("show"), projectId: z.string(), sha: z.string().regex(/^[0-9a-fA-F]{40}$/) }).strict(),
        z.object({ mode: z.literal("compare"), projectId: z.string(), base: z.string(), head: z.string() }).strict(),
      ]),
    },
    async (input) => invoke(ctx, "git_history", input, async () => {
      await requireProjectLease(ctx, input.projectId, "read");
      const entry = await resolveProject(ctx, input.projectId);
      if (input.mode === "log") {
        const commits = await gitLog(entry.root, input.limit, input.ref);
        return makeResult({ commits }, `Loaded ${commits.length} commit(s).`);
      }
      if (input.mode === "show") {
        const result = await gitShowCommit(entry.root, input.sha);
        return makeResult({ ...result }, result.text);
      }
      const result = await gitCompare(entry.root, input.base, input.head);
      return makeResult({ ...result }, result.summary || `${result.head} is ${result.ahead} ahead and ${result.behind} behind ${result.base}.`);
    }),
  );

  server.registerTool(
    "git_commit_ops",
    {
      title: "Safely revert or cherry-pick a commit",
      description: "Run revert or cherry-pick only from a clean tree and only when the exact current HEAD still matches. Conflicting operations are automatically aborted.",
      securitySchemes: SECURITY_SCHEMES,
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: meta("Applying Git commit operation...", "Git commit operation completed"),
      inputSchema: z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("revert"), projectId: z.string(), commitSha: z.string().regex(/^[0-9a-fA-F]{40}$/), expectedHeadSha: z.string().regex(/^[0-9a-fA-F]{40}$/) }).strict(),
        z.object({ mode: z.literal("cherry_pick"), projectId: z.string(), commitSha: z.string().regex(/^[0-9a-fA-F]{40}$/), expectedHeadSha: z.string().regex(/^[0-9a-fA-F]{40}$/) }).strict(),
      ]),
    },
    async (input) => invoke(ctx, "git_commit_ops", input, async () => {
      await requireProjectLease(ctx, input.projectId, "write");
      const entry = await resolveProject(ctx, input.projectId);
      if (input.mode === "revert") {
        const result = await gitRevertCommit(entry.root, input.commitSha, input.expectedHeadSha);
        return makeResult({ ...result }, `Reverted ${input.commitSha.slice(0, 12)}.`);
      }
      const result = await gitCherryPick(entry.root, input.commitSha, input.expectedHeadSha);
      return makeResult({ ...result }, `Cherry-picked ${input.commitSha.slice(0, 12)}.`);
    }),
  );

  server.registerTool(
    "git_conflict",
    {
      title: "Start, inspect, or abort a guarded merge-conflict workflow",
      description: "Merge an exact fetched origin/<base> SHA into the current clean branch with --no-commit, expose conflicts for normal file editing, inspect merge state, or abort. Final merge commit remains an explicit git_publish commit step.",
      securitySchemes: SECURITY_SCHEMES,
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: meta("Handling Git merge state...", "Git merge state updated"),
      inputSchema: z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("status"), projectId: z.string() }).strict(),
        z.object({ mode: z.literal("merge_from"), projectId: z.string(), baseBranch: z.string(), expectedTargetSha: z.string().regex(/^[0-9a-fA-F]{40}$/), expectedHeadSha: z.string().regex(/^[0-9a-fA-F]{40}$/) }).strict(),
        z.object({ mode: z.literal("abort"), projectId: z.string() }).strict(),
      ]),
    },
    async (input) => invoke(ctx, "git_conflict", input, async () => {
      await requireProjectLease(ctx, input.projectId, input.mode === "status" ? "read" : "write");
      const entry = await resolveProject(ctx, input.projectId);
      if (input.mode === "status") {
        const result = await gitMergeConflictStatus(entry.root);
        return makeResult({ ...result }, result.mergeInProgress ? `Merge in progress with ${result.conflicts.length} conflict(s).` : "No merge is in progress.");
      }
      if (input.mode === "abort") {
        const result = await gitAbortMerge(entry.root);
        return makeResult({ ...result }, "Aborted the in-progress merge.");
      }
      const result = await gitMergeFromOriginBranch(entry.root, input.baseBranch, input.expectedTargetSha, input.expectedHeadSha);
      return makeResult({ ...result }, result.conflicted ? `Merge started with ${result.conflicts.length} conflict(s) to resolve.` : "Merge staged successfully; review and commit explicitly.");
    }),
  );

  server.registerTool(
    "git_pr_manage",
    {
      title: "List, comment on, or update GitHub pull requests",
      description: "List PRs read-only, or comment/update/close/reopen/mark-ready/convert-to-draft with an exact PR head SHA concurrency guard.",
      securitySchemes: SECURITY_SCHEMES,
      annotations: REMOTE_WRITE_ANNOTATIONS,
      _meta: meta("Managing pull request...", "Pull request management completed"),
      inputSchema: z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("list"), projectId: z.string(), state: z.enum(["open", "closed", "merged", "all"]).optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
        z.object({ mode: z.literal("comment"), projectId: z.string(), prNumber: z.number().int().positive(), expectedHeadSha: z.string().regex(/^[0-9a-fA-F]{40}$/), body: z.string().min(1).max(64 * 1024) }).strict(),
        z.object({ mode: z.literal("update"), projectId: z.string(), prNumber: z.number().int().positive(), expectedHeadSha: z.string().regex(/^[0-9a-fA-F]{40}$/), title: z.string().min(1).max(256).optional(), body: z.string().max(64 * 1024).optional() }).strict(),
        z.object({ mode: z.literal("close"), projectId: z.string(), prNumber: z.number().int().positive(), expectedHeadSha: z.string().regex(/^[0-9a-fA-F]{40}$/) }).strict(),
        z.object({ mode: z.literal("reopen"), projectId: z.string(), prNumber: z.number().int().positive(), expectedHeadSha: z.string().regex(/^[0-9a-fA-F]{40}$/) }).strict(),
        z.object({ mode: z.literal("mark_ready"), projectId: z.string(), prNumber: z.number().int().positive(), expectedHeadSha: z.string().regex(/^[0-9a-fA-F]{40}$/) }).strict(),
        z.object({ mode: z.literal("convert_to_draft"), projectId: z.string(), prNumber: z.number().int().positive(), expectedHeadSha: z.string().regex(/^[0-9a-fA-F]{40}$/) }).strict(),
      ]),
    },
    async (input) => invoke(ctx, "git_pr_manage", input, async () => {
      await requireProjectLease(ctx, input.projectId, input.mode === "list" ? "read" : "remote");
      const entry = await resolveProject(ctx, input.projectId);
      if (input.mode === "list") {
        const pullRequests = await gitListPullRequests(entry.root, input.state, input.limit);
        return makeResult({ pullRequests }, `Found ${pullRequests.length} pull request(s).`);
      }
      if (input.mode === "comment") {
        const result = await gitCommentPullRequest(entry.root, input.prNumber, input.expectedHeadSha, input.body);
        return makeResult({ ...result }, `Commented on PR #${input.prNumber}.`);
      }
      if (input.mode === "update") {
        const result = await gitUpdatePullRequest(entry.root, input.prNumber, input.expectedHeadSha, { title: input.title, body: input.body });
        return makeResult({ ...result }, `Updated PR #${input.prNumber}.`);
      }
      if (input.mode === "close" || input.mode === "reopen") {
        const result = await gitUpdatePullRequest(entry.root, input.prNumber, input.expectedHeadSha, { state: input.mode === "close" ? "closed" : "open" });
        return makeResult({ ...result }, `${input.mode === "close" ? "Closed" : "Reopened"} PR #${input.prNumber}.`);
      }
      const draft = input.mode === "convert_to_draft";
      const result = await gitSetPullRequestDraft(entry.root, input.prNumber, input.expectedHeadSha, draft);
      return makeResult({ ...result }, draft ? `Converted PR #${input.prNumber} to draft.` : `Marked PR #${input.prNumber} ready for review.`);
    }),
  );
}
