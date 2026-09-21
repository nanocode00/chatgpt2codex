import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyManagedProfiles,
  normalizeManagedProfileAlias,
  readManagedProfiles,
  readManagedRepositories,
  slugRepositoryName,
  testPythonProfile,
  writeManagedProfiles,
  writeManagedRepositories,
} from "./catalog.js";

describe("runtime catalog", () => {
  let root: string;
  let configDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-catalog-"));
    configDir = path.join(root, "config");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips managed python and docker profiles", async () => {
    await writeManagedProfiles(configDir, {
      version: 1,
      python: { proj: "/opt/proj/bin/python" },
      docker: {
        proj: {
          composeFile: "compose.yml",
          projectName: "proj",
          services: ["app", "db"],
          controlServices: ["app"],
        },
      },
    });
    expect(await readManagedProfiles(configDir)).toEqual({
      version: 1,
      python: { proj: "/opt/proj/bin/python" },
      docker: {
        proj: {
          composeFile: "compose.yml",
          projectName: "proj",
          services: ["app", "db"],
          controlServices: ["app"],
        },
      },
    });
  });

  it("applies managed profiles above legacy env but below current process overrides", async () => {
    await writeManagedProfiles(configDir, {
      version: 1,
      python: { managed: "/managed/python" },
      docker: {},
    });
    const legacy = {
      CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES: '{"legacy":"/legacy/python"}',
    };
    const managed = await applyManagedProfiles(configDir, legacy, {});
    expect(managed.CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES).toBe('{"managed":"/managed/python"}');

    const overridden = await applyManagedProfiles(configDir, legacy, {
      CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES: '{"shell":"/shell/python"}',
    });
    expect(overridden.CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES).toBe('{"legacy":"/legacy/python"}');
  });

  it("round-trips managed repositories", async () => {
    await writeManagedRepositories(configDir, {
      version: 1,
      repositories: [
        { id: "proj", name: "Project", root: path.join(root, "project") },
      ],
    });
    expect(await readManagedRepositories(configDir)).toEqual({
      version: 1,
      repositories: [
        { id: "proj", name: "Project", root: path.join(root, "project") },
      ],
    });
    expect(slugRepositoryName("My Repo")).toBe("my-repo");
  });

  it("validates aliases and tests executable availability", async () => {
    expect(normalizeManagedProfileAlias("Proj-1")).toBe("proj-1");
    expect(() => normalizeManagedProfileAlias("auto")).toThrow();

    const executable = path.join(root, "python");
    await mkdir(root, { recursive: true });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    if (process.platform !== "win32") await chmod(executable, 0o755);
    expect((await testPythonProfile(executable)).available).toBe(true);
  });
});
