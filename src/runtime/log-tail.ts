import { open } from "node:fs/promises";
import path from "node:path";
import { normalizeInstanceName } from "./instances.js";

export type RuntimeLogComponent = "server" | "tunnel";

const MAX_LOG_BYTES = 128 * 1024;
const MAX_LOG_LINES = 5000;

/** Logs are persistent artifacts, not proof of a live MCP instance.
 * Resolve only the canonical per-instance filenames under our own state dir.
 * Never follow arbitrary paths supplied by a runtime process record.
 */
export function runtimeLogFile(stateDir: string, instance: string, component: RuntimeLogComponent): string {
  const name = normalizeInstanceName(instance);
  if (component !== "server" && component !== "tunnel") {
    throw new Error("log component must be server or tunnel");
  }
  return path.join(stateDir, "logs", name + (component === "server" ? ".server.log" : ".cloudflared.log"));
}

/** Read a bounded tail even after "c2c stop" removed the runtime record.
 * A missing file produces an empty result; permission and I/O errors remain errors.
 */
export async function readRuntimeLogTail(
  stateDir: string, instance: string, component: RuntimeLogComponent, lines: number
): Promise<string> {
  if (!Number.isInteger(lines) || lines < 1 || lines > MAX_LOG_LINES) {
    throw new Error("log line count must be 1..5000");
  }
  const file = runtimeLogFile(stateDir, instance, component);
  let handle;
  try {
    handle = await open(file, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("log path is not a regular file");
    const length = Math.min(info.size, MAX_LOG_BYTES);
    if (length === 0) return "";
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, info.size - length);
    let content = bytes.subarray(0, bytesRead).toString("utf8");
    // If bounded to the tail, discard the first potentially partial line.
    if (info.size > length) {
      const firstNewline = content.indexOf("\n");
      content = firstNewline >= 0 ? content.slice(firstNewline + 1) : "";
    }
    const output = content.split(/\r?\n/);
    if (output[output.length - 1] === "") output.pop();
    return output.slice(-lines).join("\n");
  } finally {
    await handle.close();
  }
}
