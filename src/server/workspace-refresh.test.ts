import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "./mcp-server.js";
import type { ProjectRegistryEntry, ToolContext } from "../types.js";
import { writeManagedRepositories } from "../runtime/catalog.js";

describe("workspace_refresh_index managed repositories", () => {
  let root: string;
  let workspaceRoot: string;
  let managedRoot: string;
  let rememberedRoot: string;
  let stateDir: string;
  let configDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-refresh-"));
    workspaceRoot = path.join(root, "workspace");
    managedRoot = path.join(root, "managed");
    rememberedRoot = path.join(root, "remembered");
    stateDir = path.join(root, "state");
    configDir = path.join(root, "config");

    for (const dir of [workspaceRoot, managedRoot, rememberedRoot, stateDir, configDir]) {
      await mkdir(dir, { recursive: true });
    }
    for (const dir of [workspaceRoot, managedRoot, rememberedRoot]) {
      await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: path.basename(dir) }), "utf8");
    }

    await writeManagedRepositories(configDir, {
      version: 1,
      repositories: [
        { id: "managed", name: "managed", root: managedRoot },
      ],
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps registered and remembered repositories when refreshing the startup workspace", async () => {
    let saved: ProjectRegistryEntry[] = [];
    const registry: ProjectRegistryEntry[] = [
      {
        projectId: "remembered",
        name: "remembered",
        root: rememberedRoot,
        aliases: ["remembered"],
      },
    ];
    const ctx: ToolContext = {
      workspaceRoot,
      stateDir,
      registry,
      ledger: { append: async () => undefined },
      store: {
        loadProjects: async () => saved,
        saveProjects: async (projects) => {
          saved = projects;
        },
        getSession: async () => ({ activeProjectId: null, mode: "observe", lease: null }),
        setSession: async () => undefined,
      },
      config: {
        workspaceRoot,
        stateDir,
        runtimeConfigDir: configDir,
        maxReadBytes: 1024 * 1024,
        maxPatchBytes: 1024 * 1024,
        defaultCommandTimeoutSec: 30,
        defaultLeaseTtlMs: 30 * 60 * 1000,
      },
    };

    const server = await createServer(ctx);
    const tools = (server as unknown as {
      _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
    })._registeredTools;
    const result = await tools?.workspace_refresh_index?.handler?.({}) as {
      structuredContent?: { count?: number };
    };

    expect(result.structuredContent?.count).toBe(3);
    expect(ctx.registry.map((project) => project.projectId).sort()).toEqual([
      "managed",
      "remembered",
      "workspace",
    ]);
    expect(saved.map((project) => project.projectId).sort()).toEqual([
      "managed",
      "remembered",
      "workspace",
    ]);
  });
});
