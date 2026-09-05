import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError, ErrorCode } from "../types.js";
import { discoverPythonScriptRuntime } from "../notebook/notebook.js";
import { executePythonScript, MAX_PYTHON_SOURCE_BYTES, PYTHON_EXEC_TIMEOUT_MS } from "./python-execute.js";

let root: string;
let savedScriptOperator: string | undefined;
let savedNotebookOperator: string | undefined;
let savedProfiles: string | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-python-exec-"));
  savedScriptOperator = process.env.CHATGPT2CODEX_PYTHON;
  savedNotebookOperator = process.env.CHATGPT2CODEX_NOTEBOOK_PYTHON;
  savedProfiles = process.env.CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES;
  delete process.env.CHATGPT2CODEX_PYTHON;
  delete process.env.CHATGPT2CODEX_NOTEBOOK_PYTHON;
  delete process.env.CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES;
});

afterEach(async () => {
  if (savedScriptOperator === undefined) delete process.env.CHATGPT2CODEX_PYTHON;
  else process.env.CHATGPT2CODEX_PYTHON = savedScriptOperator;
  if (savedNotebookOperator === undefined) delete process.env.CHATGPT2CODEX_NOTEBOOK_PYTHON;
  else process.env.CHATGPT2CODEX_NOTEBOOK_PYTHON = savedNotebookOperator;
  if (savedProfiles === undefined) delete process.env.CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES;
  else process.env.CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES = savedProfiles;
  await fs.rm(root, { recursive: true, force: true });
});

async function expectCode(promise: Promise<unknown>, code: ErrorCode) {
  await expect(promise).rejects.toMatchObject({ code });
}

async function hasSystemPython(): Promise<boolean> {
  return Boolean(await discoverPythonScriptRuntime(root, { env: { PATH: process.env.PATH } }));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(file: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fs.readFile(file, "utf8").catch(() => "");
    if (value.trim()) return value.trim();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path.basename(file)}`);
}

async function waitForProcessesGone(pids: number[], timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processExists(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`processes still alive: ${pids.filter(processExists).join(",")}`);
}

function cleanupProcesses(pids: number[]): void {
  for (const pid of pids) {
    if (!pid || !processExists(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function shortenNextTimeout(ms = 750) {
  const original = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    return original(handler, delay === PYTHON_EXEC_TIMEOUT_MS ? ms : delay, ...args) as NodeJS.Timeout;
  }) as typeof setTimeout);
  return { original, spy };
}

describe("python_execute path and source safety", () => {
  it("rejects non-.py, absolute paths, traversal, directories, oversized, invalid UTF-8, and symlink escape", async () => {
    await fs.writeFile(path.join(root, "note.txt"), "x");
    await expectCode(executePythonScript(root, "note.txt"), ErrorCode.UNSUPPORTED_MEDIA_TYPE);
    await expectCode(executePythonScript(root, path.join(root, "x.py")), ErrorCode.PATH_OUTSIDE_PROJECT);
    await expectCode(executePythonScript(root, "../x.py"), ErrorCode.PATH_OUTSIDE_PROJECT);

    await fs.mkdir(path.join(root, "dir.py"));
    await expectCode(executePythonScript(root, "dir.py"), ErrorCode.NOT_A_FILE);

    await fs.writeFile(path.join(root, "large.py"), Buffer.alloc(MAX_PYTHON_SOURCE_BYTES + 1, 0x20));
    await expectCode(executePythonScript(root, "large.py"), ErrorCode.FILE_TOO_LARGE);

    await fs.writeFile(path.join(root, "bad.py"), Buffer.from([0xff, 0xfe]));
    await expectCode(executePythonScript(root, "bad.py"), ErrorCode.UNSUPPORTED_MEDIA_TYPE);

    await fs.mkdir(path.join(root, ".ssh"));
    await fs.writeFile(path.join(root, ".ssh", "secret.py"), "print('secret')\n");
    await expectCode(executePythonScript(root, ".ssh/secret.py"), ErrorCode.SECRET_BLOCKED);

    const outside = path.join(os.tmpdir(), `chatgpt2codex-outside-${Date.now()}.py`);
    await fs.writeFile(outside, "print('outside')");
    try {
      await fs.symlink(outside, path.join(root, "escape.py"));
      await expectCode(executePythonScript(root, "escape.py"), ErrorCode.PATH_OUTSIDE_PROJECT);
    } finally {
      await fs.rm(outside, { force: true });
    }
  });
});

describe("python_execute execution", () => {
  it("runs harmless Python with project-root cwd, no caller argv, captures stderr and nonzero exit", async () => {
    if (!(await hasSystemPython())) return;
    await fs.mkdir(path.join(root, "sub"));
    await fs.writeFile(path.join(root, "sub", "ok.py"), [
      "import os,sys",
      "print('ok')",
      "print(os.getcwd())",
      "print(len(sys.argv))",
    ].join("\n"));
    const ok = await executePythonScript(root, "sub/ok.py");
    expect(ok.executed).toBe(true);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("ok");
    expect(ok.stdout).toContain(root);
    expect(ok.stdout).toMatch(/\n1\s*$/);
    expect(ok.runtimeSource).toBeTruthy();
    expect(ok).not.toHaveProperty("interpreter");

    await fs.writeFile(path.join(root, "fail.py"), "import sys\nprint('err', file=sys.stderr)\nsys.exit(7)\n");
    const failed = await executePythonScript(root, "fail.py");
    expect(failed.executed).toBe(false);
    expect(failed.exitCode).toBe(7);
    expect(failed.stderr).toContain("err");
  });

  it("caps stdout and stderr independently", async () => {
    if (!(await hasSystemPython())) return;
    await fs.writeFile(path.join(root, "large-output.py"), "import sys\nprint('x'*100000)\nprint('y'*100000, file=sys.stderr)\n");
    const result = await executePythonScript(root, "large-output.py");
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(70000);
    expect(Buffer.byteLength(result.stderr)).toBeLessThan(70000);
  });

  it("uses the safe child env without inheriting PYTHONPATH", async () => {
    const system = await discoverPythonScriptRuntime(root, { env: { PATH: process.env.PATH } });
    if (!system) return;
    const saved = process.env.PYTHONPATH;
    process.env.PYTHONPATH = "/bridge/private/path";
    process.env.CHATGPT2CODEX_PYTHON = system.interpreter;
    process.env.CHATGPT2CODEX_NOTEBOOK_PYTHON = system.interpreter;
    try {
      await fs.writeFile(path.join(root, "env.py"), [
        "import os",
        "print(os.environ.get('PYTHONPATH', '<missing>'))",
        "print(os.environ.get('CHATGPT2CODEX_PYTHON', '<missing>'))",
        "print(os.environ.get('CHATGPT2CODEX_NOTEBOOK_PYTHON', '<missing>'))",
      ].join("\n"));
      const result = await executePythonScript(root, "env.py");
      expect(result.stdout.trim().split(/\r?\n/)).toEqual(["<missing>", "<missing>", "<missing>"]);
    } finally {
      if (saved === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = saved;
    }
  });

  it("hard-times out and terminates a long-running child", async () => {
    if (!(await hasSystemPython())) return;
    await fs.writeFile(path.join(root, "sleep.py"), "import time\ntime.sleep(3600)\n");
    const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementationOnce(((handler: (...args: unknown[]) => void) => {
      queueMicrotask(handler);
      return 1 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
    try {
      await expect(executePythonScript(root, "sleep.py")).rejects.toMatchObject({ code: ErrorCode.TIMEOUT });
    } finally {
      timerSpy.mockRestore();
    }
  });

  it("runs the POSIX Python child as a dedicated process-group leader", async () => {
    if (process.platform === "win32" || !(await hasSystemPython())) return;
    await fs.writeFile(path.join(root, "group.py"), "import os\nprint(f'{os.getpid()} {os.getpgrp()}')\n");
    const result = await executePythonScript(root, "group.py");
    const [pid, pgid] = result.stdout.trim().split(/\s+/).map(Number);
    expect(pid).toBeGreaterThan(1);
    expect(pgid).toBe(pid);
  });

  it("kills one ordinary subprocess descendant on POSIX timeout", async () => {
    if (process.platform === "win32" || !(await hasSystemPython())) return;
    const pidFile = path.join(root, "child.pid");
    await fs.writeFile(path.join(root, "one-child.py"), [
      "import pathlib, subprocess, sys, time",
      "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])",
      `pathlib.Path(${JSON.stringify(pidFile)}).write_text(str(child.pid), encoding='utf-8')`,
      "time.sleep(60)",
    ].join("\n"));
    const { spy } = shortenNextTimeout();
    const descendants: number[] = [];
    try {
      const execution = executePythonScript(root, "one-child.py");
      descendants.push(Number(await waitForFile(pidFile)));
      await expect(execution).rejects.toMatchObject({ code: ErrorCode.TIMEOUT });
      await waitForProcessesGone(descendants);
    } finally {
      spy.mockRestore();
      cleanupProcesses(descendants);
    }
  });

  it("kills multiple ordinary subprocess descendants on POSIX timeout", async () => {
    if (process.platform === "win32" || !(await hasSystemPython())) return;
    const pidFile = path.join(root, "children.pid");
    await fs.writeFile(path.join(root, "many-children.py"), [
      "import pathlib, subprocess, sys, time",
      "children = [subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']) for _ in range(3)]",
      `pathlib.Path(${JSON.stringify(pidFile)}).write_text(','.join(str(p.pid) for p in children), encoding='utf-8')`,
      "time.sleep(60)",
    ].join("\n"));
    const { spy } = shortenNextTimeout();
    const descendants: number[] = [];
    try {
      const execution = executePythonScript(root, "many-children.py");
      descendants.push(...(await waitForFile(pidFile)).split(",").map(Number));
      await expect(execution).rejects.toMatchObject({ code: ErrorCode.TIMEOUT });
      await waitForProcessesGone(descendants);
    } finally {
      spy.mockRestore();
      cleanupProcesses(descendants);
    }
  });

  it("handles a descendant that exits before the parent times out", async () => {
    if (process.platform === "win32" || !(await hasSystemPython())) return;
    const pidFile = path.join(root, "short-child.pid");
    await fs.writeFile(path.join(root, "short-child.py"), [
      "import pathlib, subprocess, sys, time",
      "child = subprocess.Popen([sys.executable, '-c', 'pass'])",
      `pathlib.Path(${JSON.stringify(pidFile)}).write_text(str(child.pid), encoding='utf-8')`,
      "child.wait()",
      "time.sleep(60)",
    ].join("\n"));
    const { spy } = shortenNextTimeout();
    try {
      const execution = executePythonScript(root, "short-child.py");
      const childPid = Number(await waitForFile(pidFile));
      await waitForProcessesGone([childPid]);
      await expect(execution).rejects.toMatchObject({ code: ErrorCode.TIMEOUT });
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps notebook-only override out of script execution and preserves project-only imports", async () => {
    if (process.platform === "win32") return;
    const system = await discoverPythonScriptRuntime(root, { env: { PATH: process.env.PATH } });
    if (!system) return;
    const depDir = path.join(root, "fixture-deps");
    await fs.mkdir(depDir, { recursive: true });
    await fs.writeFile(path.join(depDir, "project_dep.py"), "VALUE = 'project-ok'\n");
    const projectPython = path.join(root, ".venv", "bin", "python");
    await fs.mkdir(path.dirname(projectPython), { recursive: true });
    await fs.writeFile(projectPython, [
      `#!${system.interpreter}`,
      "import runpy, sys",
      `sys.path.insert(0, ${JSON.stringify(depDir)})`,
      "runpy.run_path(sys.argv[1], run_name='__main__')",
    ].join("\n"));
    await fs.chmod(projectPython, 0o755);
    await fs.writeFile(path.join(root, "uses-dep.py"), "import project_dep\nprint(project_dep.VALUE)\n");

    process.env.CHATGPT2CODEX_NOTEBOOK_PYTHON = system.interpreter;
    const runtime = await discoverPythonScriptRuntime(root);
    expect(runtime?.source).toBe("project:.venv");
    const result = await executePythonScript(root, "uses-dep.py");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("project-ok");
  });

  it("uses CHATGPT2CODEX_PYTHON as the explicit script operator override", async () => {
    const system = await discoverPythonScriptRuntime(root, { env: { PATH: process.env.PATH } });
    if (!system) return;
    process.env.CHATGPT2CODEX_PYTHON = system.interpreter;
    process.env.CHATGPT2CODEX_NOTEBOOK_PYTHON = path.join(root, "ignored-notebook-python");
    const runtime = await discoverPythonScriptRuntime(root);
    expect(runtime?.source).toBe("operator");
    expect(runtime?.interpreter).toBe(system.interpreter);
  });

  it("treats omitted and auto runtimeProfile as existing auto discovery", async () => {
    const system = await discoverPythonScriptRuntime(root, { env: { PATH: process.env.PATH } });
    if (!system) return;
    process.env.CHATGPT2CODEX_PYTHON = system.interpreter;
    process.env.CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES = "not-json";
    await fs.writeFile(path.join(root, "auto.py"), "print('auto-ok')\n");
    const omitted = await executePythonScript(root, "auto.py");
    const auto = await executePythonScript(root, "auto.py", "auto");
    expect(auto.runtimeSource).toBe(omitted.runtimeSource);
    expect(auto.stdout).toBe(omitted.stdout);
    expect(auto.runtimeProfile).toBeUndefined();
  });

  it("selects an explicit configured profile ahead of project env and exposes alias only", async () => {
    if (process.platform === "win32") return;
    const system = await discoverPythonScriptRuntime(root, { env: { PATH: process.env.PATH } });
    if (!system) return;
    const projectDeps = path.join(root, "project-deps");
    const profileDeps = path.join(root, "profile-deps");
    await fs.mkdir(projectDeps, { recursive: true });
    await fs.mkdir(profileDeps, { recursive: true });
    await fs.writeFile(path.join(projectDeps, "selection_dep.py"), "VALUE='project-runtime'\n");
    await fs.writeFile(path.join(profileDeps, "selection_dep.py"), "VALUE='profile-runtime'\n");

    const projectPython = path.join(root, ".venv", "bin", "python");
    await fs.mkdir(path.dirname(projectPython), { recursive: true });
    await fs.writeFile(projectPython, [
      `#!${system.interpreter}`,
      "import runpy,sys",
      `sys.path.insert(0, ${JSON.stringify(projectDeps)})`,
      "runpy.run_path(sys.argv[1], run_name='__main__')",
    ].join("\n"));
    await fs.chmod(projectPython, 0o755);

    const profilePython = path.join(root, "configured", "python");
    await fs.mkdir(path.dirname(profilePython), { recursive: true });
    await fs.writeFile(profilePython, [
      `#!${system.interpreter}`,
      "import runpy,sys",
      `sys.path.insert(0, ${JSON.stringify(profileDeps)})`,
      "runpy.run_path(sys.argv[1], run_name='__main__')",
    ].join("\n"));
    await fs.chmod(profilePython, 0o755);
    process.env.CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES = JSON.stringify({ chosen: profilePython });
    await fs.writeFile(path.join(root, "profile.py"), "import selection_dep\nprint(selection_dep.VALUE)\n");

    const result = await executePythonScript(root, "profile.py", "chosen");
    expect(result.executed).toBe(true);
    expect(result.stdout.trim()).toBe("profile-runtime");
    expect(result.runtimeSource).toBe("profile");
    expect(result.runtimeProfile).toBe("chosen");
    expect(JSON.stringify(result)).not.toContain(profilePython);
  });

  it("fails closed for unknown or unavailable explicit profiles without fallback or path leakage", async () => {
    await fs.writeFile(path.join(root, "profile-error.py"), "print('must-not-run')\n");
    await expect(executePythonScript(root, "profile-error.py", "missing")).rejects.toMatchObject({ code: ErrorCode.COMMAND_NOT_ALLOWED });
    const unavailable = path.join(root, "missing-runtime", "python");
    process.env.CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES = JSON.stringify({ broken: unavailable });
    try {
      await executePythonScript(root, "profile-error.py", "broken");
      throw new Error("expected explicit runtime profile failure");
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.COMMAND_NOT_ALLOWED });
      expect(error instanceof Error ? error.message : String(error)).not.toContain(unavailable);
    }
  });

  it("keeps the process launch surface fixed to interpreter plus script path with shell disabled", async () => {
    const source = await fs.readFile(new URL("./python-execute.ts", import.meta.url), "utf8");
    expect(executePythonScript.length).toBe(3);
    expect(source).toContain("spawn(runtime.interpreter, [absScript], {");
    expect(source).toMatch(/shell:\s*false/);
    expect(source).toContain("cwd: root");
    expect(source).toContain("env: buildSafeChildEnv()");
    expect(source).toContain('detached: process.platform !== "win32"');
    expect(source).toContain('process.kill(-pid, "SIGKILL")');
    expect(source).toContain('if (process.platform === "win32")');
    expect(source).toContain("killProcessTree(pid, done)");
  });

});
