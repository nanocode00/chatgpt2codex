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

function createContext(remote = false): ToolContext {
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
      workspaceRoot: path.dirname(projectRoot), stateDir, sessionId: "requester",
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
  it("continues one PDF transfer across three separate tool registrations", async () => {
    const ctx = createContext();
    const original = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");
    const sha256 = createHash("sha256").update(original).digest("hex");
    const a = await handler(ctx);
    const started = await a({ mode: "begin", projectId: "proj", filename: "source.pdf", sizeBytes: original.length, sha256 });
    expect(started.isError).not.toBe(true);
    const transferId = String(started.structuredContent.transferId);
    const b = await handler(ctx);
    const dataBase64 = original.toString("base64");
    const chunk = await b({ mode: "chunk", projectId: "proj", transferId, index: 0, dataBase64 });
    expect(chunk.structuredContent.receivedBytes).toBe(original.length);
    const c = await handler(ctx);
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
  });
});
