import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "./mcp-server.js";
import type { Lease, ToolContext } from "../types.js";

interface RegisteredToolLike {
  handler?: (input: Record<string, unknown>) => Promise<{
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  }>;
}

function makeCtx(stateDir: string, projectRoot: string, remote = false): {
  ctx: ToolContext;
  events: Array<Record<string, unknown>>;
  setLease: (preset: Lease["preset"]) => Promise<void>;
} {
  const registry = [{ projectId: "proj", name: "proj", root: projectRoot, aliases: [] }];
  let session: { activeProjectId: string | null; mode: string; lease: Lease | null } = {
    activeProjectId: null,
    mode: "observe",
    lease: null,
  };
  const events: Array<Record<string, unknown>> = [];
  const ctx: ToolContext = {
    workspaceRoot: path.dirname(projectRoot),
    stateDir,
    registry,
    remote,
    ledger: { append: async (event) => { events.push(event); } },
    store: {
      loadProjects: async () => registry,
      saveProjects: async () => undefined,
      getSession: async () => session,
      setSession: async (next) => { session = next as typeof session; },
    },
    config: {
      workspaceRoot: path.dirname(projectRoot),
      stateDir,
      maxReadBytes: 1024 * 1024,
      maxPatchBytes: 1024 * 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
  };
  return {
    ctx,
    events,
    setLease: async (preset) => {
      await ctx.store.setSession({
        activeProjectId: "proj",
        mode: preset === "full-write" ? "write" : "read",
        lease: {
          projectId: "proj",
          projectRoot,
          leaseId: `lease-${preset}`,
          preset,
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      });
    },
  };
}

async function tools(ctx: ToolContext): Promise<Record<string, RegisteredToolLike>> {
  const server = await createServer(ctx);
  return (server as unknown as { _registeredTools: Record<string, RegisteredToolLike> })._registeredTools;
}

describe("project skill MCP tools", () => {
  let stateDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-skill-state-"));
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-skill-project-"));
    delete process.env.CHATGPT2CODEX_REMOTE_WRITE;
  });

  afterEach(async () => {
    delete process.env.CHATGPT2CODEX_REMOTE_WRITE;
    await Promise.all([
      fs.rm(stateDir, { recursive: true, force: true }),
      fs.rm(projectRoot, { recursive: true, force: true }),
    ]);
  });

  it("denies project_skill_write under a read-only lease", async () => {
    const fixture = makeCtx(stateDir, projectRoot);
    await fixture.setLease("read-only");
    const registered = await tools(fixture.ctx);
    const result = await registered.project_skill_write?.handler?.({
      projectId: "proj",
      skill: "foo",
      source: "codex",
      content: "# foo",
    });
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("PERMISSION_DENIED");
  });

  it("creates and updates with a full-write lease and writes the normal mutation ledger", async () => {
    const fixture = makeCtx(stateDir, projectRoot);
    await fixture.setLease("full-write");
    const registered = await tools(fixture.ctx);

    const created = await registered.project_skill_write?.handler?.({
      projectId: "proj",
      skill: "foo",
      source: "chatgpt2codex",
      content: "---\ndescription: first\n---\nold",
    });
    expect(created?.isError).toBeFalsy();
    expect(created?.structuredContent).toMatchObject({
      created: true,
      path: ".chatgpt2codex/skills/foo/SKILL.md",
      source: "chatgpt2codex",
    });
    expect(fixture.events).toContainEqual(expect.objectContaining({
      type: "fs.mutation.staged",
      tool: "project_skill_write",
      projectId: "proj",
      action: "create",
      path: ".chatgpt2codex/skills/foo/SKILL.md",
    }));

    const read = await registered.project_skill_read?.handler?.({ projectId: "proj", skill: "foo" });
    expect(read?.isError).toBeFalsy();
    const hash = read?.structuredContent?.hash;
    expect(hash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));

    const updated = await registered.project_skill_write?.handler?.({
      projectId: "proj",
      skill: "foo",
      content: "updated",
      preconditionHash: hash,
    });
    expect(updated?.isError).toBeFalsy();
    expect(updated?.structuredContent).toMatchObject({ created: false, content: "updated" });
    expect(fixture.events).toContainEqual(expect.objectContaining({
      type: "fs.mutation.staged",
      tool: "project_skill_write",
      action: "update",
    }));
  });

  it("preserves the remote write opt-in policy", async () => {
    const fixture = makeCtx(stateDir, projectRoot, true);
    await fixture.setLease("full-write");
    const registered = await tools(fixture.ctx);

    const denied = await registered.project_skill_write?.handler?.({
      projectId: "proj",
      skill: "remote-denied",
      source: "codex",
      content: "denied",
    });
    expect(denied?.isError).toBe(true);
    expect(denied?.structuredContent?.code).toBe("PERMISSION_DENIED");
    await expect(fs.stat(path.join(projectRoot, ".codex/skills/remote-denied/SKILL.md"))).rejects.toThrow();

    process.env.CHATGPT2CODEX_REMOTE_WRITE = "1";
    const allowed = await registered.project_skill_write?.handler?.({
      projectId: "proj",
      skill: "remote-allowed",
      source: "codex",
      content: "allowed",
    });
    expect(allowed?.isError).toBeFalsy();
    expect(await fs.readFile(path.join(projectRoot, ".codex/skills/remote-allowed/SKILL.md"), "utf8")).toBe("allowed");
  });
});
