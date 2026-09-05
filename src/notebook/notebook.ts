import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DomainError, ErrorCode } from "../types.js";
import { resolveInProject } from "../policy/paths.js";
import { isSecretPath } from "../policy/secrets.js";
import { buildSafeChildEnv } from "../exec/command-runner.js";
import { resolvePythonRuntimeProfile } from "../python/runtime-profiles.js";

export const MAX_NOTEBOOK_BYTES = 10 * 1024 * 1024;
const EXEC_TIMEOUT_MS = 120_000;
const MAX_MESSAGE = 240;

export interface NotebookSyntaxError {
  cellIndex: number;
  summary: string;
}

export interface NotebookValidationResult {
  path: string;
  nbformat: number;
  nbformatMinor: number;
  codeCellCount: number;
  syntaxErrors: NotebookSyntaxError[];
  valid: boolean;
}

export interface NotebookExecutionResult {
  path: string;
  executed: boolean;
  codeCellCount: number;
  durationMs: number;
  runtimeSource?: NotebookRuntimeSource;
  runtimeProfile?: string;
  projectEnvironmentBypassed?: boolean;
  error?: { cellIndex?: number; exceptionType: string; message: string };
}

export type NotebookRuntimeSource =
  | "profile"
  | "operator"
  | "project:.venv"
  | "project:.venvs/runtime"
  | "project:venv"
  | "active-venv"
  | "active-conda"
  | "system";

type NotebookCell = Record<string, unknown> & { cell_type: string; source: string | string[]; metadata: Record<string, unknown> };
type NotebookDoc = Record<string, unknown> & { nbformat: number; nbformat_minor: number; metadata: Record<string, unknown>; cells: NotebookCell[] };

function validateInputPath(rel: string): void {
  if (path.isAbsolute(rel) || rel.split(/[\\/]+/).includes("..")) {
    throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "notebook path must be project-relative and must not contain '..'", { rel });
  }
  if (path.extname(rel).toLowerCase() !== ".ipynb") {
    throw new DomainError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, "notebook tools only accept .ipynb files", { rel });
  }
}

function parseNotebook(text: string): NotebookDoc {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DomainError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, "notebook is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, "notebook root must be an object");
  }
  const v = value as Record<string, unknown>;
  if (!Number.isInteger(v.nbformat) || (v.nbformat as number) < 1 || !Number.isInteger(v.nbformat_minor) || (v.nbformat_minor as number) < 0 || !Array.isArray(v.cells) || !v.metadata || typeof v.metadata !== "object" || Array.isArray(v.metadata)) {
    throw new DomainError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, "notebook is missing required nbformat fields");
  }
  const cells: NotebookCell[] = [];
  for (let i = 0; i < v.cells.length; i++) {
    const cell = v.cells[i];
    if (!cell || typeof cell !== "object" || Array.isArray(cell)) {
      throw new DomainError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, `cell ${i} must be an object`);
    }
    const c = cell as Record<string, unknown>;
    if (!(c.cell_type === "code" || c.cell_type === "markdown" || c.cell_type === "raw") || !(typeof c.source === "string" || (Array.isArray(c.source) && c.source.every((x) => typeof x === "string"))) || !c.metadata || typeof c.metadata !== "object" || Array.isArray(c.metadata)) {
      throw new DomainError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, `cell ${i} has invalid cell_type/source/metadata`);
    }
    if (c.cell_type === "code" && (!Array.isArray(c.outputs) || !(c.execution_count === null || Number.isInteger(c.execution_count)))) {
      throw new DomainError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, `code cell ${i} has invalid outputs/execution_count`);
    }
    cells.push(c as NotebookCell);
  }
  return { ...v, nbformat: v.nbformat as number, nbformat_minor: v.nbformat_minor as number, metadata: v.metadata as Record<string, unknown>, cells } as NotebookDoc;
}

async function readNotebook(root: string, rel: string): Promise<{ abs: string; doc: NotebookDoc }> {
  validateInputPath(rel);
  const abs = await resolveInProject(root, rel, { allowSymlink: false });
  if (isSecretPath(abs)) throw new DomainError(ErrorCode.SECRET_BLOCKED, "Access to secret-classified notebook path is blocked", { path: abs });
  const st = await fs.lstat(abs).catch(() => null);
  if (!st?.isFile()) throw new DomainError(ErrorCode.NOT_A_FILE, "notebook path is not a regular file", { rel });
  if (st.size > MAX_NOTEBOOK_BYTES) throw new DomainError(ErrorCode.FILE_TOO_LARGE, `notebook exceeds ${MAX_NOTEBOOK_BYTES} byte limit`, { rel, bytes: st.size });
  const buf = await fs.readFile(abs);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new DomainError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, "notebook must be strict UTF-8");
  }
  return { abs, doc: parseNotebook(text) };
}

type NotebookPythonCandidate = { interpreter: string; source: NotebookRuntimeSource };
type NotebookPythonProbe = (interpreter: string) => Promise<boolean>;
export type NotebookPythonRuntime = NotebookPythonCandidate & { projectEnvironmentBypassed: boolean };

const RUNTIME_PROBE_HELPER = "import nbformat,nbclient,ipykernel";

function activeVenvPython(prefix: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.join(prefix, "Scripts", "python.exe") : path.join(prefix, "bin", "python");
}

function activeCondaPython(prefix: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.join(prefix, "python.exe") : path.join(prefix, "bin", "python");
}

function projectPython(root: string, rel: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.join(root, rel, "Scripts", "python.exe") : path.join(root, rel, "bin", "python");
}

function addAbsoluteCandidate(candidates: NotebookPythonCandidate[], value: string | undefined, source: NotebookRuntimeSource, mapPath: (value: string) => string = (value) => value): void {
  const raw = value?.trim();
  if (!raw || !path.isAbsolute(raw)) return;
  candidates.push({ interpreter: mapPath(raw), source });
}

async function isTrustedInterpreterFile(candidate: string): Promise<boolean> {
  const st = await fs.lstat(candidate).catch(() => null);
  return Boolean(st?.isFile() && !st.isSymbolicLink());
}

async function isExecutableTrustedInterpreterFile(candidate: string, platform: NodeJS.Platform): Promise<boolean> {
  if (!(await isTrustedInterpreterFile(candidate))) return false;
  if (platform === "win32") return true;
  try {
    await fs.access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveSystemNotebookPython(
  pathValue: string | undefined,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  if (!pathValue) return undefined;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const delimiter = platform === "win32" ? ";" : ":";
  const executable = platform === "win32" ? "python.exe" : "python3";
  for (const rawEntry of pathValue.split(delimiter)) {
    const entry = rawEntry.trim();
    if (!entry || !pathApi.isAbsolute(entry)) continue;
    const candidate = pathApi.join(entry, executable);
    let canonical: string;
    try {
      canonical = await fs.realpath(candidate);
      const st = await fs.stat(canonical);
      if (!st.isFile()) continue;
      if (platform !== "win32") await fs.access(canonical, fsConstants.X_OK);
    } catch {
      continue;
    }
    return canonical;
  }
  return undefined;
}

async function defaultRuntimeProbe(interpreter: string): Promise<boolean> {
  try {
    const result = await runPython(interpreter, RUNTIME_PROBE_HELPER, "", 5_000);
    return !result.timedOut && result.code === 0;
  } catch {
    return false;
  }
}

export async function discoverNotebookPython(
  root: string,
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    requireNotebookRuntime?: boolean;
    probe?: NotebookPythonProbe;
  } = {},
): Promise<NotebookPythonRuntime | undefined> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const requireRuntime = options.requireNotebookRuntime ?? true;
  const probe = options.probe ?? defaultRuntimeProbe;
  const operatorCandidates: NotebookPythonCandidate[] = [];
  addAbsoluteCandidate(operatorCandidates, env.CHATGPT2CODEX_NOTEBOOK_PYTHON, "operator");
  for (const candidate of operatorCandidates) {
    if (!(await isTrustedInterpreterFile(candidate.interpreter))) continue;
    if (requireRuntime && !(await probe(candidate.interpreter))) continue;
    return { ...candidate, projectEnvironmentBypassed: false };
  }

  const projectCandidates: NotebookPythonCandidate[] = [
    { interpreter: projectPython(root, ".venv", platform), source: "project:.venv" },
    { interpreter: projectPython(root, path.join(".venvs", "runtime"), platform), source: "project:.venvs/runtime" },
    { interpreter: projectPython(root, "venv", platform), source: "project:venv" },
  ];
  let trustedProjectEnvironmentExists = false;
  for (const candidate of projectCandidates) {
    if (!(await isTrustedInterpreterFile(candidate.interpreter))) continue;
    trustedProjectEnvironmentExists = true;
    if (requireRuntime && !(await probe(candidate.interpreter))) continue;
    return { ...candidate, projectEnvironmentBypassed: false };
  }
  if (requireRuntime && trustedProjectEnvironmentExists && env.CHATGPT2CODEX_NOTEBOOK_STRICT_PROJECT_ENV === "1") return undefined;

  const fallbackCandidates: NotebookPythonCandidate[] = [];
  addAbsoluteCandidate(fallbackCandidates, env.VIRTUAL_ENV, "active-venv", (prefix) => activeVenvPython(prefix, platform));
  addAbsoluteCandidate(fallbackCandidates, env.CONDA_PREFIX, "active-conda", (prefix) => activeCondaPython(prefix, platform));
  for (const candidate of fallbackCandidates) {
    if (!(await isTrustedInterpreterFile(candidate.interpreter))) continue;
    if (requireRuntime && !(await probe(candidate.interpreter))) continue;
    return { ...candidate, projectEnvironmentBypassed: trustedProjectEnvironmentExists };
  }

  const safePath = options.env === undefined ? buildSafeChildEnv().PATH : env.PATH;
  const systemInterpreter = await resolveSystemNotebookPython(safePath, platform);
  if (!systemInterpreter) return undefined;
  if (requireRuntime && !(await probe(systemInterpreter))) return undefined;
  return { interpreter: systemInterpreter, source: "system", projectEnvironmentBypassed: trustedProjectEnvironmentExists };
}

/**
 * Select a trusted Python for ordinary script execution. Unlike notebook
 * execution this deliberately does not probe for nbformat/nbclient/ipykernel,
 * so the first trusted project environment wins even when it has no Jupyter
 * tooling installed.
 */
export async function discoverPythonScriptRuntime(
  root: string,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): Promise<NotebookPythonRuntime | undefined> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const operatorCandidates: NotebookPythonCandidate[] = [];
  addAbsoluteCandidate(operatorCandidates, env.CHATGPT2CODEX_PYTHON, "operator");
  for (const candidate of operatorCandidates) {
    if (await isExecutableTrustedInterpreterFile(candidate.interpreter, platform)) return { ...candidate, projectEnvironmentBypassed: false };
  }
  const projectCandidates: NotebookPythonCandidate[] = [
    { interpreter: projectPython(root, ".venv", platform), source: "project:.venv" },
    { interpreter: projectPython(root, path.join(".venvs", "runtime"), platform), source: "project:.venvs/runtime" },
    { interpreter: projectPython(root, "venv", platform), source: "project:venv" },
  ];
  for (const candidate of projectCandidates) {
    if (await isExecutableTrustedInterpreterFile(candidate.interpreter, platform)) return { ...candidate, projectEnvironmentBypassed: false };
  }
  const fallbackCandidates: NotebookPythonCandidate[] = [];
  addAbsoluteCandidate(fallbackCandidates, env.VIRTUAL_ENV, "active-venv", (prefix) => activeVenvPython(prefix, platform));
  addAbsoluteCandidate(fallbackCandidates, env.CONDA_PREFIX, "active-conda", (prefix) => activeCondaPython(prefix, platform));
  for (const candidate of fallbackCandidates) {
    if (await isExecutableTrustedInterpreterFile(candidate.interpreter, platform)) return { ...candidate, projectEnvironmentBypassed: false };
  }
  const safePath = options.env === undefined ? buildSafeChildEnv().PATH : env.PATH;
  const systemInterpreter = await resolveSystemNotebookPython(safePath, platform);
  return systemInterpreter ? { interpreter: systemInterpreter, source: "system", projectEnvironmentBypassed: false } : undefined;
}

function runPython(interpreter: string, script: string, stdinText: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(interpreter, ["-I", "-c", script], { shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: buildSafeChildEnv() });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => { if (stdout.length < 64_000) stdout += d; });
    child.stderr.on("data", (d: string) => { if (stderr.length < 16_000) stderr += d; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    child.stdin.end(stdinText, "utf8");
  });
}

const SYNTAX_HELPER = String.raw`
import ast,json,sys
cells=json.load(sys.stdin)
out=[]
for item in cells:
    try: ast.parse(item["source"], filename=f"<notebook-cell-{item['index']}>", mode="exec")
    except SyntaxError as e: out.append({"cellIndex":item["index"],"summary":f"{e.__class__.__name__}: {e.msg}"[:240]})
print(json.dumps(out))
`;

export async function validateNotebook(root: string, rel: string): Promise<NotebookValidationResult> {
  const { doc } = await readNotebook(root, rel);
  const codeCells = doc.cells.map((c, i) => ({ c, i })).filter(({ c }) => c.cell_type === "code");
  let syntaxErrors: NotebookSyntaxError[] = [];
  const runtime = await discoverNotebookPython(root, { requireNotebookRuntime: false });
  if (runtime && codeCells.length) {
    try {
      const r = await runPython(runtime.interpreter, SYNTAX_HELPER, JSON.stringify(codeCells.map(({ c, i }) => ({ index: i, source: Array.isArray(c.source) ? c.source.join("") : c.source }))), 15_000);
      if (!r.timedOut && r.code === 0) syntaxErrors = JSON.parse(r.stdout) as NotebookSyntaxError[];
    } catch {
      // Static syntax checking is best-effort; structural validation remains authoritative.
    }
  }
  return { path: rel, nbformat: doc.nbformat, nbformatMinor: doc.nbformat_minor, codeCellCount: codeCells.length, syntaxErrors, valid: syntaxErrors.length === 0 };
}

const EXEC_HELPER = String.raw`
import json,sys,tempfile,pathlib
try:
 import nbformat
 from nbclient import NotebookClient
 from nbclient.exceptions import CellExecutionError, CellTimeoutError
except Exception as e:
 print(json.dumps({"kind":"unavailable","type":e.__class__.__name__,"message":str(e)[:240]})); raise SystemExit(3)
payload=json.load(sys.stdin)
nb=nbformat.from_dict(payload["notebook"])
# Ignore notebook kernelspec metadata. Create a private kernelspec that points
# only at this already-discovered interpreter; notebook metadata can never
# choose argv, environment, or executable selection.
nb.metadata.pop("kernelspec", None)
with tempfile.TemporaryDirectory(prefix="chatgpt2codex-kernel-") as td:
 kdir=pathlib.Path(td)/"kernels"/"chatgpt2codex-python"
 kdir.mkdir(parents=True)
 (kdir/"kernel.json").write_text(json.dumps({"argv":[sys.executable,"-m","ipykernel_launcher","-f","{connection_file}"],"display_name":"chatgpt2codex-python","language":"python"}), encoding="utf-8")
 import os
 os.environ["JUPYTER_PATH"]=td
 client=NotebookClient(nb, timeout=payload["timeout"], kernel_name="chatgpt2codex-python", allow_errors=False, resources={"metadata":{"path":payload["cwd"]}})
 try:
  client.execute()
  print(json.dumps({"kind":"ok"}))
 except CellTimeoutError as e:
  print(json.dumps({"kind":"timeout","type":e.__class__.__name__,"message":"cell execution timed out"})); raise SystemExit(5)
 except CellExecutionError as e:
  idx=None
  for i,c in enumerate(nb.cells):
   for o in c.get("outputs",[]):
    if o.get("output_type")=="error": idx=i; et=o.get("ename") or "CellExecutionError"; msg=o.get("evalue") or "execution failed"; print(json.dumps({"kind":"cell","cellIndex":idx,"type":str(et)[:80],"message":str(msg)[:240]})); raise SystemExit(2)
  print(json.dumps({"kind":"cell","type":"CellExecutionError","message":"execution failed"})); raise SystemExit(2)
 except Exception as e:
  print(json.dumps({"kind":"runtime","type":e.__class__.__name__,"message":str(e)[:240]})); raise SystemExit(4)
`;

export async function executeNotebook(
  root: string,
  rel: string,
  internalOptions?: { cellTimeoutSec?: number; overallTimeoutMs?: number; runtimeProfile?: string },
): Promise<NotebookExecutionResult> {
  const started = Date.now();
  const { abs, doc } = await readNotebook(root, rel);
  const before = await fs.readFile(abs);
  const requestedProfile = internalOptions?.runtimeProfile;
  const runtime = requestedProfile && requestedProfile !== "auto"
    ? { interpreter: await resolvePythonRuntimeProfile(requestedProfile), source: "profile" as const, projectEnvironmentBypassed: false }
    : await discoverNotebookPython(root);
  if (!runtime) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Python runtime unavailable for notebook execution");
  if (requestedProfile && requestedProfile !== "auto" && !(await defaultRuntimeProbe(runtime.interpreter))) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Python runtime profile '${requestedProfile}' is unavailable for notebook execution`);
  }
  const payload = { notebook: doc, timeout: internalOptions?.cellTimeoutSec ?? 30, cwd: path.dirname(abs) };
  let r;
  try {
    r = await runPython(runtime.interpreter, EXEC_HELPER, JSON.stringify(payload), internalOptions?.overallTimeoutMs ?? EXEC_TIMEOUT_MS);
  } catch (e) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Python runtime unavailable for notebook execution");
  }
  const after = await fs.readFile(abs);
  if (!before.equals(after)) throw new DomainError(ErrorCode.PERMISSION_DENIED, "original notebook changed during execution validation");
  if (r.timedOut) throw new DomainError(ErrorCode.TIMEOUT, "notebook execution timed out");
  let detail: Record<string, unknown> = {};
  try { detail = JSON.parse(r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "{}"); } catch {}
  const codeCellCount = doc.cells.filter((c) => c.cell_type === "code").length;
  if (r.code === 0 && detail.kind === "ok") return { path: rel, executed: true, codeCellCount, durationMs: Date.now() - started, runtimeSource: runtime.source, runtimeProfile: requestedProfile && requestedProfile !== "auto" ? requestedProfile : undefined, projectEnvironmentBypassed: runtime.projectEnvironmentBypassed };
  if (r.code === 5 || detail.kind === "timeout") throw new DomainError(ErrorCode.TIMEOUT, "notebook cell execution timed out");
  const exceptionType = typeof detail.type === "string" ? detail.type.slice(0, 80) : (r.code === 3 ? "DependencyUnavailable" : "NotebookExecutionError");
  const message = (typeof detail.message === "string" ? detail.message : "notebook execution failed").slice(0, MAX_MESSAGE);
  if (r.code === 3) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Notebook runtime dependency unavailable: ${exceptionType}: ${message}`);
  return { path: rel, executed: false, codeCellCount, durationMs: Date.now() - started, runtimeSource: runtime.source, runtimeProfile: requestedProfile && requestedProfile !== "auto" ? requestedProfile : undefined, projectEnvironmentBypassed: runtime.projectEnvironmentBypassed, error: { cellIndex: typeof detail.cellIndex === "number" ? detail.cellIndex : undefined, exceptionType, message } };
}
