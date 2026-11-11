/** Read-only view model for strictly bounded Tauri-owned diagnostic CLI replies. */
type Dict = Record<string, unknown>;
const object = (value: unknown): Dict | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Dict : null;
export const short = (value: unknown, limit = 160): string =>
  typeof value === "string" ? value.slice(0, limit) : "";

export interface RuntimeDiagnostic {
  name: string;
  alive: boolean;
  healthy: boolean;
  tunnelAlive: boolean | null;
  pid: number | null;
}
export function parseRuntimeStatus(value: unknown): RuntimeDiagnostic | null {
  const d = object(value);
  if (!d || d.alive === undefined || d.healthy === undefined ||
      typeof d.alive !== "boolean" || typeof d.healthy !== "boolean") return null;
  return {
    name: short(d.name, 64) || "tauri-preview-v1",
    alive: d.alive,
    healthy: d.healthy,
    tunnelAlive: typeof d.tunnelAlive === "boolean" ? d.tunnelAlive : null,
    pid: Number.isSafeInteger(d.pid) && Number(d.pid) > 0 ? Number(d.pid) : null
  };
}

export interface HealthDiagnostic {
  alive: boolean;
  healthy: boolean;
  publicHealthy: boolean | null;
  tunnelAlive: boolean | null;
}
export function parseHealth(value: unknown): HealthDiagnostic | null {
  const d = object(value);
  if (!d || typeof d.alive !== "boolean" || typeof d.healthy !== "boolean") return null;
  return {
    alive: d.alive,
    healthy: d.healthy,
    publicHealthy: typeof d.publicHealthy === "boolean" ? d.publicHealthy : null,
    tunnelAlive: typeof d.tunnelAlive === "boolean" ? d.tunnelAlive : null
  };
}

export interface LockHolder {
  owner: string;
  pid: number | null;
  mode: "read" | "write";
}
export interface LockDiagnostic {
  projectRoot: string;
  writer: LockHolder | null;
  readers: LockHolder[];
}
function holder(value: unknown): LockHolder | null {
  const d = object(value);
  if (!d || (d.mode !== "read" && d.mode !== "write")) return null;
  return { owner: short(d.owner, 80) || "미확인",
    pid: Number.isSafeInteger(d.pid) && Number(d.pid) > 0 ? Number(d.pid) : null,
    mode: d.mode };
}
/** Shows only the CLI's lock *list* (not its force-release diagnostic API).
 * A parsed empty array means no active locks; a bad reply remains unknown. */
export function parseLocks(value: unknown): LockDiagnostic[] | null {
  const d = object(value);
  if (!d || !Array.isArray(d.locks)) return null;
  if (d.locks.length > 128) return null;
  const locks: LockDiagnostic[] = [];
  for (const raw of d.locks) {
    const item = object(raw);
    if (!item || typeof item.projectRoot !== "string" || item.projectRoot.length > 2048 ||
        !Array.isArray(item.readers) || item.readers.length > 64) return null;
    const writer = item.writer === null ? null : holder(item.writer);
    if (item.writer !== null && writer === null) return null;
    const readers = item.readers.map(holder);
    if (readers.some(row => row === null)) return null;
    locks.push({ projectRoot: item.projectRoot, writer, readers: readers as LockHolder[] });
  }
  return locks;
}

export function displayCliText(value: unknown): string {
  if (typeof value !== "string") return "";
  // Redaction and 80-line/512-char limits are applied at Rust boundary.
  // Add a client-side cap and strip CLI's *generic* default:7979 guidance:
  // it does not describe the isolated Tauri:18797 instance.
  return value.split(/\r?\n/).filter(line =>
    !/^http default endpoint:/i.test(line.trim())
  ).slice(-80).map(line => line.slice(0, 512)).join("\n").slice(0, 40_960);
}
