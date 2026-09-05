import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverNotebookPython, discoverPythonScriptRuntime, executeNotebook, MAX_NOTEBOOK_BYTES, resolveSystemNotebookPython, validateNotebook } from "./notebook.js";
import { DomainError, ErrorCode } from "../types.js";
import { buildSafeChildEnv } from "../exec/command-runner.js";

let root: string;
let savedProfiles: string | undefined;

function nb(cells: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    cells: cells.map((cell, index) => {
      const c = cell as Record<string, unknown>;
      return c.cell_type === "code"
        ? { id: `cell-${index}`, metadata: {}, outputs: [], execution_count: null, ...c }
        : { id: `cell-${index}`, metadata: {}, ...c };
    }),
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
    ...extra,
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-notebook-"));
  savedProfiles = process.env.CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES;
  delete process.env.CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES;
});

afterEach(async () => {
  if (savedProfiles === undefined) delete process.env.CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES;
  else process.env.CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES = savedProfiles;
  await fs.rm(root, { recursive: true, force: true });
});

async function fakePython(file: string): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "fake-python");
  return file;
}

async function executableFile(file: string, content = "fake-executable"): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  if (process.platform !== "win32") await fs.chmod(file, 0o755);
  return file;
}

const unixPython = (prefix: string) => path.join(prefix, "bin", "python");

describe("notebook interpreter discovery", () => {
  it("uses the explicit operator Python first", async () => {
    const operator = await fakePython(path.join(root, "operator", "python"));
    await fakePython(unixPython(path.join(root, ".venv")));
    const result = await discoverNotebookPython(root, { platform: "linux", env: { CHATGPT2CODEX_NOTEBOOK_PYTHON: operator }, probe: async () => true });
    expect(result).toEqual({ interpreter: operator, source: "operator", projectEnvironmentBypassed: false });
  });

  it.each([
    [".venv", "project:.venv"],
    [path.join(".venvs", "runtime"), "project:.venvs/runtime"],
    ["venv", "project:venv"],
  ] as const)("selects project-local %s", async (rel, source) => {
    const interpreter = await fakePython(unixPython(path.join(root, rel)));
    const result = await discoverNotebookPython(root, { platform: "linux", env: {}, probe: async () => true });
    expect(result).toEqual({ interpreter, source, projectEnvironmentBypassed: false });
  });

  it("selects inherited active VIRTUAL_ENV then CONDA_PREFIX", async () => {
    const venv = path.join(root, "active-venv");
    const conda = path.join(root, "active-conda");
    await fakePython(unixPython(venv));
    await fakePython(unixPython(conda));
    expect(await discoverNotebookPython(root, { platform: "linux", env: { VIRTUAL_ENV: venv, CONDA_PREFIX: conda }, probe: async () => true }))
      .toMatchObject({ source: "active-venv" });
    expect(await discoverNotebookPython(root, { platform: "linux", env: { CONDA_PREFIX: conda }, probe: async () => true }))
      .toMatchObject({ source: "active-conda" });
  });

  it("falls back from a project env without notebook runtime to an active env", async () => {
    const project = await fakePython(unixPython(path.join(root, ".venv")));
    const condaPrefix = path.join(root, "conda");
    const conda = await fakePython(unixPython(condaPrefix));
    const result = await discoverNotebookPython(root, {
      platform: "linux",
      env: { CONDA_PREFIX: condaPrefix },
      probe: async (candidate) => candidate === conda,
    });
    expect(project).not.toBe(conda);
    expect(result).toEqual({ interpreter: conda, source: "active-conda", projectEnvironmentBypassed: true });
  });

  it("returns unavailable when no trusted candidate has notebook runtime", async () => {
    await fakePython(unixPython(path.join(root, ".venv")));
    expect(await discoverNotebookPython(root, { platform: "linux", env: {}, probe: async () => false })).toBeUndefined();
  });

  it("ignores malformed/nonexistent operator override and safely falls back", async () => {
    const project = await fakePython(unixPython(path.join(root, ".venv")));
    expect(await discoverNotebookPython(root, { platform: "linux", env: { CHATGPT2CODEX_NOTEBOOK_PYTHON: "relative/python" }, probe: async () => true }))
      .toEqual({ interpreter: project, source: "project:.venv", projectEnvironmentBypassed: false });
    expect(await discoverNotebookPython(root, { platform: "linux", env: { CHATGPT2CODEX_NOTEBOOK_PYTHON: path.join(root, "missing-python") }, probe: async () => true }))
      .toEqual({ interpreter: project, source: "project:.venv", projectEnvironmentBypassed: false });
  });

  it("rejects symlink interpreters", async () => {
    const target = await fakePython(path.join(root, "target-python"));
    const link = unixPython(path.join(root, ".venv"));
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(target, link);
    const activePrefix = path.join(root, "active");
    const active = await fakePython(unixPython(activePrefix));
    const result = await discoverNotebookPython(root, { platform: "linux", env: { VIRTUAL_ENV: activePrefix }, probe: async () => true });
    expect(result).toEqual({ interpreter: active, source: "active-venv", projectEnvironmentBypassed: false });
  });

  it("does not derive candidates from notebook-controlled environment names", async () => {
    const seen: string[] = [];
    await discoverNotebookPython(root, { platform: "linux", env: { PATH: "" }, probe: async (candidate) => { seen.push(candidate); return false; } });
    expect(seen).toEqual([]);
    expect(seen.join(" ")).not.toMatch(/conda run|conda activate|kernel|argv/i);
  });

  it("marks project bypass when system fallback is selected", async () => {
    await fakePython(unixPython(path.join(root, ".venv")));
    const systemDir = path.join(root, "system-bin");
    const systemPython = await executableFile(path.join(systemDir, "python3"));
    const result = await discoverNotebookPython(root, {
      platform: "linux",
      env: { PATH: systemDir },
      probe: async (candidate) => candidate === systemPython,
    });
    expect(result).toEqual({ interpreter: systemPython, source: "system", projectEnvironmentBypassed: true });
  });

  it("strict project affinity blocks active/system fallback only for trusted project interpreters", async () => {
    const project = await fakePython(unixPython(path.join(root, ".venv")));
    const condaPrefix = path.join(root, "conda");
    const conda = await fakePython(unixPython(condaPrefix));
    expect(await discoverNotebookPython(root, {
      platform: "linux",
      env: { CONDA_PREFIX: condaPrefix, CHATGPT2CODEX_NOTEBOOK_STRICT_PROJECT_ENV: "1" },
      probe: async (candidate) => candidate === conda && candidate !== project,
    })).toBeUndefined();
  });

  it("strict mode still allows fallback when project interpreter is missing, malformed, or symlink-rejected", async () => {
    const condaPrefix = path.join(root, "conda");
    const conda = await fakePython(unixPython(condaPrefix));
    const target = await fakePython(path.join(root, "target-python"));
    const rejected = unixPython(path.join(root, ".venv"));
    await fs.mkdir(path.dirname(rejected), { recursive: true });
    await fs.symlink(target, rejected);
    await fs.mkdir(unixPython(path.join(root, ".venvs", "runtime")), { recursive: true });
    const result = await discoverNotebookPython(root, {
      platform: "linux",
      env: { CONDA_PREFIX: condaPrefix, CHATGPT2CODEX_NOTEBOOK_STRICT_PROJECT_ENV: "1" },
      probe: async () => true,
    });
    expect(result).toEqual({ interpreter: conda, source: "active-conda", projectEnvironmentBypassed: false });
  });

  it("operator override keeps priority in strict mode", async () => {
    const operator = await fakePython(path.join(root, "operator", "python"));
    await fakePython(unixPython(path.join(root, ".venv")));
    const result = await discoverNotebookPython(root, {
      platform: "linux",
      env: { CHATGPT2CODEX_NOTEBOOK_PYTHON: operator, CHATGPT2CODEX_NOTEBOOK_STRICT_PROJECT_ENV: "1" },
      probe: async (candidate) => candidate === operator,
    });
    expect(result).toEqual({ interpreter: operator, source: "operator", projectEnvironmentBypassed: false });
  });

  it("does not pass notebook interpreter-selection operator env into child environments", () => {
    const saved = {
      strict: process.env.CHATGPT2CODEX_NOTEBOOK_STRICT_PROJECT_ENV,
      python: process.env.CHATGPT2CODEX_NOTEBOOK_PYTHON,
      venv: process.env.VIRTUAL_ENV,
      conda: process.env.CONDA_PREFIX,
    };
    process.env.CHATGPT2CODEX_NOTEBOOK_STRICT_PROJECT_ENV = "1";
    process.env.CHATGPT2CODEX_NOTEBOOK_PYTHON = "/private/operator/python";
    process.env.VIRTUAL_ENV = "/private/venv";
    process.env.CONDA_PREFIX = "/private/conda";
    try {
      const childEnv = buildSafeChildEnv();
      expect(childEnv.CHATGPT2CODEX_NOTEBOOK_STRICT_PROJECT_ENV).toBeUndefined();
      expect(childEnv.CHATGPT2CODEX_NOTEBOOK_PYTHON).toBeUndefined();
      expect(childEnv.VIRTUAL_ENV).toBeUndefined();
      expect(childEnv.CONDA_PREFIX).toBeUndefined();
    } finally {
      if (saved.strict === undefined) delete process.env.CHATGPT2CODEX_NOTEBOOK_STRICT_PROJECT_ENV; else process.env.CHATGPT2CODEX_NOTEBOOK_STRICT_PROJECT_ENV = saved.strict;
      if (saved.python === undefined) delete process.env.CHATGPT2CODEX_NOTEBOOK_PYTHON; else process.env.CHATGPT2CODEX_NOTEBOOK_PYTHON = saved.python;
      if (saved.venv === undefined) delete process.env.VIRTUAL_ENV; else process.env.VIRTUAL_ENV = saved.venv;
      if (saved.conda === undefined) delete process.env.CONDA_PREFIX; else process.env.CONDA_PREFIX = saved.conda;
    }
  });
});

describe("Python script interpreter discovery", () => {
  it("uses CHATGPT2CODEX_PYTHON as the script-only operator override", async () => {
    const operator = await executableFile(path.join(root, "operator", "python"));
    await executableFile(unixPython(path.join(root, ".venv")));
    expect(await discoverPythonScriptRuntime(root, { platform: "linux", env: { CHATGPT2CODEX_PYTHON: operator } }))
      .toEqual({ interpreter: operator, source: "operator", projectEnvironmentBypassed: false });

    const project = unixPython(path.join(root, ".venv"));
    expect(await discoverPythonScriptRuntime(root, { platform: "linux", env: {} }))
      .toEqual({ interpreter: project, source: "project:.venv", projectEnvironmentBypassed: false });
  });

  it("ignores CHATGPT2CODEX_NOTEBOOK_PYTHON and keeps project affinity", async () => {
    const notebookOnly = await executableFile(path.join(root, "notebook-only", "python"));
    const project = await executableFile(unixPython(path.join(root, ".venv")));
    expect(await discoverPythonScriptRuntime(root, {
      platform: "linux",
      env: { CHATGPT2CODEX_NOTEBOOK_PYTHON: notebookOnly },
    })).toEqual({ interpreter: project, source: "project:.venv", projectEnvironmentBypassed: false });
  });

  it("keeps notebook and script operator overrides independent when both are set", async () => {
    const scriptOperator = await executableFile(path.join(root, "script-operator", "python"));
    const notebookOperator = await executableFile(path.join(root, "notebook-operator", "python"));
    expect(await discoverPythonScriptRuntime(root, {
      platform: "linux",
      env: {
        CHATGPT2CODEX_PYTHON: scriptOperator,
        CHATGPT2CODEX_NOTEBOOK_PYTHON: notebookOperator,
      },
    })).toEqual({ interpreter: scriptOperator, source: "operator", projectEnvironmentBypassed: false });

    expect(await discoverNotebookPython(root, {
      platform: "linux",
      env: {
        CHATGPT2CODEX_PYTHON: scriptOperator,
        CHATGPT2CODEX_NOTEBOOK_PYTHON: notebookOperator,
      },
      probe: async (candidate) => candidate === notebookOperator,
    })).toEqual({ interpreter: notebookOperator, source: "operator", projectEnvironmentBypassed: false });
  });

  it("does not let CHATGPT2CODEX_PYTHON change notebook selection", async () => {
    const scriptOperator = await executableFile(path.join(root, "script-only", "python"));
    const project = await executableFile(unixPython(path.join(root, ".venv")));
    expect(await discoverNotebookPython(root, {
      platform: "linux",
      env: { CHATGPT2CODEX_PYTHON: scriptOperator },
      probe: async (candidate) => candidate === project,
    })).toEqual({ interpreter: project, source: "project:.venv", projectEnvironmentBypassed: false });
  });

  it.each([
    [".venv", "project:.venv"],
    [path.join(".venvs", "runtime"), "project:.venvs/runtime"],
    ["venv", "project:venv"],
  ] as const)("selects executable project-local %s", async (rel, source) => {
    const interpreter = await executableFile(unixPython(path.join(root, rel)));
    expect(await discoverPythonScriptRuntime(root, { platform: "linux", env: {} }))
      .toEqual({ interpreter, source, projectEnvironmentBypassed: false });
  });

  it("falls back active venv then conda, then canonical system Python", async () => {
    const venv = path.join(root, "active-venv");
    const conda = path.join(root, "active-conda");
    await executableFile(unixPython(venv));
    await executableFile(unixPython(conda));
    expect(await discoverPythonScriptRuntime(root, { platform: "linux", env: { VIRTUAL_ENV: venv, CONDA_PREFIX: conda } })).toMatchObject({ source: "active-venv" });
    expect(await discoverPythonScriptRuntime(root, { platform: "linux", env: { CONDA_PREFIX: conda } })).toMatchObject({ source: "active-conda" });

    const bin = path.join(root, "system-bin");
    const target = await executableFile(path.join(root, "canonical-python"));
    await fs.mkdir(bin, { recursive: true });
    await fs.symlink(target, path.join(bin, "python3"));
    expect(await discoverPythonScriptRuntime(root, { platform: "linux", env: { PATH: bin } }))
      .toEqual({ interpreter: await fs.realpath(target), source: "system", projectEnvironmentBypassed: false });
  });
});

describe("system notebook Python resolution", () => {
  it("resolves the first absolute PATH candidate once to a canonical regular executable", async () => {
    if (process.platform === "win32") return;
    const first = path.join(root, "first");
    const target = await executableFile(path.join(root, "targets", "python-real"));
    await fs.mkdir(first, { recursive: true });
    await fs.symlink(target, path.join(first, "python3"));
    const resolved = await resolveSystemNotebookPython(`:${path.join("relative", "bin")}:${first}`, "linux");
    expect(resolved).toBe(await fs.realpath(target));
    expect(path.isAbsolute(resolved!)).toBe(true);
  });

  it("rejects a symlink whose final target is not a regular file", async () => {
    if (process.platform === "win32") return;
    const bin = path.join(root, "bin");
    const dirTarget = path.join(root, "directory-target");
    await fs.mkdir(bin, { recursive: true });
    await fs.mkdir(dirTarget, { recursive: true });
    await fs.symlink(dirTarget, path.join(bin, "python3"));
    expect(await resolveSystemNotebookPython(bin, "linux")).toBeUndefined();
  });

  it("rejects a non-executable Unix final target", async () => {
    if (process.platform === "win32") return;
    const bin = path.join(root, "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "python3"), "not executable");
    await fs.chmod(path.join(bin, "python3"), 0o644);
    expect(await resolveSystemNotebookPython(bin, "linux")).toBeUndefined();
  });

  it("returns unavailable when no system interpreter is found", async () => {
    expect(await discoverNotebookPython(root, { platform: process.platform, env: { PATH: path.join(root, "missing-bin") }, probe: async () => true })).toBeUndefined();
  });

  it("keeps the selected canonical interpreter after the discovery PATH value changes", async () => {
    if (process.platform === "win32") return;
    const firstBin = path.join(root, "first-bin");
    const secondBin = path.join(root, "second-bin");
    const first = await executableFile(path.join(firstBin, "python3"));
    await executableFile(path.join(secondBin, "python3"));
    const env: NodeJS.ProcessEnv = { PATH: firstBin };
    const selected = await discoverNotebookPython(root, { platform: "linux", env, probe: async () => true });
    env.PATH = secondBin;
    expect(selected?.interpreter).toBe(await fs.realpath(first));
    expect(selected?.source).toBe("system");
  });

  it("uses the same canonical system executable after the PATH entry changes", async () => {
    if (process.platform === "win32") return;
    const bin = path.join(root, "bin");
    const targetA = path.join(root, "python-a");
    const targetB = path.join(root, "python-b");
    const link = path.join(bin, "python3");
    const log = path.join(root, "runs.log");
    await fs.mkdir(bin, { recursive: true });
    const scriptA = `#!${process.execPath}\nconst fs=require('fs');const link=${JSON.stringify(link)};const b=${JSON.stringify(targetB)};const log=${JSON.stringify(log)};process.stdin.resume();process.stdin.on('end',()=>{fs.appendFileSync(log,'A\\n');try{fs.unlinkSync(link)}catch{};fs.symlinkSync(b,link);console.log(JSON.stringify({kind:'ok'}));});\n`;
    const scriptB = `#!${process.execPath}\nconst fs=require('fs');const log=${JSON.stringify(log)};process.stdin.resume();process.stdin.on('end',()=>{fs.appendFileSync(log,'B\\n');console.log(JSON.stringify({kind:'ok'}));});\n`;
    await executableFile(targetA, scriptA);
    await executableFile(targetB, scriptB);
    await fs.symlink(targetA, link);
    await fs.writeFile(path.join(root, "system.ipynb"), nb([{ cell_type: "code", source: "x=1\n" }]));

    const saved = {
      path: process.env.PATH,
      operator: process.env.CHATGPT2CODEX_NOTEBOOK_PYTHON,
      strict: process.env.CHATGPT2CODEX_NOTEBOOK_STRICT_PROJECT_ENV,
      venv: process.env.VIRTUAL_ENV,
      conda: process.env.CONDA_PREFIX,
    };
    process.env.PATH = bin;
    delete process.env.CHATGPT2CODEX_NOTEBOOK_PYTHON;
    delete process.env.CHATGPT2CODEX_NOTEBOOK_STRICT_PROJECT_ENV;
    delete process.env.VIRTUAL_ENV;
    delete process.env.CONDA_PREFIX;
    try {
      const result = await executeNotebook(root, "system.ipynb");
      expect(result).toMatchObject({ executed: true, runtimeSource: "system", projectEnvironmentBypassed: false });
      expect(JSON.stringify(result)).not.toContain(root);
      expect((await fs.readFile(log, "utf8")).trim().split("\n")).toEqual(["A", "A"]);
      expect(await fs.realpath(link)).toBe(await fs.realpath(targetB));
    } finally {
      if (saved.path === undefined) delete process.env.PATH; else process.env.PATH = saved.path;
      if (saved.operator === undefined) delete process.env.CHATGPT2CODEX_NOTEBOOK_PYTHON; else process.env.CHATGPT2CODEX_NOTEBOOK_PYTHON = saved.operator;
      if (saved.strict === undefined) delete process.env.CHATGPT2CODEX_NOTEBOOK_STRICT_PROJECT_ENV; else process.env.CHATGPT2CODEX_NOTEBOOK_STRICT_PROJECT_ENV = saved.strict;
      if (saved.venv === undefined) delete process.env.VIRTUAL_ENV; else process.env.VIRTUAL_ENV = saved.venv;
      if (saved.conda === undefined) delete process.env.CONDA_PREFIX; else process.env.CONDA_PREFIX = saved.conda;
    }
  });
});

describe("notebook validation", () => {
  it("validates a valid notebook", async () => {
    await fs.writeFile(path.join(root, "ok.ipynb"), nb([{ cell_type: "code", source: "x = 1\n" }]));
    const result = await validateNotebook(root, "ok.ipynb");
    expect(result.valid).toBe(true);
    expect(result.nbformat).toBe(4);
    expect(result.nbformatMinor).toBe(5);
    expect(result.codeCellCount).toBe(1);
  });

  it("rejects malformed JSON", async () => {
    await fs.writeFile(path.join(root, "bad.ipynb"), "{");
    await expect(validateNotebook(root, "bad.ipynb")).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_MEDIA_TYPE });
  });

  it("requires strict UTF-8", async () => {
    await fs.writeFile(path.join(root, "utf8.ipynb"), Buffer.from([0xff, 0xfe, 0xfd]));
    await expect(validateNotebook(root, "utf8.ipynb")).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_MEDIA_TYPE });
  });

  it("rejects notebooks over the size cap before parsing", async () => {
    await fs.writeFile(path.join(root, "large.ipynb"), Buffer.alloc(MAX_NOTEBOOK_BYTES + 1, 0x20));
    await expect(validateNotebook(root, "large.ipynb")).rejects.toMatchObject({ code: ErrorCode.FILE_TOO_LARGE });
  });

  it("rejects invalid nbformat structure", async () => {
    await fs.writeFile(path.join(root, "bad.ipynb"), JSON.stringify({ cells: [] }));
    await expect(validateNotebook(root, "bad.ipynb")).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_MEDIA_TYPE });
  });

  it("detects Python syntax errors", async () => {
    await fs.writeFile(path.join(root, "syntax.ipynb"), nb([{ cell_type: "code", source: "if True print('x')\n" }]));
    const result = await validateNotebook(root, "syntax.ipynb");
    expect(result.valid).toBe(false);
    expect(result.syntaxErrors[0]?.cellIndex).toBe(0);
  });

  it("rejects non-ipynb, traversal, absolute, and symlinks", async () => {
    await fs.writeFile(path.join(root, "x.txt"), "{}");
    await expect(validateNotebook(root, "x.txt")).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_MEDIA_TYPE });
    await expect(validateNotebook(root, "../x.ipynb")).rejects.toMatchObject({ code: ErrorCode.PATH_OUTSIDE_PROJECT });
    await expect(validateNotebook(root, path.join(root, "x.ipynb"))).rejects.toMatchObject({ code: ErrorCode.PATH_OUTSIDE_PROJECT });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-notebook-out-"));
    try {
      await fs.writeFile(path.join(outside, "o.ipynb"), nb([]));
      await fs.symlink(path.join(outside, "o.ipynb"), path.join(root, "link.ipynb"));
      await expect(validateNotebook(root, "link.ipynb")).rejects.toMatchObject({ code: ErrorCode.PATH_OUTSIDE_PROJECT });
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });

  it("keeps secret path guard", async () => {
    await fs.mkdir(path.join(root, ".ssh"), { recursive: true });
    await fs.writeFile(path.join(root, ".ssh", "secret.ipynb"), nb([]));
    await expect(validateNotebook(root, ".ssh/secret.ipynb")).rejects.toMatchObject({ code: ErrorCode.SECRET_BLOCKED });
  });
});

describe("notebook execution", () => {
  it("treats runtimeProfile=auto like omitted auto discovery even with malformed profile config", async () => {
    process.env.CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES = "not-json";
    await fs.writeFile(path.join(root, "auto.ipynb"), nb([{ cell_type: "code", source: "x=1\n" }]));
    try {
      const omitted = await executeNotebook(root, "auto.ipynb");
      const auto = await executeNotebook(root, "auto.ipynb", { runtimeProfile: "auto" });
      expect(auto.runtimeSource).toBe(omitted.runtimeSource);
      expect(auto.runtimeProfile).toBeUndefined();
    } catch (e) {
      if (e instanceof DomainError && e.code === ErrorCode.NOT_IMPLEMENTED) return;
      throw e;
    }
  });

  it("uses an explicit configured profile with notebook dependencies and exposes alias only", async () => {
    const runtime = await discoverNotebookPython(root);
    if (!runtime) return;
    process.env.CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES = JSON.stringify({ chosen: runtime.interpreter });
    process.env.CHATGPT2CODEX_NOTEBOOK_PYTHON = path.join(root, "ignored-operator-python");
    await fs.writeFile(path.join(root, "profile.ipynb"), nb([{ cell_type: "code", source: "x=2\n" }], {
      metadata: { kernelspec: { name: "attacker-controlled", argv: ["/tmp/evil"] } },
    }));
    const result = await executeNotebook(root, "profile.ipynb", { runtimeProfile: "chosen" });
    expect(result.executed).toBe(true);
    expect(result.runtimeSource).toBe("profile");
    expect(result.runtimeProfile).toBe("chosen");
    expect(JSON.stringify(result)).not.toContain(runtime.interpreter);
  });

  it("fails closed for an explicit profile without Jupyter dependencies and never falls back", async () => {
    if (process.platform === "win32") return;
    const system = await discoverPythonScriptRuntime(root, { env: { PATH: process.env.PATH } });
    if (!system) return;
    const wrapper = path.join(root, "no-jupyter-python");
    await executableFile(wrapper, `#!${system.interpreter}\nimport sys\nraise SystemExit(17)\n`);
    process.env.CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES = JSON.stringify({ bare: wrapper });
    await fs.writeFile(path.join(root, "no-jupyter.ipynb"), nb([{ cell_type: "code", source: "x=3\n" }]));
    await expect(executeNotebook(root, "no-jupyter.ipynb", { runtimeProfile: "bare" })).rejects.toMatchObject({ code: ErrorCode.NOT_IMPLEMENTED });
  });

  it("fails closed for unknown explicit notebook profiles", async () => {
    await fs.writeFile(path.join(root, "unknown.ipynb"), nb([{ cell_type: "code", source: "x=4\n" }]));
    await expect(executeNotebook(root, "unknown.ipynb", { runtimeProfile: "missing" })).rejects.toMatchObject({ code: ErrorCode.COMMAND_NOT_ALLOWED });
  });

  it("executes successfully when the trusted notebook runtime is available", async () => {
    const p = path.join(root, "success.ipynb");
    await fs.writeFile(p, nb([{ cell_type: "code", source: "x = 1 + 1\n" }]));
    try {
      const result = await executeNotebook(root, "success.ipynb");
      expect(result.executed).toBe(true);
      expect(result.error).toBeUndefined();
    } catch (e) {
      if (e instanceof DomainError && e.code === ErrorCode.NOT_IMPLEMENTED) return;
      throw e;
    }
  });

  it("reports a cell exception without returning notebook outputs", async () => {
    await fs.writeFile(path.join(root, "error.ipynb"), nb([{ cell_type: "code", source: "raise ValueError('short-safe-message')\n" }]));
    try {
      const result = await executeNotebook(root, "error.ipynb");
      expect(result.executed).toBe(false);
      expect(result.error).toMatchObject({ cellIndex: 0, exceptionType: "ValueError", message: "short-safe-message" });
      expect(JSON.stringify(result)).not.toContain("outputs");
    } catch (e) {
      if (e instanceof DomainError && e.code === ErrorCode.NOT_IMPLEMENTED) return;
      throw e;
    }
  });

  it("maps cell timeout to TIMEOUT", async () => {
    await fs.writeFile(path.join(root, "timeout.ipynb"), nb([{ cell_type: "code", source: "import time\ntime.sleep(3)\n" }]));
    try {
      await executeNotebook(root, "timeout.ipynb", { cellTimeoutSec: 1, overallTimeoutMs: 10_000 });
      throw new Error("expected notebook timeout");
    } catch (e) {
      if (e instanceof DomainError && e.code === ErrorCode.NOT_IMPLEMENTED) return;
      expect(e).toMatchObject({ code: ErrorCode.TIMEOUT });
    }
  });

  it("does not mutate the original even when runtime is unavailable or execution fails", async () => {
    const p = path.join(root, "run.ipynb");
    const original = nb([{ cell_type: "code", source: "raise RuntimeError('boom')\n" }]);
    await fs.writeFile(p, original);
    try { await executeNotebook(root, "run.ipynb"); } catch (e) { expect(e).toBeInstanceOf(DomainError); }
    expect(await fs.readFile(p, "utf8")).toBe(original);
  });
});
