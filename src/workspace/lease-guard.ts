import { DomainError, ErrorCode, type Lease, type LeasePreset, type ToolContext } from "../types.js";
import { makeLease } from "./project-select.js";
import { assertRemoteWriteAllowed } from "../server/remote-safety.js";

/**
 * Capability ceiling checked against the active project lease's preset.
 * Shared by src/server/tools.ts (file/command/git tools) and
 * src/control/tools.ts (desktop-control tools) so both enforce the same
 * preset -> capability table from a single source of truth.
 */
export type LeaseCapability = "read" | "verify" | "write" | "image" | "remote" | "control";

const ALLOWED_CAPABILITIES: Record<LeasePreset, ReadonlySet<LeaseCapability>> = {
  "read-only": new Set(["read"]),
  "tests-only": new Set(["read", "verify"]),
  "full-write": new Set(["read", "verify", "write", "image", "remote"]),
  "image-only": new Set(["read", "image"]),
  control: new Set(["read", "control"]),
};

const MINIMUM_PRESET: Record<Exclude<LeaseCapability, "control">, LeasePreset> = {
  read: "read-only",
  verify: "tests-only",
  write: "full-write",
  image: "image-only",
  remote: "full-write",
};

interface MutableLeaseSession {
  activeProjectId?: string;
  mode?: unknown;
  lease?: Lease;
  activeLease?: Lease;
  [key: string]: unknown;
}

function asLeaseSession(value: unknown): MutableLeaseSession {
  return value && typeof value === "object" ? value as MutableLeaseSession : {};
}

function activeLease(session: MutableLeaseSession): Lease | undefined {
  return session.lease ?? session.activeLease;
}

function isUnexpired(lease: Lease | undefined): lease is Lease {
  return Boolean(lease && Date.now() <= lease.expiresAt);
}

function leaseIsExplicit(lease: Lease): boolean {
  return lease.selectionSource !== "auto";
}

function presetForAutoUpgrade(current: LeasePreset | undefined, capability: Exclude<LeaseCapability, "control">): LeasePreset {
  const minimum = MINIMUM_PRESET[capability];
  if (!current) return minimum;
  if (current === "full-write") return current;
  if (ALLOWED_CAPABILITIES[current].has(capability)) return current;

  const required = new Set<LeaseCapability>([...ALLOWED_CAPABILITIES[current], capability]);
  for (const candidate of ["read-only", "tests-only", "image-only", "full-write"] as const) {
    if ([...required].every((item) => ALLOWED_CAPABILITIES[candidate].has(item))) return candidate;
  }
  return "full-write";
}

async function autoSelectLease(
  ctx: ToolContext,
  session: MutableLeaseSession,
  projectId: string,
  capability: Exclude<LeaseCapability, "control">,
  current?: Lease,
): Promise<Lease> {
  const entry = ctx.registry.find((project) => project.projectId === projectId);
  if (!entry) throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Project not found: ${projectId}`, { projectId });

  const preset = presetForAutoUpgrade(current?.preset, capability);
  if (preset === "full-write" && (capability === "write" || capability === "remote" || current?.preset !== "full-write")) {
    assertRemoteWriteAllowed(ctx, capability === "remote" ? "remote" : "write");
  }

  const lease = makeLease(entry, preset, "auto");
  await ctx.store.setSession({
    ...session,
    activeProjectId: entry.projectId,
    mode: session.mode ?? "read",
    lease,
  });
  await ctx.ledger.append({
    type: "project.lease.auto_selected",
    projectId: entry.projectId,
    requiredCapability: capability,
    preset,
    upgrade: Boolean(current),
  });
  return lease;
}

/**
 * Require an unexpired lease for `projectId` that permits `capability`.
 * Throws LEASE_REQUIRED (no/expired/mismatched lease) or PERMISSION_DENIED
 * (lease exists but its preset does not grant the requested capability).
 */
export async function requireProjectLease(
  ctx: ToolContext,
  projectId: string,
  capability: LeaseCapability = "read",
): Promise<Lease> {
  const rawSession = await ctx.store.getSession();
  const session = asLeaseSession(rawSession);
  const lease = activeLease(session);

  if (isUnexpired(lease) && lease.projectId !== projectId) {
    throw new DomainError(ErrorCode.PENDING_WORK_IN_ACTIVE, "Active project has an unexpired lease; switch projects explicitly", {
      activeProjectId: lease.projectId,
      requestedProjectId: projectId,
    });
  }

  if (isUnexpired(lease) && lease.projectId === projectId) {
    if (ALLOWED_CAPABILITIES[lease.preset].has(capability)) {
      if (capability === "write" || capability === "remote") assertRemoteWriteAllowed(ctx, capability);
      return lease;
    }
    if (capability === "control") {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "Control capability requires an explicit control lease", { projectId });
    }
    if (leaseIsExplicit(lease)) {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, `Lease preset ${lease.preset} does not allow ${capability}`, {
        projectId,
        preset: lease.preset,
        capability,
      });
    }
    return autoSelectLease(ctx, session, projectId, capability, lease);
  }

  if (capability === "control") {
    throw new DomainError(ErrorCode.LEASE_REQUIRED, "Control capability requires an explicit control lease", { projectId });
  }

  return autoSelectLease(ctx, session, projectId, capability);
}
