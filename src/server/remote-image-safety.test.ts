import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "./mcp-server.js";
import type { Lease, ToolContext } from "../types.js";

const LOCAL_ONLY = [
  "open_chatgpt_images_app",
  "save_image_from_clipboard",
  "save_image_from_download",
  "save_image_from_path",
] as const;

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

let projectRoot: string;
let outsideDir: string;
let stateDir: string;

function makeCtx(remote: boolean): ToolContext {
  const registry = [
    {
      projectId: "proj",
      name: "proj",
      root: projectRoot,
      aliases: [],
    },
  ];

  const lease: Lease = {
    projectId: "proj",
    leaseId: "lease_image_test",
    projectRoot,
    preset: "image-only",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };

  const session = {
    activeProjectId: "proj",
    mode: "read" as const,
    lease,
  };

  return {
    workspaceRoot: path.dirname(projectRoot),
    stateDir,
    registry,
    remote,
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => registry,
      saveProjects: async () => undefined,
      getSession: async () => session,
      setSession: async () => undefined,
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
}

async function toolsList(remote: boolean): Promise<string[]> {
  const server = await createServer(makeCtx(remote));
  const handler = (
    server.server as unknown as {
      _requestHandlers?: Map<
        string,
        (request: { method: string; params: Record<string, never> }) =>
          Promise<{ tools: Array<{ name: string }> }>
      >;
    }
  )._requestHandlers?.get("tools/list");

  const listed = await handler?.({ method: "tools/list", params: {} });
  return listed?.tools.map((tool) => tool.name) ?? [];
}

function registeredTools(remote: boolean) {
  return createServer(makeCtx(remote)).then(
    (server) =>
      (
        server as unknown as {
          _registeredTools?: Record<
            string,
            {
              handler?: (input: Record<string, unknown>) => Promise<{
                isError?: boolean;
                structuredContent?: Record<string, unknown>;
              }>;
            }
          >;
        }
      )._registeredTools,
  );
}

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-remote-image-project-"));
  outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-remote-image-outside-"));
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-remote-image-state-"));
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
  await fs.rm(outsideDir, { recursive: true, force: true });
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("remote image intake safety", () => {
  it("hides local-machine image/browser helpers from remote tools/list", async () => {
    const names = await toolsList(true);

    for (const name of LOCAL_ONLY) {
      expect(names, name).not.toContain(name);
    }

    expect(names).toContain("save_chatgpt_image");
    expect(names).toContain("save_chatgpt_image_from_url");
    expect(names).toContain("save_image_from_url");
    expect(names).toContain("save_image");
  });

  it("keeps local-machine image helpers available to trusted local sessions", async () => {
    const names = await toolsList(false);

    for (const name of LOCAL_ONLY) {
      expect(names, name).toContain(name);
    }
  });

  it.each(LOCAL_ONLY)("rejects direct remote invocation of %s", async (name) => {
    const tools = await registeredTools(true);

    const input =
      name === "save_image_from_path"
        ? {
            projectId: "proj",
            sourcePath: path.join(outsideDir, "outside.png"),
            destPath: ".chatgpt2codex/images/out.png",
          }
        : name === "save_image_from_download"
          ? { projectId: "proj" }
          : name === "save_image_from_clipboard"
            ? { projectId: "proj" }
            : {};

    const result = await tools?.[name]?.handler?.(input);

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("PERMISSION_DENIED");
  });

  it.each(["clipboard", "download", "path"] as const)(
    "rejects save_chatgpt_image source=%s remotely",
    async (source) => {
      const tools = await registeredTools(true);
      const result = await tools?.save_chatgpt_image?.handler?.({
        projectId: "proj",
        source,
        sourcePath: path.join(outsideDir, "outside.png"),
      });

      expect(result?.isError).toBe(true);
      expect(result?.structuredContent?.code).toBe("PERMISSION_DENIED");
    },
  );

  it.each(["auto", "url"] as const)(
    "requires an explicit URL for remote save_chatgpt_image source=%s",
    async (source) => {
      const tools = await registeredTools(true);
      const result = await tools?.save_chatgpt_image?.handler?.({
        projectId: "proj",
        source,
      });

      expect(result?.isError).toBe(true);
      expect(result?.structuredContent?.code).toBe("PERMISSION_DENIED");
      expect(String(result?.structuredContent?.error ?? "")).toContain("explicit URL");
    },
  );

  it("preserves trusted local path intake", async () => {
    const sourcePath = path.join(outsideDir, "outside.png");
    await fs.writeFile(sourcePath, PNG_BYTES);

    const tools = await registeredTools(false);
    const result = await tools?.save_image_from_path?.handler?.({
      projectId: "proj",
      sourcePath,
      destPath: ".chatgpt2codex/images/imported.png",
    });

    expect(result?.isError).not.toBe(true);
    await expect(
      fs.readFile(path.join(projectRoot, ".chatgpt2codex", "images", "imported.png")),
    ).resolves.toEqual(PNG_BYTES);
  });
});
