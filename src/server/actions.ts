import type { Express, Request, Response } from "express";
import { promises as fs } from "node:fs";
import { verifyOwnerToken } from "../auth/owner-token.js";
import type { ToolContext } from "../types.js";
import { createE2eScreenshotShare, readE2eScreenshotShare } from "../e2e/screenshot-share.js";
import { CONTROL_TOOL_NAMES, isControlChatGptExposed } from "../control/policy.js";
import {
  isRemoteE2eEnabled,
  isRemoteExecEnabled,
  REMOTE_ARBITRARY_COMMAND_TOOL_NAMES,
  REMOTE_E2E_TOOL_NAMES,
  REMOTE_EXECUTION_TOOL_NAMES,
} from "./remote-safety.js";
import { createServer as createMcpServer } from "./mcp-server.js";
import { TOOL_AVAILABILITY_GATE, toolCallProof } from "./tool-proof.js";
import { normalizeObjectSchema, safeParseAsync, getParseErrorMessage } from "@modelcontextprotocol/sdk/server/zod-compat.js";

interface CallToolResultLike {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface RegisteredToolLike {
  handler?: (input: Record<string, unknown>) => Promise<CallToolResultLike>;
  inputSchema?: unknown;
}

interface ActionRoute {
  path: string;
  tool: string;
  operationId: string;
  summary: string;
  description: string;
  schema: string;
}

const ACTION_ROUTES: ActionRoute[] = [
  {
    path: "/actions/agent-guide",
    tool: "agent_guide",
    operationId: "agent_guide",
    summary: "Get the chatgpt2codex workflow guide",
    description:
      "Call this first so the GPT knows the available chatgpt2codex tools and the ChatGPT image-save workflow. Do not proceed with local coding unless this or another chatgpt2codex action returns ok=true in the current turn.",
    schema: "EmptyInput",
  },
  {
    path: "/actions/goal-workflow",
    tool: "goal_workflow",
    operationId: "goal_workflow",
    summary: "Start or continue a local coding workflow",
    description:
      "Preferred Custom GPT orchestration surface. mode=intake preserves goal_intake semantics; mode=loop preserves goal_loop semantics. The underlying goal_intake and goal_loop tools/routes remain available for compatibility.",
    schema: "GoalWorkflowInput",
  },
  {
    path: "/actions/goal-intake",
    tool: "goal_intake",
    operationId: "goal_intake",
    summary: "Start a broad local coding goal",
    description:
      "Start a broad local coding goal and return the next concrete chatgpt2codex actions. Use for implementation, debugging, review, research, or planning. If unavailable, do not claim local work occurred.",
    schema: "GoalIntakeInput",
  },
  {
    path: "/actions/goal-loop",
    tool: "goal_loop",
    operationId: "goal_loop",
    summary: "Run or continue a local coding loop",
    description:
      "Continue a local coding loop. Returns the next inspect, edit, or verify action batch and keeps loop state locally until the task is done or blocked.",
    schema: "GoalLoopInput",
  },
  {
    path: "/actions/project-select",
    tool: "project_select",
    operationId: "project_select",
    summary: "Select the active local project",
    description:
      "Selects and leases the project. GPT Actions default to preset=read-only when omitted. preset=full-write is denied remotely unless the local operator explicitly enables CHATGPT2CODEX_REMOTE_WRITE=1. Use preset=image-only for image-only saves.",
    schema: "ProjectSelectInput",
  },
  {
    path: "/actions/workspace-list-projects",
    tool: "workspace_list_projects",
    operationId: "workspace_list_projects",
    summary: "List local workspace projects",
    description: "List projects registered under the local chatgpt2codex workspace.",
    schema: "WorkspaceListProjectsInput",
  },
  {
    path: "/actions/workspace-refresh-index",
    tool: "workspace_refresh_index",
    operationId: "workspace_refresh_index",
    summary: "Refresh the local project index",
    description: "Rescan the local workspace root and refresh chatgpt2codex's project registry.",
    schema: "WorkspaceRefreshIndexInput",
  },
  {
    path: "/actions/workspace-get-project",
    tool: "workspace_get_project",
    operationId: "workspace_get_project",
    summary: "Get local project metadata",
    description: "Resolve a project by project id or local path inside the configured workspace.",
    schema: "WorkspaceGetProjectInput",
  },
  {
    path: "/actions/project-status",
    tool: "project_status",
    operationId: "project_status",
    summary: "Get project status",
    description: "Read branch, dirty files, rule files, commands, and Code Brain availability for a project.",
    schema: "ProjectOnlyInput",
  },
  {
    path: "/actions/project-rules",
    tool: "project_rules",
    operationId: "project_rules",
    summary: "Read project rules",
    description: "Read local AGENTS/CLAUDE project rules through chatgpt2codex, with secret redaction.",
    schema: "ProjectOnlyInput",
  },
  {
    path: "/actions/project-skill-list",
    tool: "project_skill_list",
    operationId: "project_skill_list",
    summary: "List project-local skills",
    description: "Discover SKILL.md files only under the four allowed project skill roots without returning full bodies.",
    schema: "ProjectOnlyInput",
  },
  {
    path: "/actions/project-skill-read",
    tool: "project_skill_read",
    operationId: "project_skill_read",
    summary: "Read a project-local skill",
    description: "Read a discovered project-local SKILL.md by safe name or source:name identifier, including metadata and content hash.",
    schema: "ProjectSkillReadInput",
  },
  {
    path: "/actions/project-skill-write",
    tool: "project_skill_write",
    operationId: "project_skill_write",
    summary: "Create or update a project-local skill",
    description: "Create or update only an allowed <skill-name>/SKILL.md. Existing skills require a matching read hash; full-write lease and remote write opt-in rules apply.",
    schema: "ProjectSkillWriteInput",
  },
  {
    path: "/actions/code-search",
    tool: "code_search",
    operationId: "code_search",
    summary: "Search project code",
    description: "Search project source code through the local chatgpt2codex runtime.",
    schema: "CodeSearchInput",
  },
  {
    path: "/actions/code-context-pack",
    tool: "code_context_pack",
    operationId: "code_context_pack",
    summary: "Build project code context",
    description: "Build a compact search/read context pack for implementation work.",
    schema: "CodeContextPackInput",
  },
  {
    path: "/actions/file-read-slice",
    tool: "file_read_slice",
    operationId: "file_read_slice",
    summary: "Read project file slice",
    description: "Read a line range from a project file with hash anchors for safe patching.",
    schema: "FileReadSliceInput",
  },
  {
    path: "/actions/file-apply-patch",
    tool: "file_apply_patch",
    operationId: "file_apply_patch",
    summary: "Apply a project file patch",
    description: "Apply a Codex-style patch directly to the selected local project. Requires project_select preset=full-write; do not return shell scripts for the user to paste.",
    schema: "FileApplyPatchInput",
  },
  {
    path: "/actions/file-create",
    tool: "file_create",
    operationId: "file_create",
    summary: "Create a project file",
    description: "Create or overwrite a project-confined file directly through chatgpt2codex. Requires project_select preset=full-write.",
    schema: "FileCreateInput",
  },
  {
    path: "/actions/command-list",
    tool: "command_list",
    operationId: "command_list",
    summary: "List project commands",
    description: "List allowlisted project commands discovered by chatgpt2codex.",
    schema: "ProjectOnlyInput",
  },
  {
    path: "/actions/command-run",
    tool: "command_run",
    operationId: "command_run",
    summary: "Run allowlisted project command",
    description: "Run an allowlisted project command through chatgpt2codex.",
    schema: "CommandRunInput",
  },
  {
    path: "/actions/python-runtime-list",
    tool: "python_runtime_list",
    operationId: "python_runtime_list",
    summary: "List configured Python runtime profiles",
    description: "List operator-configured Python runtime aliases without executing Python or exposing executable paths. Read-only.",
    schema: "ProjectOnlyInput",
  },
  {
    path: "/actions/notebook-validate",
    tool: "notebook_validate",
    operationId: "notebook_validate",
    summary: "Validate Jupyter notebook",
    description: "Statically validate a project-confined .ipynb without executing it.",
    schema: "NotebookPathInput",
  },
  {
    path: "/actions/notebook-execute",
    tool: "notebook_execute",
    operationId: "notebook_execute",
    summary: "Execute Jupyter notebook",
    description: "Execute a project-confined .ipynb with trusted runtime discovery or an operator-configured runtimeProfile alias. Requires full-write and remote exec/write opt-ins.",
    schema: "NotebookExecuteInput",
  },
  {
    path: "/actions/python-execute",
    tool: "python_execute",
    operationId: "python_execute",
    summary: "Execute Python script",
    description: "Execute a project-confined .py file with trusted Python discovery or an operator-configured runtimeProfile alias. Requires full-write and remote exec/write opt-ins; callers cannot supply interpreter paths, argv, or env.",
    schema: "PythonPathInput",
  },
  {
    path: "/actions/local-shell-run",
    tool: "local_shell_run",
    operationId: "local_shell_run",
    summary: "Run local project shell",
    description: "Run a guarded local shell command inside the project through chatgpt2codex. Network/destructive intents remain approval-gated by the tool.",
    schema: "LocalShellRunInput",
  },
  {
    path: "/actions/e2e-start-server",
    tool: "e2e_start_server",
    operationId: "e2e_start_server",
    summary: "Start a local dev server for E2E",
    description:
      "Start a long-running project dev/server command in the background, optionally wait for a URL, and return pid/log path. Use before browser/app E2E screenshots.",
    schema: "E2eStartServerInput",
  },
  {
    path: "/actions/e2e-open-target",
    tool: "e2e_open_target",
    operationId: "e2e_open_target",
    summary: "Open a URL or local app for E2E",
    description: "Open a URL, installed app name, or allowed local app path on the Mac before E2E screenshot capture.",
    schema: "E2eOpenTargetInput",
  },
  {
    path: "/actions/e2e-run-command",
    tool: "e2e_run_command",
    operationId: "e2e_run_command",
    summary: "Run E2E command and capture proof",
    description:
      "Run a guarded project E2E/test command and capture a macOS screenshot by default so the user can inspect visual proof.",
    schema: "E2eRunCommandInput",
  },
  {
    path: "/actions/e2e-test-and-show-screenshot",
    tool: "e2e_test_and_show_screenshot",
    operationId: "e2e_test_and_show_screenshot",
    summary: "E2E test and show screenshot inline",
    description:
      "Call this one-shot action when the user says 'e2e 테스트하고 스크린샷 보여줘', 'run e2e and show me the screenshot', or similar. It uses the active project by default, detects web vs desktop-app projects such as Tauri, runs only discovered local package scripts, opens the built desktop app for Tauri projects, captures multiple top/middle/bottom desktop app-window screenshots for desktop apps or browser-region screenshots for web apps, and returns imageMarkdown/imageMarkdownList. If the local check fails, inspect logs, make normal code fixes with separate coding tools, rerun E2E, and only then render the final passing screenshot set inline.",
    schema: "E2eTestAndShowScreenshotInput",
  },
  {
    path: "/actions/e2e-screenshot",
    tool: "e2e_screenshot",
    operationId: "e2e_screenshot",
    summary: "Capture an E2E screenshot",
    description:
      "Capture a macOS screenshot into the selected project under .chatgpt2codex/e2e/screenshots and return the file path so the user can inspect it.",
    schema: "E2eScreenshotInput",
  },
  {
    path: "/actions/e2e-open-url-screenshot",
    tool: "e2e_open_url_screenshot",
    operationId: "e2e_open_url_screenshot",
    summary: "Open a URL and capture an E2E screenshot",
    description: "Open a URL, wait briefly, capture the browser page region, and return inline image markdown for visual E2E proof.",
    schema: "E2eOpenUrlScreenshotInput",
  },
  {
    path: "/actions/repo-inspect",
    tool: "repo_inspect",
    operationId: "repo_inspect",
    summary: "Inspect repository state and changes",
    description:
      "Preferred Custom GPT read-only repository inspection surface. view=status, summary, or changes preserves the corresponding existing repo tool semantics; view=all safely aggregates all three without adding write/exec capability.",
    schema: "RepoInspectInput",
  },
  {
    path: "/actions/repo-status",
    tool: "repo_status",
    operationId: "repo_status",
    summary: "Read repository status",
    description: "Read local git branch, dirty files, staged files, upstream, and sync state.",
    schema: "ProjectOnlyInput",
  },
  {
    path: "/actions/repo-diff-summary",
    tool: "repo_diff_summary",
    operationId: "repo_diff_summary",
    summary: "Summarize repository diff",
    description: "Summarize the local working diff with secret redaction.",
    schema: "ProjectOnlyInput",
  },
  {
    path: "/actions/show-changes",
    tool: "show_changes",
    operationId: "show_changes",
    summary: "Show project changes",
    description: "Return the current redacted working diff for review.",
    schema: "ProjectOnlyInput",
  },
  {
    path: "/actions/checkpoint-list",
    tool: "checkpoint_list",
    operationId: "checkpoint_list",
    summary: "List project checkpoints",
    description: "List recent mutation checkpoints captured by chatgpt2codex.",
    schema: "ProjectOnlyInput",
  },
  {
    path: "/actions/checkpoint-show",
    tool: "checkpoint_show",
    operationId: "checkpoint_show",
    summary: "Show project checkpoint",
    description: "Show the redacted diff stored in a chatgpt2codex checkpoint.",
    schema: "CheckpointShowInput",
  },
  {
    path: "/actions/checkpoint-restore",
    tool: "checkpoint_restore",
    operationId: "checkpoint_restore",
    summary: "Restore project checkpoint",
    description: "Reverse-apply a checkpoint diff through chatgpt2codex. Requires a write lease.",
    schema: "CheckpointShowInput",
  },
  {
    path: "/actions/git-workspace",
    tool: "git_workspace",
    operationId: "git_workspace",
    summary: "Safely fetch or switch Git workspace state",
    description: "Fetch fixed remote origin, create a local branch from origin/<base>, or switch to an existing local branch.",
    schema: "GitWorkspaceInput",
  },
  {
    path: "/actions/git-publish",
    tool: "git_publish",
    operationId: "git_publish",
    summary: "Safely commit, push, or create a GitHub PR",
    description: "Consolidated Git publishing surface. Pushes only the current branch to origin; PR head is the current branch.",
    schema: "GitPublishInput",
  },
  {
    path: "/actions/git-commit",
    tool: "git_commit",
    operationId: "git_commit",
    summary: "Commit project changes",
    description: "Stage and commit project changes through chatgpt2codex after inspecting status/diff.",
    schema: "GitCommitInput",
  },
  {
    path: "/actions/git-push",
    tool: "git_push",
    operationId: "git_push",
    summary: "Push project branch",
    description: "Push the current project branch through chatgpt2codex when the user explicitly requested pushing.",
    schema: "GitPushInput",
  },
  {
    path: "/actions/save-chatgpt-image",
    tool: "save_chatgpt_image",
    operationId: "save_chatgpt_image",
    summary: "Save a finished ChatGPT image from an explicit URL",
    description:
      "Remote-safe ChatGPT image import from an explicit Share/Copy Link or public content URL. Local clipboard, Downloads, arbitrary paths, and local browser helpers are intentionally unavailable through GPT Actions.",
    schema: "SaveChatGptImageInput",
  },
  {
    path: "/actions/import-chatgpt-image-url",
    tool: "save_chatgpt_image_from_url",
    operationId: "save_chatgpt_image_from_url",
    summary: "Import a ChatGPT image URL",
    description:
      "Device-agnostic import for ChatGPT image URLs, including chatgpt.com/s/m_... share pages and backend estuary content URLs. Use for phone-generated images or any device where chatgpt2codex cannot inspect local Chrome.",
    schema: "ImportChatGptImageUrlInput",
  },
  {
    path: "/actions/list-images",
    tool: "list_images",
    operationId: "list_images",
    summary: "List saved project images",
    description: "Lists images already saved under .chatgpt2codex/images for a project.",
    schema: "ListImagesInput",
  },
];

const OPENAPI_ACTION_TOOL_NAMES = new Set([
  "agent_guide",
  "goal_workflow",
  "project_select",
  "workspace_list_projects",
  "project_status",
  "project_rules",
  "project_skill_list",
  "project_skill_read",
  "project_skill_write",
  "code_search",
  "file_read_slice",
  "file_apply_patch",
  "file_create",
  "command_list",
  "command_run",
  "python_runtime_list",
  "notebook_validate",
  "notebook_execute",
  "python_execute",
  "e2e_open_target",
  "e2e_test_and_show_screenshot",
  "repo_inspect",
  "git_workspace",
  "git_publish",
  "save_chatgpt_image",
  "save_chatgpt_image_from_url",
  "list_images",
]);

function openApiActionRoutes(): ActionRoute[] {
  return ACTION_ROUTES.filter((route) => {
    if (!OPENAPI_ACTION_TOOL_NAMES.has(route.tool)) return false;
    if (REMOTE_EXECUTION_TOOL_NAMES.has(route.tool) && !isRemoteExecEnabled()) return false;
    if (REMOTE_E2E_TOOL_NAMES.has(route.tool) && !isRemoteE2eEnabled()) return false;
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actionInput(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) return {};
  return isRecord(body.input) ? body.input : body;
}

function actionInputForRoute(route: ActionRoute, body: unknown): Record<string, unknown> {
  const input = { ...actionInput(body) };
  if (route.tool === "project_select" && input.preset === undefined) {
    input.preset = "read-only";
  }
  return input;
}

function genericToolInput(body: unknown): { toolName: string; input: Record<string, unknown> } {
  const raw =
    isRecord(body) && isRecord(body.input) && typeof body.input.toolName === "string"
      ? body.input
      : isRecord(body)
        ? body
        : {};
  const toolName = typeof raw.toolName === "string" ? raw.toolName.trim() : "";
  const input = isRecord(raw.input) ? { ...raw.input } : {};
  if (toolName === "project_select" && input.preset === undefined) {
    input.preset = "read-only";
  }
  return { toolName, input };
}

function invalidActionInput(tool: string, message: string): CallToolResultLike {
  return {
    isError: true,
    structuredContent: { code: "INVALID_INPUT", error: message },
    content: [{ type: "text", text: `Invalid arguments for tool ${tool}: ${message}` }],
  };
}

async function callDedicatedAction(
  ctx: ToolContext,
  route: ActionRoute,
  input: Record<string, unknown>,
): Promise<CallToolResultLike> {
  if (route.tool === "python_runtime_list") {
    const extraKeys = Object.keys(input).filter((key) => key !== "projectId");
    if (extraKeys.length > 0) return invalidActionInput(route.tool, `unexpected properties: ${extraKeys.join(", ")}`);
    return callRegisteredTool(ctx, route.tool, input);
  }

  if (route.tool === "python_execute" || route.tool === "notebook_execute") {
    const allowedKeys = new Set(["projectId", "path", "runtimeProfile"]);
    const extraKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
    if (extraKeys.length > 0) return invalidActionInput(route.tool, `unexpected properties: ${extraKeys.join(", ")}`);
    return callRegisteredTool(ctx, route.tool, input);
  }

  if (route.tool === "repo_inspect") {
    const extraKeys = Object.keys(input).filter((key) => key !== "projectId" && key !== "view");
    if (extraKeys.length > 0) {
      return invalidActionInput(route.tool, `unexpected properties: ${extraKeys.join(", ")}`);
    }
    const projectId = typeof input.projectId === "string" ? input.projectId : "";
    const view = input.view;
    if (!projectId) return invalidActionInput(route.tool, "projectId is required");
    if (view !== "status" && view !== "summary" && view !== "changes" && view !== "all") {
      return invalidActionInput(route.tool, "view must be one of status, summary, changes, all");
    }
    if (view === "status") return callRegisteredTool(ctx, "repo_status", { projectId });
    if (view === "summary") return callRegisteredTool(ctx, "repo_diff_summary", { projectId });
    if (view === "changes") return callRegisteredTool(ctx, "show_changes", { projectId });

    const status = await callRegisteredTool(ctx, "repo_status", { projectId });
    if (status.isError) return status;
    const summary = await callRegisteredTool(ctx, "repo_diff_summary", { projectId });
    if (summary.isError) return summary;
    const changes = await callRegisteredTool(ctx, "show_changes", { projectId });
    if (changes.isError) return changes;
    return {
      structuredContent: {
        status: status.structuredContent ?? {},
        summary: summary.structuredContent ?? {},
        changes: changes.structuredContent ?? {},
      },
      content: [{ type: "text", text: [resultText(status), resultText(summary), resultText(changes)].filter(Boolean).join("\n") }],
    };
  }

  if (route.tool === "goal_workflow") {
    const mode = input.mode;
    if (mode !== "intake" && mode !== "loop") {
      return invalidActionInput(route.tool, "mode must be intake or loop");
    }
    const allowedKeys = mode === "intake"
      ? new Set(["mode", "goal", "projectId", "workMode", "urgency"])
      : new Set(["mode", "goal", "loopId", "projectId", "workMode", "maxTurns", "lastResult"]);
    const extraKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
    if (extraKeys.length > 0) {
      return invalidActionInput(route.tool, `unexpected properties for mode=${mode}: ${extraKeys.join(", ")}`);
    }
    const forwarded = { ...input };
    delete forwarded.mode;
    if (forwarded.workMode !== undefined) {
      forwarded.mode = forwarded.workMode;
      delete forwarded.workMode;
    }
    return callRegisteredTool(ctx, mode === "intake" ? "goal_intake" : "goal_loop", forwarded);
  }

  return callRegisteredTool(ctx, route.tool, input);
}

function bearerToken(req: Request): string | undefined {
  const raw = req.header("authorization") ?? "";
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

async function requireOwnerBearer(ctx: ToolContext, req: Request, res: Response): Promise<boolean> {
  const token = bearerToken(req);
  if (!token || !(await verifyOwnerToken(ctx.stateDir, token))) {
    res.status(401).json({
      ok: false,
      error: "Missing or invalid Bearer token. Use the chatgpt2codex owner token as the GPT Action API key.",
    });
    return false;
  }
  return true;
}

async function callRegisteredTool(
  ctx: ToolContext,
  toolName: string,
  input: Record<string, unknown>,
): Promise<CallToolResultLike> {
  if (REMOTE_ARBITRARY_COMMAND_TOOL_NAMES.has(toolName)) {
    const message = `Tool ${toolName} is disabled through the remote chatgpt2codex action bridge.`;
    await ctx.ledger.append({
      type: "remote.arbitrary_command.rejected",
      tool: toolName,
      remote: true,
    }).catch(() => undefined);
    return {
      isError: true,
      structuredContent: { code: "ARBITRARY_SHELL_DENIED", error: message },
      content: [{ type: "text", text: message }],
    };
  }

  // Desktop-control tools are blocked on the generic action bridge (even for
  // the owner-bearer /actions/call-tool route, even if isControlEnabled() is
  // on) unless the owner has separately opted in to exposing them to ChatGPT
  // via CHATGPT2CODEX_CONTROL_CHATGPT (isControlChatGptExposed) — the
  // public-product default keeps this block in place, matching the
  // tools/list hide in src/server/tools.ts installChatGptToolListHandler.
  if (CONTROL_TOOL_NAMES.has(toolName) && !isControlChatGptExposed()) {
    const message = `Tool ${toolName} is not available through the chatgpt2codex action bridge.`;
    return {
      isError: true,
      structuredContent: { code: "PERMISSION_DENIED", error: message },
      content: [{ type: "text", text: message }],
    };
  }
  // project_select isn't itself a control tool (so it isn't caught by
  // CONTROL_TOOL_NAMES above), but preset="control" is the only way to grant
  // a control lease and clear the kill switch (see src/server/tools.ts
  // project_select handler / src/control/queue.ts clearKill). A remote
  // owner-bearer caller must never be able to resume a locally killed
  // control session or grant itself a control lease through the bridge, so
  // this is rejected at the single choke point both /actions/call-tool
  // (genericToolInput) and the per-route bridge (actionInputForRoute) call
  // through. The local/MCP zod path (registerTool project_select) is
  // untouched, so a local approver can still grant/resume control normally.
  if (toolName === "project_select" && input.preset === "control") {
    const message = "preset=control cannot be granted through the chatgpt2codex action bridge.";
    await ctx.ledger.append({ type: "control.bridge.rejected", preset: "control" }).catch(() => undefined);
    return {
      isError: true,
      structuredContent: { code: "PERMISSION_DENIED", error: message },
      content: [{ type: "text", text: message }],
    };
  }
  const server = await createMcpServer({ ...ctx, remote: true });
  const tools = (server as unknown as { _registeredTools?: Record<string, RegisteredToolLike> })._registeredTools;
  const registered = tools?.[toolName];
  const handler = registered?.handler;
  if (!handler) {
    return {
      isError: true,
      structuredContent: { code: "TOOL_NOT_FOUND", error: `Tool not found: ${toolName}` },
      content: [{ type: "text", text: `Tool not found: ${toolName}` }],
    };
  }
  // This bridge calls the raw registered handler directly, bypassing the
  // MCP SDK's normal tools/call path (McpServer#validateToolInput), which is
  // where every tool's zod inputSchema (ranges, enums, refine, min/max) is
  // actually enforced. Without re-running that validation here, a bridge
  // caller can send out-of-schema values — e.g. a windowPoint xRel/yRel
  // outside [0,1], or an invalid enum — straight into the tool handler.
  // Re-validate against the same registered schema before dispatching.
  if (registered?.inputSchema) {
    const objSchema = normalizeObjectSchema(registered.inputSchema as never);
    const schemaToParse = objSchema ?? registered.inputSchema;
    const parsed = await safeParseAsync(schemaToParse as never, input);
    if (!parsed.success) {
      const message = `Invalid arguments for tool ${toolName}: ${getParseErrorMessage((parsed as { error: unknown }).error)}`;
      return {
        isError: true,
        structuredContent: { code: "INVALID_INPUT", error: message },
        content: [{ type: "text", text: message }],
      };
    }
    return handler(parsed.data as Record<string, unknown>);
  }
  return handler(input);
}

function resultText(result: CallToolResultLike): string {
  return (result.content ?? [])
    .map((item) => item.text)
    .filter((text): text is string => Boolean(text))
    .join("\n");
}

function isScreenshotRecord(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    value.path.includes(`${["", ".chatgpt2codex", "e2e", "screenshots", ""].join("/")}`) &&
    value.path.endsWith(".png")
  );
}

async function attachInlineScreenshotShares(
  ctx: ToolContext,
  publicOrigin: string,
  value: unknown,
): Promise<{ value: unknown; markdown: string[] }> {
  const markdown: string[] = [];
  async function visit(node: unknown): Promise<unknown> {
    if (Array.isArray(node)) {
      return Promise.all(node.map((item) => visit(item)));
    }
    if (!isRecord(node)) return node;

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      out[key] = await visit(child);
    }
    if (isScreenshotRecord(out)) {
      const share = await createE2eScreenshotShare(ctx.stateDir, String(out.path), publicOrigin);
      out.inlineUrl = share.url;
      out.inlineMarkdown = share.markdown;
      out.inlineExpiresAt = share.expiresAt;
      out.markdown = share.markdown;
      markdown.push(share.markdown);
    }
    return out;
  }
  return { value: await visit(value), markdown };
}

async function actionResponse(ctx: ToolContext, publicOrigin: string, tool: string, result: CallToolResultLike): Promise<Record<string, unknown>> {
  const enriched = await attachInlineScreenshotShares(ctx, publicOrigin, result.structuredContent ?? {});
  const text = resultText(result);
  const inlineText = enriched.markdown.length > 0 ? `${text}\n\n${enriched.markdown.join("\n")}` : text;
  const ok = result.isError !== true;
  return {
    ok,
    tool,
    toolCall: toolCallProof(tool, ok),
    text: inlineText,
    imageMarkdown: enriched.markdown[0],
    imageMarkdownList: enriched.markdown,
    structuredContent: enriched.value,
    ...(result.isError ? { isError: true } : {}),
  };
}

function openApiSpec(publicOrigin: string): Record<string, unknown> {
  const paths: Record<string, unknown> = {
    "/actions/call-tool": {
      post: {
        operationId: "call_tool",
        summary: "Call any chatgpt2codex MCP tool",
        description:
          "Owner-authenticated fallback for Custom GPTs when no dedicated route exists. Remote safety gates still apply: read-only by default, arbitrary commands blocked, and full-write requires local opt-in.",
        security: [{ ownerBearer: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { "$ref": "#/components/schemas/CallToolInput" } } },
        },
        responses: {
          "200": {
            description: "Tool call result",
            content: { "application/json": { schema: { "$ref": "#/components/schemas/ActionToolResponse" } } },
          },
          "401": {
            description: "Missing or invalid owner token",
            content: { "application/json": { schema: { "$ref": "#/components/schemas/ErrorResponse" } } },
          },
        },
      },
    },
  };

  for (const route of openApiActionRoutes()) {
    paths[route.path] = {
      post: {
        operationId: route.tool,
        summary: route.summary,
        description: `ChatGPT_To_Codex tool: ${route.tool}. ${route.description}`,
        security: [{ ownerBearer: [] }],
        requestBody: {
          required: route.schema !== "EmptyInput",
          content: { "application/json": { schema: { "$ref": `#/components/schemas/${route.schema}` } } },
        },
        responses: {
          "200": {
            description: "Tool call result",
            content: { "application/json": { schema: { "$ref": "#/components/schemas/ActionToolResponse" } } },
          },
          "401": {
            description: "Missing or invalid owner token",
            content: { "application/json": { schema: { "$ref": "#/components/schemas/ErrorResponse" } } },
          },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "chatgpt2codex Custom GPT Actions",
      version: "0.1.6",
      description:
        "OpenAPI bridge for Custom GPTs. Remote project selection defaults to read-only and full-write requires local CHATGPT2CODEX_REMOTE_WRITE=1 opt-in. This does not call OpenAI Codex or spend Codex quota; ChatGPT drives local coding actions through chatgpt2codex. Hard gate: do not claim local project inspection, edits, tests, commits, or image saves unless a current-turn ActionToolResponse includes ok=true and toolCall.namespace=ChatGPT_To_Codex. If the active ChatGPT app was Image Generation/ImageGen, image_gen, python_user_visible, or a text-only answer, no chatgpt2codex local work happened; reselect/reconnect ChatGPT To Codex or refresh this Action schema. For /goal or broad implementation prompts, call goal_workflow immediately before long reasoning. Use repo_inspect for repository status/diff inspection. The underlying goal_intake/goal_loop and repo_status/repo_diff_summary/show_changes tools/routes remain available for compatibility and generic call_tool use. This compact Custom GPT schema stays at or below 30 operations; the unauthenticated /actions/health endpoint remains available over HTTP but is intentionally omitted from the Action schema to preserve the operation budget. Dedicated tools include workspace_list_projects, project_select, code_search, file_read_slice, file_apply_patch, file_create, command_list, command_run, python_execute, and e2e_test_and_show_screenshot for source editing, allowlisted command execution and one-shot E2E/screenshot proof. It avoids broad context-pack actions that ChatGPT safety may block; inspect with code_search followed by narrow file_read_slice calls instead. Arbitrary-command tools remain blocked through both dedicated routes and call_tool. ChatGPT's sandbox cannot write /Users/... directly; use these actions. For generated images, pass an explicit Share/Copy Link/content URL to save_chatgpt_image/save_chatgpt_image_from_url; remote Actions never inspect the local clipboard, Downloads, or arbitrary paths.",
      "x-chatgpt2codex-tool-proof": TOOL_AVAILABILITY_GATE,
      "x-chatgpt2codex-openapi-operation-count": Object.keys(paths).length,
      "x-chatgpt2codex-tool-names": openApiActionRoutes().map((route) => route.tool),
    },
    servers: [{ url: publicOrigin }],
    paths,
    components: {
      securitySchemes: {
        ownerBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "chatgpt2codex-owner-token",
          description: "Use the chatgpt2codex owner token shown at init/setup time. Never commit it.",
        },
      },
      schemas: {
        EmptyInput: { type: "object", additionalProperties: false, properties: {} },
        CallToolInput: {
          type: "object",
          additionalProperties: false,
          required: ["toolName"],
          properties: {
            toolName: {
              type: "string",
              description:
                "Registered chatgpt2codex MCP tool name, e.g. file_apply_patch, file_create, command_run, repo_status, git_commit, git_push. Remote arbitrary-command tools are denied.",
            },
            input: {
              type: "object",
              additionalProperties: true,
              description: "Input object passed directly to the named chatgpt2codex MCP tool.",
            },
          },
        },
        GoalIntakeInput: {
          type: "object",
          additionalProperties: false,
          required: ["goal"],
          properties: {
            goal: {
              type: "string",
              description:
                "The user's broad /goal, deep research, implementation, debugging, review, or planning request. Pass the full request text.",
            },
            projectId: { type: "string", description: "Optional known project id/name." },
            mode: { type: "string", enum: ["implement", "research", "debug", "review", "plan"] },
            urgency: { type: "string", enum: ["normal", "fast"] },
          },
        },
        GoalLoopInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            goal: {
              type: "string",
              description:
                "The user's full coding goal. Required on the first loop call unless loopId is provided.",
            },
            loopId: {
              type: "string",
              description: "Existing local loop id returned by a previous goal_loop call.",
            },
            projectId: { type: "string", description: "Optional known project id/name." },
            mode: { type: "string", enum: ["implement", "research", "debug", "review", "plan"] },
            maxTurns: { type: "integer", minimum: 1, maximum: 50, description: "Maximum ChatGPT action turns for this loop." },
            lastResult: {
              type: "string",
              description: "Short summary of the previous inspect/edit/verify batch before continuing.",
            },
          },
        },
        GoalWorkflowInput: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["mode", "goal"],
              properties: {
                mode: { type: "string", enum: ["intake"] },
                goal: { type: "string" },
                projectId: { type: "string" },
                workMode: { type: "string", enum: ["implement", "research", "debug", "review", "plan"] },
                urgency: { type: "string", enum: ["normal", "fast"] },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["mode"],
              properties: {
                mode: { type: "string", enum: ["loop"] },
                goal: { type: "string" },
                loopId: { type: "string" },
                projectId: { type: "string" },
                workMode: { type: "string", enum: ["implement", "research", "debug", "review", "plan"] },
                maxTurns: { type: "integer", minimum: 1, maximum: 50 },
                lastResult: { type: "string" },
              },
            },
          ],
          discriminator: { propertyName: "mode" },
        },
        RepoInspectInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "view"],
          properties: {
            projectId: { type: "string" },
            view: { type: "string", enum: ["status", "summary", "changes", "all"] },
          },
        },
        WorkspaceListProjectsInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string" },
            includeDirty: { type: "boolean" },
            includeRecent: { type: "boolean" },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
        WorkspaceRefreshIndexInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            depth: { type: "integer", minimum: 1 },
            includeHidden: { type: "boolean" },
          },
        },
        WorkspaceGetProjectInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            projectId: { type: "string" },
            path: { type: "string" },
          },
        },
        ProjectOnlyInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId"],
          properties: { projectId: { type: "string" } },
        },
        ProjectSkillReadInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "skill"],
          properties: {
            projectId: { type: "string" },
            skill: {
              type: "string",
              description: "Discovered skill name or safe source:name identifier; never a project-relative path.",
            },
          },
        },
        ProjectSkillWriteInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "skill", "content"],
          properties: {
            projectId: { type: "string" },
            skill: {
              type: "string",
              pattern: "^[a-z0-9][a-z0-9._-]{0,63}$|^(codex|agents|claude|chatgpt2codex):[a-z0-9][a-z0-9._-]{0,63}$",
            },
            source: { type: "string", enum: ["codex", "agents", "claude", "chatgpt2codex"] },
            content: { type: "string", maxLength: 262144 },
            preconditionHash: {
              type: "string",
              description: "Hash returned by project_skill_read. Required when updating an existing skill.",
            },
          },
        },
        ProjectSelectInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "reason"],
          properties: {
            projectId: { type: "string", description: "Project id or name, for example chatgpt2codex." },
            reason: { type: "string" },
            preset: {
              type: "string",
              enum: ["read-only", "tests-only", "full-write", "image-only"],
              description: "Defaults to read-only on the GPT Actions bridge. full-write requires local CHATGPT2CODEX_REMOTE_WRITE=1 opt-in.",
            },
            confirmSwitch: { type: "boolean" },
          },
        },
        CodeSearchInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "query"],
          properties: {
            projectId: { type: "string" },
            query: { type: "string" },
            mode: { type: "string", enum: ["text", "symbol", "semantic"] },
            maxResults: { type: "integer", minimum: 1, maximum: 200 },
          },
        },
        FileReadSliceInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "path"],
          properties: {
            projectId: { type: "string" },
            path: { type: "string" },
            start: { type: "integer", minimum: 1 },
            end: { type: "integer", minimum: 1 },
            offset: { type: "integer", minimum: 0 },
          },
        },
        FileApplyPatchInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "patch"],
          properties: {
            projectId: { type: "string" },
            patch: { type: "string", description: "Codex-style *** Begin Patch envelope." },
            preconditionHashes: { type: "object", additionalProperties: { type: "string" } },
          },
        },
        FileCreateInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "path", "content"],
          properties: {
            projectId: { type: "string" },
            path: { type: "string" },
            content: { type: "string" },
            overwrite: { type: "boolean" },
          },
        },
        CommandRunInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "commandId"],
          properties: {
            projectId: { type: "string" },
            commandId: { type: "string" },
            intent: {
              type: "object",
              additionalProperties: false,
              properties: {
                needsNetwork: { type: "boolean" },
                expectedDurationSec: { type: "integer", minimum: 1 },
              },
            },
          },
        },
        NotebookPathInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "path"],
          properties: {
            projectId: { type: "string" },
            path: { type: "string", description: "Project-relative .ipynb path." },
          },
        },
        NotebookExecuteInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "path"],
          properties: {
            projectId: { type: "string" },
            path: { type: "string", description: "Project-relative .ipynb path." },
            runtimeProfile: { type: "string", description: "Operator-configured Python runtime alias, or auto. Never an executable path." },
          },
        },
        PythonPathInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "path"],
          properties: {
            projectId: { type: "string" },
            path: { type: "string", description: "Project-relative .py path." },
            runtimeProfile: { type: "string", description: "Operator-configured Python runtime alias, or auto. Never an executable path." },
          },
        },
        LocalShellRunInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "command"],
          properties: {
            projectId: { type: "string" },
            command: { type: "string" },
            cwd: { type: "string" },
            timeoutSec: { type: "integer", minimum: 1, maximum: 900 },
            intent: {
              type: "object",
              additionalProperties: false,
              properties: {
                reason: { type: "string" },
                writesWorkspace: { type: "boolean" },
                needsNetwork: { type: "boolean" },
                destructive: { type: "boolean" },
              },
            },
          },
        },
        E2eStartServerInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "command"],
          properties: {
            projectId: { type: "string" },
            command: { type: "string", description: "Dev/server command to run in the project, e.g. npm run dev -- --host 127.0.0.1." },
            cwd: { type: "string", description: "Optional project-relative working directory." },
            label: { type: "string" },
            waitUrl: { type: "string", description: "Optional URL to poll until ready." },
            waitTimeoutSec: { type: "integer", minimum: 1, maximum: 120 },
            intent: {
              type: "object",
              additionalProperties: false,
              properties: {
                writesWorkspace: { type: "boolean" },
                needsNetwork: { type: "boolean" },
                destructive: { type: "boolean" },
              },
            },
          },
        },
        E2eOpenTargetInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            projectId: { type: "string", description: "Required when appPath is project-relative or screenshot proof should be tied to a project." },
            url: { type: "string" },
            appName: { type: "string", description: "Installed macOS app name, e.g. Safari or ChatGPT." },
            appPath: { type: "string", description: "Absolute /Applications path or project-relative .app path." },
            args: { type: "array", items: { type: "string" } },
          },
        },
        E2eRunCommandInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "command"],
          properties: {
            projectId: { type: "string" },
            command: { type: "string", description: "E2E/test command to run in the project, e.g. npm run test:e2e." },
            cwd: { type: "string", description: "Optional project-relative working directory." },
            timeoutSec: { type: "integer", minimum: 1, maximum: 900 },
            label: { type: "string" },
            captureScreenshot: { type: "boolean", description: "Defaults to true. Set false only for non-visual E2E checks." },
            screenshotUrl: { type: "string", description: "Optional URL to open before the screenshot after the command exits." },
            screenshotWaitMs: { type: "integer", minimum: 0, maximum: 30000 },
            openAfterCapture: { type: "boolean" },
            intent: {
              type: "object",
              additionalProperties: false,
              properties: {
                writesWorkspace: { type: "boolean" },
                needsNetwork: { type: "boolean" },
                destructive: { type: "boolean" },
              },
            },
          },
        },
        E2eTestAndShowScreenshotInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            projectId: { type: "string", description: "Optional. If omitted, use the currently selected project." },
            instruction: {
              type: "string",
              description: "The user's natural-language request, e.g. e2e 테스트하고 스크린샷 보여줘.",
            },
            url: { type: "string", description: "Optional local localhost/127.0.0.1 page URL to open before screenshot capture." },
            cwd: { type: "string" },
            timeoutSec: { type: "integer", minimum: 1, maximum: 900 },
            screenshotWaitMs: { type: "integer", minimum: 0, maximum: 30000 },
            openAfterCapture: { type: "boolean" },
          },
        },
        E2eScreenshotInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId"],
          properties: {
            projectId: { type: "string" },
            label: { type: "string" },
            waitMs: { type: "integer", minimum: 0, maximum: 30000 },
            openAfterCapture: { type: "boolean", description: "Open the screenshot on the Mac immediately after capture." },
          },
        },
        E2eOpenUrlScreenshotInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "url"],
          properties: {
            projectId: { type: "string" },
            url: { type: "string" },
            label: { type: "string" },
            waitMs: { type: "integer", minimum: 0, maximum: 30000 },
            openAfterCapture: { type: "boolean" },
          },
        },
        CheckpointShowInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "checkpointId"],
          properties: {
            projectId: { type: "string" },
            checkpointId: { type: "string" },
          },
        },
        GitCommitInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "message"],
          properties: {
            projectId: { type: "string" },
            message: { type: "string" },
            paths: { type: "array", items: { type: "string" } },
          },
        },
        GitPushInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId"],
          properties: {
            projectId: { type: "string" },
            remote: { type: "string" },
            branch: { type: "string" },
          },
        },
        GitWorkspaceInput: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["mode", "projectId"],
              properties: { mode: { type: "string", enum: ["fetch"] }, projectId: { type: "string" } },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["mode", "projectId", "branchName", "baseBranch"],
              properties: {
                mode: { type: "string", enum: ["create_branch"] },
                projectId: { type: "string" },
                branchName: { type: "string", maxLength: 255 },
                baseBranch: { type: "string", maxLength: 255 },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["mode", "projectId", "branchName"],
              properties: {
                mode: { type: "string", enum: ["switch_branch"] },
                projectId: { type: "string" },
                branchName: { type: "string", maxLength: 255 },
              },
            },
          ],
          discriminator: { propertyName: "mode" },
        },
        GitPublishInput: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["mode", "projectId", "message"],
              properties: {
                mode: { type: "string", enum: ["commit"] },
                projectId: { type: "string" },
                message: { type: "string" },
                paths: { type: "array", items: { type: "string" } },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["mode", "projectId"],
              properties: { mode: { type: "string", enum: ["push"] }, projectId: { type: "string" } },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["mode", "projectId", "baseBranch", "title"],
              properties: {
                mode: { type: "string", enum: ["create_pr"] },
                projectId: { type: "string" },
                baseBranch: { type: "string", maxLength: 255 },
                title: { type: "string", minLength: 1, maxLength: 256 },
                body: { type: "string", maxLength: 65536 },
                draft: { type: "boolean" },
              },
            },
          ],
          discriminator: { propertyName: "mode" },
        },
        SaveChatGptImageInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            projectId: { type: "string" },
            destPath: { type: "string" },
            url: {
              type: "string",
              description: "Required explicit public ChatGPT Share/Copy Link or image content URL.",
            },
            source: {
              type: "string",
              enum: ["auto", "url"],
              description: "Remote Actions are URL-only. auto still requires the explicit url field.",
            },
            metadata: { type: "object", additionalProperties: true },
          },
        },
        ImportChatGptImageUrlInput: {
          type: "object",
          additionalProperties: false,
          required: ["url"],
          properties: {
            url: { type: "string" },
            projectId: { type: "string" },
            destPath: { type: "string" },
            metadata: { type: "object", additionalProperties: true },
          },
        },
        ListImagesInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId"],
          properties: { projectId: { type: "string" } },
        },
        ActionToolResponse: {
          type: "object",
          required: ["ok", "tool", "toolCall", "text", "structuredContent"],
          properties: {
            ok: { type: "boolean" },
            tool: { type: "string" },
            toolCall: { "$ref": "#/components/schemas/ToolCallProof" },
            text: { type: "string" },
            imageMarkdown: {
              type: "string",
              description:
                "When present, the assistant must paste this exact markdown image in the final answer so the screenshot renders inline. Do not only report the local path.",
            },
            imageMarkdownList: {
              type: "array",
              items: { type: "string" },
              description: "All inline screenshot markdown images returned by this action.",
            },
            structuredContent: { type: "object", additionalProperties: true },
            isError: { type: "boolean" },
          },
        },
        HealthResponse: {
          type: "object",
          required: ["ok", "name"],
          properties: {
            ok: { type: "boolean" },
            name: { type: "string" },
            actions: { type: "integer" },
            toolAvailabilityGate: { "$ref": "#/components/schemas/ToolAvailabilityGate" },
          },
        },
        ToolAvailabilityGate: {
          type: "object",
          additionalProperties: true,
          required: ["namespace", "app", "rule", "noResultMeans"],
          properties: {
            namespace: { type: "string" },
            app: { type: "string" },
            rule: { type: "string" },
            noResultMeans: { type: "string" },
            wrongSurfaceExamples: { type: "array", items: { type: "string" } },
          },
        },
        ToolCallProof: {
          type: "object",
          additionalProperties: true,
          required: ["namespace", "app", "tool", "ok", "currentTurnProof", "requiredBeforeCoding"],
          properties: {
            namespace: { type: "string" },
            app: { type: "string" },
            tool: { type: "string" },
            ok: { type: "boolean" },
            currentTurnProof: { type: "boolean" },
            requiredBeforeCoding: { type: "boolean" },
            proceedOnlyIfOk: { type: "boolean" },
            noToolResultMeansNoLocalWork: { type: "boolean" },
            instruction: { type: "string" },
          },
        },
        ErrorResponse: {
          type: "object",
          required: ["ok", "error"],
          properties: {
            ok: { type: "boolean" },
            error: { type: "string" },
          },
        },
      },
    },
  };
}

export function registerActionRoutes(app: Express, ctx: ToolContext, publicUrl: URL): void {
  const publicOrigin = publicUrl.origin;

  app.get("/actions/health", (_req, res) => {
    res.json({
      ok: true,
      name: "chatgpt2codex-actions",
      actions: ACTION_ROUTES.length,
      openApiOperations: openApiActionRoutes().length + 2,
      openApiToolNames: openApiActionRoutes().map((route) => route.tool),
      toolAvailabilityGate: TOOL_AVAILABILITY_GATE,
    });
  });

  app.get("/actions/openapi.json", (_req, res) => {
    res.json(openApiSpec(publicOrigin));
  });

  app.get("/actions/e2e-screenshot-inline/:token/:filename", async (req, res) => {
    const share = await readE2eScreenshotShare(ctx.stateDir, String(req.params.token ?? ""));
    if (!share) {
      res.status(404).type("text/plain").send("Screenshot link expired or not found.");
      return;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", String(share.bytes));
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Content-Disposition", `inline; filename="${String(req.params.filename ?? "e2e-screenshot.png").replace(/"/g, "")}"`);
    res.send(await fs.readFile(share.path));
  });

  app.post("/actions/call-tool", async (req, res) => {
    if (!(await requireOwnerBearer(ctx, req, res))) return;
    const { toolName, input } = genericToolInput(req.body);
    if (!toolName) {
      res.status(400).json({ ok: false, error: "Missing toolName" });
      return;
    }
    const result = await callRegisteredTool(ctx, toolName, input);
    res.json(await actionResponse(ctx, publicOrigin, toolName, result));
  });

  for (const route of ACTION_ROUTES) {
    app.post(route.path, async (req, res) => {
      if (!(await requireOwnerBearer(ctx, req, res))) return;
      const result = await callDedicatedAction(ctx, route, actionInputForRoute(route, req.body));
      res.json(await actionResponse(ctx, publicOrigin, route.tool, result));
    });
  }
}
