import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../types.js";
import { registerTools } from "./tools.js";
import { registerExtendedGitTools } from "./git-extended-tools.js";

/**
 * Construct and configure the MCP server (stdio transport) with all tools
 * registered against ctx. Returns the server instance ready to `connect()`.
 */
export async function createServer(ctx: ToolContext): Promise<McpServer> {
  const server = new McpServer({
    name: "chatgpt2codex",
    version: "0.1.1",
  });

  registerTools(server, ctx);
  registerExtendedGitTools(server, ctx);

  return server;
}
