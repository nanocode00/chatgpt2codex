import { DomainError, ErrorCode, type ToolContext } from "../types.js";

/**
 * Tools that execute caller-supplied arbitrary command strings.
 *
 * These remain available to trusted local stdio sessions, but are never
 * exposed to or executable by remote MCP / ChatGPT Action sessions.
 */
export const REMOTE_ARBITRARY_COMMAND_TOOL_NAMES: ReadonlySet<string> = new Set([
  "local_shell_run",
  "e2e_start_server",
  "e2e_run_command",
]);

export const REMOTE_LOCAL_IMAGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "open_chatgpt_images_app",
  "save_image_from_clipboard",
  "save_image_from_download",
  "save_image_from_path",
]);

export function assertArbitraryCommandLocalOnly(
  ctx: ToolContext,
  toolName: string,
): void {
  if (!ctx.remote) return;

  throw new DomainError(
    ErrorCode.ARBITRARY_SHELL_DENIED,
    `Tool ${toolName} is disabled for remote sessions. Arbitrary command strings remain unavailable remotely; discovered project execution requires explicit local opt-in.`,
  );
}

export function assertLocalImageToolLocalOnly(
  ctx: ToolContext,
  toolName: string,
): void {
  if (!ctx.remote) return;

  throw new DomainError(
    ErrorCode.PERMISSION_DENIED,
    `Tool ${toolName} is disabled for remote sessions. Remote image intake accepts explicit public image URLs or caller-supplied image bytes only.`,
    { toolName, remote: true },
  );
}

export function assertRemoteImageSourceAllowed(
  ctx: ToolContext,
  source: "auto" | "url" | "clipboard" | "download" | "path",
  hasExplicitUrl: boolean,
): void {
  if (!ctx.remote) return;

  if (source !== "auto" && source !== "url") {
    throw new DomainError(
      ErrorCode.PERMISSION_DENIED,
      `Image source=${source} is local-only. Remote sessions may use source=url or source=auto with an explicit URL.`,
      { source, remote: true },
    );
  }

  if (!hasExplicitUrl) {
    throw new DomainError(
      ErrorCode.PERMISSION_DENIED,
      "Remote image intake requires an explicit URL. Clipboard URL discovery and other local auto-detection are disabled.",
      { source, remote: true },
    );
  }
}

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

export const REMOTE_EXECUTION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "command_run",
  "e2e_test_and_show_screenshot",
]);

export const REMOTE_E2E_TOOL_NAMES: ReadonlySet<string> = new Set([
  "e2e_open_target",
  "e2e_test_and_show_screenshot",
  "e2e_screenshot",
  "e2e_open_url_screenshot",
]);

export function isRemoteExecEnabled(): boolean {
  return ENABLED_VALUES.has(
    (process.env.CHATGPT2CODEX_REMOTE_EXEC ?? "").trim().toLowerCase(),
  );
}

export function isRemoteE2eEnabled(): boolean {
  return ENABLED_VALUES.has(
    (process.env.CHATGPT2CODEX_REMOTE_E2E ?? "").trim().toLowerCase(),
  );
}

export function assertRemoteExecAllowed(
  ctx: ToolContext,
  toolName: string,
): void {
  if (!ctx.remote || isRemoteExecEnabled()) return;

  throw new DomainError(
    ErrorCode.PERMISSION_DENIED,
    `Remote project execution is disabled. Set CHATGPT2CODEX_REMOTE_EXEC=1 locally before using ${toolName}. Project commands execute repository-controlled code and are not an OS sandbox.`,
    { toolName, remote: true },
  );
}

export function assertRemoteE2eAllowed(
  ctx: ToolContext,
  toolName: string,
): void {
  if (!ctx.remote || isRemoteE2eEnabled()) return;

  throw new DomainError(
    ErrorCode.PERMISSION_DENIED,
    `Remote E2E/UI access is disabled. Set CHATGPT2CODEX_REMOTE_E2E=1 locally before using ${toolName}.`,
    { toolName, remote: true },
  );
}

export function isRemoteWriteEnabled(): boolean {
  return ENABLED_VALUES.has(
    (process.env.CHATGPT2CODEX_REMOTE_WRITE ?? "").trim().toLowerCase(),
  );
}

/**
 * Remote project writes are fail-closed. A local operator must explicitly
 * opt in through the server process environment before a network client can
 * obtain or reuse write/remote capabilities.
 */
export function assertRemoteWriteAllowed(
  ctx: ToolContext,
  capability: "write" | "remote" = "write",
): void {
  if (!ctx.remote || isRemoteWriteEnabled()) return;

  throw new DomainError(
    ErrorCode.PERMISSION_DENIED,
    `Remote ${capability} capability is disabled. Set CHATGPT2CODEX_REMOTE_WRITE=1 in the local server environment to opt in.`,
    { capability, remote: true },
  );
}
