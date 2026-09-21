import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "./store.js";
import { ErrorCode, type ProjectRegistryEntry } from "../types.js";

describe("Store", () => {
  let dir: string;
  let store: Store;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chatgpt2codex-store-"));
    store = new Store(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty project list before anything is saved", async () => {
    const projects = await store.loadProjects();
    expect(projects).toEqual([]);
  });

  it("round-trips projects through save/load", async () => {
    const projects: ProjectRegistryEntry[] = [
      {
        projectId: "alpha-app",
        name: "alpha-app",
        root: "/workspace/alpha-app",
        aliases: ["alpha-app", "alpha"],
        branch: "develop",
        dirty: true,
        hasAgentsMd: true,
        hasCodeBrain: true,
        packageHints: ["flutter", "node"],
        lastSeenAt: "2026-07-03T00:00:00+09:00",
      },
      {
        projectId: "beta-app",
        name: "beta-app",
        root: "/workspace/beta-app",
        aliases: ["beta-app"],
      },
    ];

    await store.saveProjects(projects);
    const loaded = await store.loadProjects();
    expect(loaded).toEqual(projects);
  });

  it("overwrites the previous snapshot on subsequent saves", async () => {
    await store.saveProjects([
      { projectId: "a", name: "a", root: "/a", aliases: ["a"] },
    ]);
    await store.saveProjects([
      { projectId: "b", name: "b", root: "/b", aliases: ["b"] },
    ]);
    const loaded = await store.loadProjects();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.projectId).toBe("b");
  });

  it("creates the state directory with 0700 permissions", async () => {
    if (process.platform === "win32") return;
    await store.saveProjects([]);
    const dirStat = await stat(dir);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("writes projects.json with 0600 permissions", async () => {
    if (process.platform === "win32") return;
    await store.saveProjects([]);
    const fileStat = await stat(join(dir, "projects.json"));
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("leaves no leftover temp files after a save", async () => {
    await store.saveProjects([{ projectId: "x", name: "x", root: "/x", aliases: [] }]);
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dir);
    expect(files.every((f) => !f.endsWith(".tmp"))).toBe(true);
  });

  it("rejects a corrupt projects.json instead of silently coercing it", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "projects.json"), JSON.stringify({ not: "valid" }), "utf8");
    await expect(store.loadProjects()).rejects.toThrow();
  });

  it("defaults session to observe mode with no active project", async () => {
    const session = await store.getSession();
    expect(session.mode).toBe("observe");
    expect(session.activeProjectId).toBeNull();
    expect(session.lease).toBeNull();
  });

  it("round-trips a session with an active lease", async () => {
    await store.setSession({
      activeProjectId: "alpha-app",
      mode: "edit",
      lease: {
        projectId: "alpha-app",
        leaseId: "lease-1",
        projectRoot: "/workspace/alpha-app",
        preset: "full-write",
        issuedAt: 1000,
        expiresAt: 2000,
      },
    });
    const session = await store.getSession();
    expect(session.activeProjectId).toBe("alpha-app");
    expect(session.mode).toBe("edit");
    expect(session.lease?.leaseId).toBe("lease-1");
  });

  it("stamps setSession's updatedAt with an integer epoch-ms value, ignoring caller input", async () => {
    await store.setSession({ updatedAt: 1 });
    const raw = JSON.parse(await readFile(join(dir, "sessions.json"), "utf8"));
    expect(Number.isInteger(raw.updatedAt)).toBe(true);
    expect(raw.updatedAt).toBeGreaterThan(1000);
  });

  it("isolates projects and sessions by namespace", async () => {
    const a = new Store(dir, "alpha");
    const b = new Store(dir, "beta");
    await a.saveProjects([{ projectId: "a", name: "a", root: "/a", aliases: ["a"] }]);
    await b.saveProjects([{ projectId: "b", name: "b", root: "/b", aliases: ["b"] }]);
    await a.setSession({ activeProjectId: "a", mode: "read", lease: null });
    await b.setSession({ activeProjectId: "b", mode: "read", lease: null });

    expect((await a.loadProjects())[0]?.projectId).toBe("a");
    expect((await b.loadProjects())[0]?.projectId).toBe("b");
    expect((await a.getSession()).activeProjectId).toBe("a");
    expect((await b.getSession()).activeProjectId).toBe("b");
    expect(await readFile(join(dir, "projects.alpha.json"), "utf8")).toContain('"projectId": "a"');
    expect(await readFile(join(dir, "projects.beta.json"), "utf8")).toContain('"projectId": "b"');
  });

  it("cleans up only a named namespace", async () => {
    const scoped = new Store(dir, "session-one");
    await scoped.saveProjects([{ projectId: "p", name: "p", root: "/p", aliases: ["p"] }]);
    await scoped.setSession({ activeProjectId: "p", mode: "read", lease: null });
    await store.saveProjects([{ projectId: "default", name: "default", root: "/default", aliases: ["default"] }]);

    await scoped.clearNamespace();

    expect(await scoped.loadProjects()).toEqual([]);
    expect((await scoped.getSession()).activeProjectId).toBeNull();
    expect((await store.loadProjects())[0]?.projectId).toBe("default");
    await expect(store.clearNamespace()).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
  });
});
