import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RuntimeInstanceRecord {
  version: 1;
  name: string;
  pid: number;
  entrypoint?: string;
  serverLogPath?: string;
  tunnelPid?: number;
  tunnelMode?: "none" | "cloudflare";
  tunnelLogPath?: string;
  workspace: string;
  host: string;
  port: number;
  publicUrl: string;
  startedAt: number;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function normalizeInstanceName(value: string | boolean | undefined): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "default";
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(raw)) {
    throw new Error("instance name must match /^[A-Za-z0-9_.-]{1,64}$/");
  }
  return raw;
}

function runtimeDir(stateDir: string): string {
  return path.join(stateDir, "runtime");
}

function recordPath(stateDir: string, name: string): string {
  return path.join(runtimeDir(stateDir), `${normalizeInstanceName(name)}.json`);
}

async function ensureRuntimeDir(stateDir: string): Promise<void> {
  await mkdir(runtimeDir(stateDir), { recursive: true, mode: DIR_MODE });
}

export async function writeRuntimeInstance(stateDir: string, record: RuntimeInstanceRecord): Promise<void> {
  await ensureRuntimeDir(stateDir);
  const target = recordPath(stateDir, record.name);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(record, null, 2), { encoding: "utf8", mode: FILE_MODE });
  await rename(tmp, target);
}

export async function readRuntimeInstance(stateDir: string, name: string): Promise<RuntimeInstanceRecord | null> {
  try {
    const raw = JSON.parse(await readFile(recordPath(stateDir, name), "utf8")) as Partial<RuntimeInstanceRecord>;
    if (
      raw.version !== 1 ||
      typeof raw.name !== "string" ||
      typeof raw.pid !== "number" ||
      !Number.isInteger(raw.pid) ||
      raw.pid <= 0 ||
      (raw.entrypoint !== undefined && typeof raw.entrypoint !== "string") ||
      (raw.serverLogPath !== undefined && typeof raw.serverLogPath !== "string") ||
      (raw.tunnelPid !== undefined &&
        (typeof raw.tunnelPid !== "number" || !Number.isInteger(raw.tunnelPid) || raw.tunnelPid <= 0)) ||
      (raw.tunnelMode !== undefined && raw.tunnelMode !== "none" && raw.tunnelMode !== "cloudflare") ||
      (raw.tunnelLogPath !== undefined && typeof raw.tunnelLogPath !== "string") ||
      typeof raw.workspace !== "string" ||
      typeof raw.host !== "string" ||
      typeof raw.port !== "number" ||
      !Number.isInteger(raw.port) ||
      raw.port <= 0 ||
      raw.port > 65535 ||
      typeof raw.publicUrl !== "string" ||
      typeof raw.startedAt !== "number"
    ) {
      return null;
    }
    return raw as RuntimeInstanceRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export async function removeRuntimeInstance(stateDir: string, name: string): Promise<void> {
  await unlink(recordPath(stateDir, name)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
}

export async function listRuntimeInstances(stateDir: string): Promise<RuntimeInstanceRecord[]> {
  let names: string[];
  try {
    names = await readdir(runtimeDir(stateDir));
  } catch {
    return [];
  }
  const records: RuntimeInstanceRecord[] = [];
  for (const filename of names.filter((name) => name.endsWith(".json")).sort()) {
    const name = filename.slice(0, -5);
    const record = await readRuntimeInstance(stateDir, name);
    if (record) records.push(record);
  }
  return records;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface WindowsProcessSnapshot {
  commandLine: string | null;
  executablePath: string | null;
  creationTimeUtc: string | null;
}

/** Windows quoting rules for the direct Node/cloudflared commands spawned by c2c.
 * Unbalanced quotes are rejected instead of guessing process identity. */
export function splitWindowsCommandLine(commandLine: string): string[] {
  const argv: string[] = [];
  let i = 0;
  while (i < commandLine.length) {
    while (i < commandLine.length && /\s/.test(commandLine[i])) i++;
    if (i >= commandLine.length) break;
    let value = "";
    let quoted = false;
    while (i < commandLine.length) {
      const char = commandLine[i];
      if (!quoted && /\s/.test(char)) break;
      if (char === "\\") {
        let slashes = 0;
        while (commandLine[i] === "\\") { slashes++; i++; }
        if (commandLine[i] === '"') {
          value += "\\".repeat(Math.floor(slashes / 2));
          if (slashes % 2) { value += '"'; i++; }
          else { quoted = !quoted; i++; }
        } else {
          value += "\\".repeat(slashes);
        }
        continue;
      }
      if (char === '"') { quoted = !quoted; i++; continue; }
      value += char;
      i++;
    }
    if (quoted) return [];
    argv.push(value);
  }
  return argv;
}

function commandPathEqual(left: string, right: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    return path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
  }
  return path.resolve(left) === path.resolve(right);
}

function exactlyOneArg(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length && !argv.includes(flag, i + 1)
    ? argv[i + 1]
    : null;
}

export function runtimeCommandMatchesRecord(
  record: RuntimeInstanceRecord,
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!record.entrypoint || argv.length < 4 || argv[2] !== "serve" || argv[3] !== "--http") return false;
  if (!commandPathEqual(argv[1], record.entrypoint, platform)) return false;
  if (exactlyOneArg(argv, "--instance") !== record.name) return false;
  if (exactlyOneArg(argv, "--host") !== record.host) return false;
  if (exactlyOneArg(argv, "--port") !== String(record.port)) return false;
  const workspace = exactlyOneArg(argv, "--workspace");
  return workspace !== null && commandPathEqual(workspace, record.workspace, platform);
}

function processStartMatchesRecord(record: RuntimeInstanceRecord, timeString: string | null): boolean {
  const startedAt = timeString ? Date.parse(timeString) : NaN;
  const elapsed = record.startedAt - startedAt;
  // The runtime record is written after spawn, and the tunnel may start earlier.
  // Fail closed on missing timestamps or a PID reused after the record was written.
  return Number.isFinite(elapsed) && elapsed >= -15_000 && elapsed < 300_000;
}

function expectedExecutable(commandLine: string, executablePath: string, expected: string): string[] {
  const argv = splitWindowsCommandLine(commandLine);
  if (argv.length === 0) return [];
  const executable = path.win32.normalize(executablePath).toLowerCase();
  if (path.win32.basename(executable) !== expected || !commandPathEqual(argv[0], executable, "win32")) return [];
  return argv;
}

export function windowsProcessMatchesRecord(record: RuntimeInstanceRecord, snapshot: WindowsProcessSnapshot): boolean {
  if (!snapshot.commandLine || !snapshot.executablePath ||
      !processStartMatchesRecord(record, snapshot.creationTimeUtc)) return false;
  const argv = expectedExecutable(snapshot.commandLine, snapshot.executablePath, "node.exe");
  return argv.length > 0 && runtimeCommandMatchesRecord(record, argv, "win32");
}

export function tunnelCommandMatchesRecord(
  record: RuntimeInstanceRecord,
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  const executable = platform === "win32" ? path.win32.basename(argv[0] ?? "").toLowerCase()
    : path.basename(argv[0] ?? "");
  if (executable !== "cloudflared" && executable !== "cloudflared.exe") return false;
  // Only tunnels with an explicit localhost URL can be proven to belong to
  // this instance. Credential-only 'tunnel run' remains fail-closed.
  return exactlyOneArg(argv, "--url") === "http://127.0.0.1:" + record.port;
}

export function windowsTunnelMatchesRecord(record: RuntimeInstanceRecord, snapshot: WindowsProcessSnapshot): boolean {
  if (!snapshot.commandLine || !snapshot.executablePath ||
      !processStartMatchesRecord(record, snapshot.creationTimeUtc)) return false;
  const argv = expectedExecutable(snapshot.commandLine, snapshot.executablePath, "cloudflared.exe");
  return argv.length > 0 && tunnelCommandMatchesRecord(record, argv, "win32");
}

async function windowsProcessSnapshot(pid: number): Promise<WindowsProcessSnapshot | null> {
  // Fixed PowerShell script, integer-only PID passed in an environment variable.
  // No caller input is interpolated into executable commands or printed to logs.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$p = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $env:C2C_VERIFY_PID)",
    "if ($null -eq $p) { exit 2 }",
    "$result = [pscustomobject]@{ commandLine = $p.CommandLine; executablePath = $p.ExecutablePath; creationTimeUtc = $p.CreationDate.ToUniversalTime().ToString('o') }",
    "$result | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
    ], {
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 16_384,
      env: { ...process.env, C2C_VERIFY_PID: String(pid) },
    });
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const info = parsed as Record<string, unknown>;
    return {
      commandLine: typeof info.commandLine === "string" ? info.commandLine : null,
      executablePath: typeof info.executablePath === "string" ? info.executablePath : null,
      creationTimeUtc: typeof info.creationTimeUtc === "string" ? info.creationTimeUtc : null,
    };
  } catch {
    // CIM unavailable, access denied, exited PID or invalid data: never signal it.
    return null;
  }
}

export async function runtimeProcessMatchesRecord(record: RuntimeInstanceRecord): Promise<boolean> {
  if (!record.entrypoint || !isProcessAlive(record.pid)) return false;
  if (process.platform === "win32") {
    const snapshot = await windowsProcessSnapshot(record.pid);
    return snapshot !== null && windowsProcessMatchesRecord(record, snapshot);
  }
  if (process.platform !== "linux") return false;
  try {
    const raw = await readFile("/proc/" + record.pid + "/cmdline", "utf8");
    const argv = raw.split("\0").filter(Boolean);
    return runtimeCommandMatchesRecord(record, argv);
  } catch {
    return false;
  }
}

export async function runtimeTunnelMatchesRecord(record: RuntimeInstanceRecord): Promise<boolean> {
  if (!record.tunnelPid || !isProcessAlive(record.tunnelPid)) return false;
  if (process.platform === "win32") {
    const snapshot = await windowsProcessSnapshot(record.tunnelPid);
    return snapshot !== null && windowsTunnelMatchesRecord(record, snapshot);
  }
  if (process.platform !== "linux") return false;
  try {
    const raw = await readFile("/proc/" + record.tunnelPid + "/cmdline", "utf8");
    return tunnelCommandMatchesRecord(record, raw.split("\0").filter(Boolean));
  } catch {
    return false;
  }
}
