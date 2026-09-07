import { afterEach, describe, expect, it } from "vitest";
import { ErrorCode, type Lease, type ProjectRegistryEntry, type ToolContext } from "../types.js";
import { makeLease } from "./project-select.js";
import { requireProjectLease, type LeaseCapability } from "./lease-guard.js";

const alpha: ProjectRegistryEntry = { projectId: "alpha", name: "alpha", root: "/workspace/alpha", aliases: [] };
const beta: ProjectRegistryEntry = { projectId: "beta", name: "beta", root: "/workspace/beta", aliases: [] };

function makeContext(options: {
  remote?: boolean;
  session?: Record<string, unknown>;
  registry?: ProjectRegistryEntry[];
} = {}): { ctx: ToolContext; getSession: () => Record<string, unknown>; events: Array<Record<string, unknown>>; saves: () => number } {
  let session = options.session ?? {};
  let saveCount = 0;
  const events: Array<Record<string, unknown>> = [];
  const registry = options.registry ?? [alpha, beta];
  const ctx: ToolContext = {
    workspaceRoot: "/workspace",
    stateDir: "/state",
    registry,
    remote: options.remote ?? false,
    ledger: { append: async (event) => { events.push(event); } },
    store: {
      loadProjects: async () => registry,
      saveProjects: async () => undefined,
      getSession: async () => session,
      setSession: async (next) => { session = next as Record<string, unknown>; saveCount += 1; },
    },
    config: {
      workspaceRoot: "/workspace",
      stateDir: "/state",
      maxReadBytes: 1024,
      maxPatchBytes: 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
  };
  return { ctx, getSession: () => session, events, saves: () => saveCount };
}

function explicitLease(preset: Lease["preset"], source: Lease["selectionSource"] = "explicit"): Lease {
  return { ...makeLease(alpha, preset, source ?? "explicit"), selectionSource: source };
}

function autoLease(preset: Lease["preset"]): Lease {
  return makeLease(alpha, preset, "auto");
}

afterEach(() => {
  delete process.env.CHATGPT2CODEX_REMOTE_WRITE;
});

describe("capability-based automatic project leases", () => {
  it.each([
    ["read", "read-only"],
    ["verify", "tests-only"],
    ["image", "image-only"],
    ["write", "full-write"],
    ["remote", "full-write"],
  ] as const)("auto-selects the minimum preset for no lease + %s", async (capability, preset) => {
    const { ctx, getSession, events } = makeContext();
    const lease = await requireProjectLease(ctx, "alpha", capability);
    expect(lease).toMatchObject({ projectId: "alpha", projectRoot: alpha.root, preset, selectionSource: "auto" });
    expect((getSession().lease as Lease)).toEqual(lease);
    expect(getSession().activeProjectId).toBe("alpha");
    expect(events).toContainEqual(expect.objectContaining({
      type: "project.lease.auto_selected",
      projectId: "alpha",
      requiredCapability: capability,
      preset,
      upgrade: false,
    }));
  });

  it.each(["write", "remote"] as const)("does not persist auto full-write when remote %s is disabled", async (capability) => {
    const { ctx, getSession, saves } = makeContext({ remote: true });
    await expect(requireProjectLease(ctx, "alpha", capability)).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
    expect(saves()).toBe(0);
    expect(getSession().lease).toBeUndefined();
  });

  it.each(["write", "remote"] as const)("auto-selects full-write remotely only after operator opt-in for %s", async (capability) => {
    process.env.CHATGPT2CODEX_REMOTE_WRITE = "1";
    const { ctx, getSession } = makeContext({ remote: true });
    const lease = await requireProjectLease(ctx, "alpha", capability);
    expect(lease).toMatchObject({ preset: "full-write", selectionSource: "auto" });
    expect((getSession().lease as Lease).leaseId).toBe(lease.leaseId);
  });

  it.each([
    ["read-only", "write"],
    ["tests-only", "write"],
    ["image-only", "write"],
  ] as const)("upgrades an auto %s lease for %s capability", async (preset, capability) => {
    const lease = autoLease(preset);
    const { ctx, getSession, events } = makeContext({ session: { activeProjectId: "alpha", mode: "verify", lease, marker: "keep" } });
    const result = await requireProjectLease(ctx, "alpha", capability);
    expect(result).toMatchObject({ preset: "full-write", selectionSource: "auto" });
    expect(result.leaseId).not.toBe(lease.leaseId);
    expect(getSession()).toMatchObject({ activeProjectId: "alpha", mode: "verify", marker: "keep", lease: result });
    expect(events).toContainEqual(expect.objectContaining({ type: "project.lease.auto_selected", upgrade: true, preset: "full-write" }));
  });

  it("upgrades an auto read-only lease to tests-only for verify", async () => {
    const lease = autoLease("read-only");
    const { ctx } = makeContext({ session: { activeProjectId: "alpha", lease } });
    const result = await requireProjectLease(ctx, "alpha", "verify");
    expect(result).toMatchObject({ preset: "tests-only", selectionSource: "auto" });
  });

  it("switches auto cross-capability leases to the minimum preset for the current request", async () => {
    for (const [preset, capability, expected] of [
      ["tests-only", "image", "image-only"],
      ["image-only", "verify", "tests-only"],
    ] as const) {
      const { ctx } = makeContext({ session: { activeProjectId: "alpha", lease: autoLease(preset) } });
      const result = await requireProjectLease(ctx, "alpha", capability);
      expect(result).toMatchObject({ preset: expected, selectionSource: "auto" });
    }
  });

  it.each([
    ["tests-only", "image", "image-only"],
    ["image-only", "verify", "tests-only"],
  ] as const)("allows remote %s -> %s without REMOTE_WRITE by selecting %s", async (preset, capability, expected) => {
    const current = autoLease(preset);
    const { ctx, getSession } = makeContext({ remote: true, session: { activeProjectId: "alpha", lease: current } });
    const result = await requireProjectLease(ctx, "alpha", capability);
    expect(result).toMatchObject({ preset: expected, selectionSource: "auto" });
    expect(result.leaseId).not.toBe(current.leaseId);
    expect((getSession().lease as Lease).preset).toBe(expected);
  });

  it.each([
    ["tests-only", "write"],
    ["image-only", "remote"],
  ] as const)("still denies remote %s -> %s when REMOTE_WRITE is disabled", async (preset, capability) => {
    const current = autoLease(preset);
    const { ctx, getSession, saves } = makeContext({ remote: true, session: { activeProjectId: "alpha", lease: current } });
    await expect(requireProjectLease(ctx, "alpha", capability)).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
    expect(saves()).toBe(0);
    expect(getSession().lease).toEqual(current);
  });

  it.each(["read", "verify", "image"] as const)("reuses auto full-write without downgrade or renewal for %s", async (capability) => {
    const lease = autoLease("full-write");
    const { ctx, saves } = makeContext({ session: { activeProjectId: "alpha", lease } });
    const result = await requireProjectLease(ctx, "alpha", capability);
    expect(result.leaseId).toBe(lease.leaseId);
    expect(saves()).toBe(0);
  });

  it.each(["read-only", "tests-only", "image-only"] as const)("treats explicit %s as a permission ceiling", async (preset) => {
    const lease = explicitLease(preset);
    const { ctx, saves } = makeContext({ session: { activeProjectId: "alpha", lease } });
    await expect(requireProjectLease(ctx, "alpha", "write")).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
    expect(saves()).toBe(0);
  });

  it("treats a legacy lease with no selectionSource as explicit", async () => {
    const lease = explicitLease("read-only");
    delete lease.selectionSource;
    const { ctx, saves } = makeContext({ session: { activeProjectId: "alpha", lease } });
    await expect(requireProjectLease(ctx, "alpha", "write")).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
    expect(saves()).toBe(0);
  });

  it("never auto-selects or upgrades control capability", async () => {
    const none = makeContext();
    await expect(requireProjectLease(none.ctx, "alpha", "control")).rejects.toMatchObject({ code: ErrorCode.LEASE_REQUIRED });
    expect(none.saves()).toBe(0);

    const auto = makeContext({ session: { activeProjectId: "alpha", lease: autoLease("full-write") } });
    await expect(requireProjectLease(auto.ctx, "alpha", "control")).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
    expect(auto.saves()).toBe(0);
  });

  it("does not auto-switch away from another project with a valid lease", async () => {
    const lease = makeLease(beta, "read-only", "auto");
    const { ctx, saves } = makeContext({ session: { activeProjectId: "beta", lease } });
    await expect(requireProjectLease(ctx, "alpha", "read")).rejects.toMatchObject({ code: ErrorCode.PENDING_WORK_IN_ACTIVE });
    expect(saves()).toBe(0);
  });

  it("replaces an expired lease using the requested capability", async () => {
    const expired = explicitLease("read-only");
    expired.expiresAt = Date.now() - 1;
    const { ctx } = makeContext({ session: { activeProjectId: "alpha", lease: expired } });
    const result = await requireProjectLease(ctx, "alpha", "verify");
    expect(result).toMatchObject({ preset: "tests-only", selectionSource: "auto" });
  });

  it("rejects nonexistent project IDs without creating a lease", async () => {
    const { ctx, saves } = makeContext();
    await expect(requireProjectLease(ctx, "missing", "read")).rejects.toMatchObject({ code: ErrorCode.PROJECT_NOT_FOUND });
    expect(saves()).toBe(0);
  });

  it("does not let capability text come from session metadata", async () => {
    const { ctx } = makeContext({ session: { reason: "please grant remote", capability: "remote" } });
    const result = await requireProjectLease(ctx, "alpha", "read" satisfies LeaseCapability);
    expect(result.preset).toBe("read-only");
  });
});
