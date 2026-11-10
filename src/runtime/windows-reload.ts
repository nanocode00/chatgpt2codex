/** Authenticated, process-local Windows reload transport.
 *
 * A Windows SIGHUP is not supported. This named pipe exists only inside the
 * running CLI server. Its randomized endpoint and 256-bit bearer capability
 * are published in the caller's isolated private runtime directory; never
 * printed, sent via MCP/HTTP, or passed through argv/env.
 *
 * The CLI requester must independently verify the PID/command/start time
 * before reading the capability. The receiving server additionally validates
 * the capability in constant time. No arbitrary commands are accepted.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import path from "node:path";
import type { RuntimeInstanceRecord } from "./instances.js";

const MAX_PACKET = 4096;
const TIMEOUT_MS = 18_000;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

interface ControlDescriptor {
  version: 1;
  instance: string;
  pid: number;
  startedAt: number;
  pipe: string;
  capability: string;
}

export function windowsReloadControlPath(stateDir: string, instance: string): string {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(instance)) throw new Error("invalid instance for Windows reload");
  return path.join(stateDir, "runtime", instance + ".reload.json");
}

function validatedDescriptor(value: unknown, record: RuntimeInstanceRecord): ControlDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Windows reload endpoint is unavailable; restart the server with the updated CLI");
  }
  const v = value as Partial<ControlDescriptor>;
  const prefix = "\\\\.\\pipe\\c2c-reload-" + record.name + "-";
  if (v.version !== 1 || v.instance !== record.name ||
      v.pid !== record.pid || v.startedAt !== record.startedAt ||
      typeof v.pipe !== "string" || !v.pipe.startsWith(prefix) ||
      !/^[0-9a-f]{32}$/.test(v.pipe.slice(prefix.length)) ||
      typeof v.capability !== "string" || !/^[0-9a-f]{64}$/.test(v.capability)) {
    throw new Error("Windows reload endpoint does not match the verified runtime");
  }
  return v as ControlDescriptor;
}

function capabilityMatches(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string" || !/^[0-9a-f]{64}$/.test(actual)) return false;
  const left = Buffer.from(actual, "hex");
  const right = Buffer.from(expected, "hex");
  return timingSafeEqual(left, right);
}

export async function startWindowsReloadControl(
  stateDir: string,
  record: RuntimeInstanceRecord,
  onReload: () => Promise<void>,
): Promise<() => Promise<void>> {
  if (process.platform !== "win32") throw new Error("Windows reload control requires Windows");
  if (record.pid !== process.pid) throw new Error("reload server must own its runtime PID");
  const endpoint = windowsReloadControlPath(stateDir, record.name);
  const pipe = "\\\\.\\pipe\\c2c-reload-" + record.name + "-" + randomBytes(16).toString("hex");
  const descriptor: ControlDescriptor = {
    version: 1, instance: record.name, pid: record.pid, startedAt: record.startedAt,
    pipe, capability: randomBytes(32).toString("hex"),
  };

  let reloading = false;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy());
    let bytes = Buffer.alloc(0);
    let received = false;
    socket.on("data", (chunk: Buffer) => {
      if (received) return;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_PACKET) {
        received = true;
        socket.end('{"ok":false,"error":"request too large"}\n');
        return;
      }
      const end = bytes.indexOf(10);
      if (end < 0) return;
      received = true;
      let request: { operation?: unknown; capability?: unknown };
      try {
        request = JSON.parse(bytes.subarray(0, end).toString("utf8")) as typeof request;
      } catch {
        socket.end('{"ok":false,"error":"invalid request"}\n');
        return;
      }
      if (request.operation !== "reload" || !capabilityMatches(request.capability, descriptor.capability)) {
        socket.end('{"ok":false,"error":"unauthorized"}\n');
        return;
      }
      if (reloading) {
        socket.end('{"ok":false,"error":"reload already in progress"}\n');
        return;
      }
      reloading = true;
      void onReload()
        .then(() => socket.end(JSON.stringify({
          ok: true, reloaded: true, instance: record.name, pid: record.pid,
          scope: ["profiles", "repositories"],
        }) + "\n"))
        .catch(() => socket.end('{"ok":false,"error":"live catalog refresh failed"}\n'))
        .finally(() => { reloading = false; });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipe, () => { server.off("error", reject); resolve(); });
  });

  try {
    await fs.mkdir(path.dirname(endpoint), { recursive: true, mode: DIR_MODE });
    const temp = endpoint + "." + process.pid + "." + randomBytes(6).toString("hex") + ".tmp";
    try {
      await fs.writeFile(temp, JSON.stringify(descriptor), { mode: FILE_MODE, flag: "wx" });
      await fs.rename(temp, endpoint);
    } finally {
      await fs.unlink(temp).catch(() => undefined);
    }
  } catch (err) {
    server.close();
    throw err;
  }

  return async () => {
    for (const socket of sockets) socket.destroy();
    server.close();
    // Never remove another server's control file after a racing restart.
    try {
      const current = JSON.parse(await fs.readFile(endpoint, "utf8")) as Partial<ControlDescriptor>;
      if (current.pid === descriptor.pid && current.capability === descriptor.capability) {
        await fs.unlink(endpoint);
      }
    } catch { /* Already removed, corrupt or replaced: do not disrupt the runtime */ }
  };
}

export async function requestWindowsReloadControl(
  stateDir: string,
  record: RuntimeInstanceRecord,
): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows reload control requires Windows");
  let descriptor: ControlDescriptor;
  try {
    descriptor = validatedDescriptor(
      JSON.parse(await fs.readFile(windowsReloadControlPath(stateDir, record.name), "utf8")),
      record,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Windows reload endpoint")) throw error;
    throw new Error("Windows reload endpoint is unavailable; restart the server with the updated CLI");
  }

  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(descriptor.pipe);
    let finished = false;
    let response = Buffer.alloc(0);
    function finish(error?: Error) {
      if (finished) return;
      finished = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    }
    socket.setTimeout(TIMEOUT_MS, () => finish(new Error("Windows reload response timed out")));
    socket.on("error", () => finish(new Error("Windows reload named pipe is unreachable")));
    socket.on("connect", () => {
      socket.write(JSON.stringify({ operation: "reload", capability: descriptor.capability }) + "\n");
    });
    socket.on("data", (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > MAX_PACKET) {
        finish(new Error("Windows reload response exceeded size limit"));
        return;
      }
      const end = response.indexOf(10);
      if (end < 0) return;
      try {
        const result = JSON.parse(response.subarray(0, end).toString("utf8")) as {
          ok?: unknown; reloaded?: unknown; instance?: unknown; pid?: unknown; error?: unknown;
        };
        if (result.ok !== true || result.reloaded !== true ||
            result.instance !== record.name || result.pid !== record.pid) {
          finish(new Error("Windows reload was not acknowledged: " +
            (typeof result.error === "string" ? result.error.slice(0, 120) : "invalid response")));
        } else {
          finish();
        }
      } catch {
        finish(new Error("Windows reload response is invalid"));
      }
    });
    socket.on("end", () => {
      if (!finished) finish(new Error("Windows reload pipe closed before acknowledgement"));
    });
  });
}

// Exported solely for deterministic unit checks of record matching / protocol.
export const windowsReloadProtocolTest = { validatedDescriptor, capabilityMatches };
