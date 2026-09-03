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

export function assertArbitraryCommandLocalOnly(
  ctx: ToolContext,
  toolName: string,
): void {
  if (!ctx.remote) return;

  throw new DomainError(
    ErrorCode.ARBITRARY_SHELL_DENIED,
    `Tool ${toolName} is disabled for remote sessions. Use command_run or a discovered/allowlisted verification tool instead.`,
  );
}

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

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
