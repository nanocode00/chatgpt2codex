import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "./mcp-server.js";
import type { Lease, ToolContext } from "../types.js";

let projectRoot: string;
let stateDir: string;
let records: Array<Record<string, unknown>>;

function createContext(remote = false, sessionId = "requester"): ToolContext {
  const registry = [{ projectId: "proj", name: "proj", root: projectRoot, aliases: [] }];
  const lease: Lease = {
    projectId: "proj", projectRoot, leaseId: "lease_for_explicit_transfer", preset: "full-write",
    issuedAt: Date.now(), expiresAt: Date.now() + 60000,
  };
  return {
    workspaceRoot: path.dirname(projectRoot), stateDir, registry, remote,
    ledger: { append: async (x) => { records.push(x as Record<string, unknown>); } },
    store: {
      loadProjects: async () => registry, saveProjects: async () => undefined,
      getSession: async () => ({ activeProjectId: "proj", mode: "edit", lease }),
      setSession: async () => undefined,
    },
    config: {
      workspaceRoot: path.dirname(projectRoot), stateDir, sessionId,
      maxReadBytes: 1024 * 1024, maxPatchBytes: 1024 * 1024,
      defaultCommandTimeoutSec: 30, defaultLeaseTtlMs: 60_000,
    },
  };
}

async function handler(ctx: ToolContext) {
  const server = await createServer(ctx);
  const tools = (server as unknown as {
    _registeredTools: Record<string, {
      handler(input: unknown): Promise<{ isError?: boolean; structuredContent: Record<string, unknown> }>;
    }>;
  })._registeredTools;
  return tools.file_transfer.handler;
}

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "c2c-mcp-transfer-project-"));
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "c2c-mcp-transfer-state-"));
  records = [];
});
afterEach(async () => {
  delete process.env.CHATGPT2CODEX_REMOTE_WRITE;
  await fs.rm(projectRoot, { recursive: true, force: true });
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("on-demand file transfer through MCP and HTTP-style re-registration", () => {
  it("continues PDF transfer across three separate MCP sessions and tool registrations", async () => {
    const ctx = createContext();
    const original = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");
    const sha256 = createHash("sha256").update(original).digest("hex");
    const a = await handler(ctx);
    const started = await a({ mode: "begin", projectId: "proj", filename: "source.pdf", sizeBytes: original.length, sha256 });
    expect(started.isError).not.toBe(true);
    const transferId = String(started.structuredContent.transferId);
    const b = await handler(createContext(false, "reconnected-session-for-chunk"));
    const dataBase64 = original.toString("base64");
    const chunk = await b({ mode: "chunk", projectId: "proj", transferId, index: 0, dataBase64 });
    expect(chunk.structuredContent.receivedBytes).toBe(original.length);
    const c = await handler(createContext(false, "reconnected-session-for-finish"));
    const finished = await c({ mode: "finish", projectId: "proj", transferId });
    expect(finished.isError).not.toBe(true);
    expect(finished.structuredContent.sha256).toBe(sha256);
    expect(await fs.readFile(path.join(projectRoot, String(finished.structuredContent.filePath)))).toEqual(original);
    expect(JSON.stringify(records)).not.toContain(dataBase64);
  });

  it("refuses remote file transfer without explicit operator remote-write opt-in", async () => {
    delete process.env.CHATGPT2CODEX_REMOTE_WRITE;
    const result = await (await handler(createContext(true)))({
      mode: "begin", projectId: "proj", filename: "blocked.pdf",
      sizeBytes: 5, sha256: "a".repeat(64),
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("PERMISSION_DENIED");
    const urlResult = await (await handler(createContext(true)))({
      mode: "from_url", projectId: "proj", filename: "blocked.pdf",
      sizeBytes: 5, sha256: "a".repeat(64), url: "https://public.example/blocked.pdf",
    });
    expect(urlResult.isError).toBe(true);
    expect(urlResult.structuredContent.code).toBe("PERMISSION_DENIED");
  });

  it("still requires write authorization on a reconnected session that knows a transfer ID", async () => {
    const original = Buffer.from("%PDF-1.4\n%%EOF\n");
    const sha256 = createHash("sha256").update(original).digest("hex");
    const started = await (await handler(createContext()))({
      mode: "begin", projectId: "proj", filename: "guarded.pdf", sizeBytes: original.length, sha256,
    });
    expect(started.isError).not.toBe(true);
    const transferId = String(started.structuredContent.transferId);
    delete process.env.CHATGPT2CODEX_REMOTE_WRITE;
    const denied = await (await handler(createContext(true, "reconnected-remote-session")))({
      mode: "chunk", projectId: "proj", transferId, index: 0, dataBase64: original.toString("base64"),
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent.code).toBe("PERMISSION_DENIED");
    const aborted = await (await handler(createContext()))({ mode: "abort", projectId: "proj", transferId });
    expect(aborted.isError).not.toBe(true);
  });
});
