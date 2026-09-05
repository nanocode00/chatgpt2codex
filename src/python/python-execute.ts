import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildSafeChildEnv, killProcessTree } from "../exec/command-runner.js";
import { discoverPythonScriptRuntime, type NotebookRuntimeSource } from "../notebook/notebook.js";
import { resolveInProject } from "../policy/paths.js";
import { isSecretPath } from "../policy/secrets.js";
import { DomainError, ErrorCode } from "../types.js";
import { resolvePythonRuntimeProfile } from "./runtime-profiles.js";

export const MAX_PYTHON_SOURCE_BYTES = 2 * 1024 * 1024;
export const PYTHON_EXEC_TIMEOUT_MS = 30_000;
const STREAM_CAP_BYTES = 64 * 1024;
const STREAM_HEAD_BYTES = 48 * 1024;
const STREAM_TAIL_BYTES = STREAM_CAP_BYTES - STREAM_HEAD_BYTES;

export interface PythonExecutionResult {
  executed: boolean;
  path: string;
  runtimeSource: NotebookRuntimeSource;
  runtimeProfile?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

function validateScriptPath(rel: string): void {
  if (path.isAbsolute(rel) || rel.split(/[\\/]+/).includes("..")) {
    throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "python path must be project-relative and must not contain '..'", { rel });
  }
  if (path.extname(rel).toLowerCase() !== ".py") {
    throw new DomainError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, "python_execute only accepts .py files", { rel });
  }
}

async function resolvePythonSource(root: string, rel: string): Promise<string> {
  validateScriptPath(rel);
  const abs = await resolveInProject(root, rel, { allowSymlink: false });
  if (isSecretPath(abs)) throw new DomainError(ErrorCode.SECRET_BLOCKED, "Access to secret-classified Python source is blocked", { rel });
  const st = await fs.lstat(abs).catch(() => null);
  if (!st?.isFile() || st.isSymbolicLink()) throw new DomainError(ErrorCode.NOT_A_FILE, "python path is not a regular file", { rel });
  if (st.size > MAX_PYTHON_SOURCE_BYTES) throw new DomainError(ErrorCode.FILE_TOO_LARGE, `python source exceeds ${MAX_PYTHON_SOURCE_BYTES} byte limit`, { rel, bytes: st.size });
  const buf = await fs.readFile(abs);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new DomainError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, "python source must be strict UTF-8");
  }
  return abs;
}

function truncate(buf: Buffer): { text: string; truncated: boolean } {
  if (buf.length <= STREAM_CAP_BYTES) return { text: buf.toString("utf8"), truncated: false };
  const head = buf.subarray(0, STREAM_HEAD_BYTES).toString("utf8");
  const tail = buf.subarray(buf.length - STREAM_TAIL_BYTES).toString("utf8");
  return { text: `${head}\n...[truncated ${buf.length - STREAM_CAP_BYTES} bytes]...\n${tail}`, truncated: true };
}

function appendCapped(chunks: Buffer[], chunk: Buffer, seen: { bytes: number }): void {
  const retainLimit = STREAM_CAP_BYTES + 1;
  if (seen.bytes < retainLimit) chunks.push(chunk.subarray(0, Math.max(0, retainLimit - seen.bytes)));
  seen.bytes += chunk.length;
}

function killPythonExecution(pid: number | undefined, done: () => void): void {
  if (!pid) {
    done();
    return;
  }
  if (process.platform === "win32") {
    killProcessTree(pid, done);
    return;
  }
  try {
    // POSIX python_execute children are spawned detached below, making the
    // direct child the leader of a dedicated process group/session. Signal
    // only that group so ordinary subprocess descendants are terminated too.
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group may already be gone or group signaling may race with startup.
    // Fall back to the known direct child only; never target an unrelated group.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Child may already have exited.
    }
  }
  done();
}

export async function executePythonScript(root: string, rel: string, runtimeProfile?: string): Promise<PythonExecutionResult> {
  const absScript = await resolvePythonSource(root, rel);
  const runtime = runtimeProfile && runtimeProfile !== "auto"
    ? { interpreter: await resolvePythonRuntimeProfile(runtimeProfile), source: "profile" as const, projectEnvironmentBypassed: false }
    : await discoverPythonScriptRuntime(root);
  if (!runtime) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "No trusted executable Python runtime is available");

  const started = Date.now();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdoutSeen = { bytes: 0 };
  const stderrSeen = { bytes: 0 };

  return await new Promise<PythonExecutionResult>((resolve, reject) => {
    let settled = false;
    const child = spawn(runtime.interpreter, [absScript], {
      shell: false,
      cwd: root,
      env: buildSafeChildEnv(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout.on("data", (chunk: Buffer) => appendCapped(stdoutChunks, chunk, stdoutSeen));
    child.stderr.on("data", (chunk: Buffer) => appendCapped(stderrChunks, chunk, stderrSeen));

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killPythonExecution(child.pid, () => {
        reject(new DomainError(ErrorCode.TIMEOUT, `python_execute exceeded ${PYTHON_EXEC_TIMEOUT_MS}ms timeout`, { path: rel }));
      });
    }, PYTHON_EXEC_TIMEOUT_MS);

    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Trusted Python runtime failed to start"));
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = truncate(Buffer.concat(stdoutChunks));
      const stderr = truncate(Buffer.concat(stderrChunks));
      resolve({
        executed: code === 0,
        path: rel,
        runtimeSource: runtime.source,
        runtimeProfile: runtimeProfile && runtimeProfile !== "auto" ? runtimeProfile : undefined,
        exitCode: code,
        signal,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated || stdoutSeen.bytes > STREAM_CAP_BYTES,
        stderrTruncated: stderr.truncated || stderrSeen.bytes > STREAM_CAP_BYTES,
        durationMs: Date.now() - started,
      });
    });
  });
}
