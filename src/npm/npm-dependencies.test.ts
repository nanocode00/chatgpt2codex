import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../types.js";
import {
  inspectNpmProject,
  installNpmDependencies,
  NPM_OPERATION_TIMEOUT_MS,
  parseNpmPackageSpec,
  removeNpmDependencies,
  type NpmExec,
  type NpmExecOptions,
} from "./npm-dependencies.js";

let root = "";

async function writePackage(data: unknown): Promise<void> {
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(data, null, 2) + "\n", "utf8");
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-npm-"));
  await writePackage({ name: "fixture", dependencies: {}, devDependencies: {}, scripts: { postinstall: "echo secret" } });
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("npm package spec validation", () => {
  for (const value of ["pg", "express", "@types/pg", "pg@8.16.3", "pg@^8.16.0", "@types/pg@8.15.5"]) {
    it(`accepts ${value}`, () => expect(parseNpmPackageSpec(value).raw).toBe(value));
  }

  for (const value of [
    "-g", "--global", "../pkg", "/tmp/pkg", "./pkg", "file:../pkg", "link:../pkg", "workspace:*",
    "https://example.test/pkg", "git+ssh://example.test/pkg", "github:user/repo", "pkg.tgz", "pkg@npm:other",
    "pkg name", "pkg\nname", "pkg@latest", "pkg@~1.2.3",
  ]) {
    it(`rejects ${JSON.stringify(value)}`, () => expect(() => parseNpmPackageSpec(value)).toThrow(/invalid/i));
  }
});

describe("safe npm dependency operations", () => {
  it("inspects only bounded dependency metadata", async () => {
    await writePackage({
      name: "fixture",
      scripts: { postinstall: "TOKEN_SHOULD_NOT_APPEAR" },
      dependencies: { pg: "^8.16.0" },
      devDependencies: { "@types/pg": "8.15.5" },
    });
    await fs.writeFile(path.join(root, "package-lock.json"), "{}\n");
    const result = await inspectNpmProject(root);
    expect(result).toEqual({
      manager: "npm",
      packageJson: true,
      lockfile: true,
      dependencies: { pg: "^8.16.0" },
      devDependencies: { "@types/pg": "8.15.5" },
    });
    expect(JSON.stringify(result)).not.toContain("postinstall");
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("rejects a symlinked package.json", async () => {
    const external = path.join(root, "external.json");
    await fs.writeFile(external, "{}\n");
    await fs.rm(path.join(root, "package.json"));
    await fs.symlink(external, path.join(root, "package.json"));
    await expect(inspectNpmProject(root)).rejects.toThrow(/not configured/i);
  });

  it("uses exact fixed install argv, authoritative cwd, safe env, shell false, and bounded timeout", async () => {
    let seen: { file: string; args: readonly string[]; options: NpmExecOptions } | undefined;
    process.env.NPM_TOKEN = "SECRET_NPM_TOKEN";
    process.env.NODE_AUTH_TOKEN = "SECRET_NODE_TOKEN";
    const exec: NpmExec = async (file, args, options) => {
      seen = { file, args, options };
      await writePackage({ name: "fixture", dependencies: { pg: "^8.16.3" }, devDependencies: {} });
      await fs.writeFile(path.join(root, "package-lock.json"), "{}\n");
    };
    const result = await installNpmDependencies(root, ["pg"], false, exec);
    expect(seen?.file).toMatch(/^npm(?:\.cmd)?$/);
    expect(seen?.args).toEqual(["install", "--ignore-scripts", "--no-audit", "--no-fund", "pg"]);
    expect(seen?.options.cwd).toBe(root);
    expect(seen?.options.shell).toBe(false);
    expect(seen?.options.timeout).toBe(NPM_OPERATION_TIMEOUT_MS);
    expect(seen?.options.maxBuffer).toBe(64 * 1024);
    expect(seen?.options.env.NPM_TOKEN).toBeUndefined();
    expect(seen?.options.env.NODE_AUTH_TOKEN).toBeUndefined();
    expect(result).toMatchObject({ manager: "npm", action: "install", packages: ["pg"], dev: false, packageJsonChanged: true, lockfile: true });
    delete process.env.NPM_TOKEN;
    delete process.env.NODE_AUTH_TOKEN;
  });

  it("uses exact fixed dev install argv", async () => {
    let args: readonly string[] = [];
    const exec: NpmExec = async (_file, nextArgs) => {
      args = nextArgs;
      await writePackage({ name: "fixture", dependencies: {}, devDependencies: { "@types/pg": "^8.15.5" } });
    };
    await installNpmDependencies(root, ["@types/pg"], true, exec);
    expect(args).toEqual(["install", "--save-dev", "--ignore-scripts", "--no-audit", "--no-fund", "@types/pg"]);
  });

  it("uses exact fixed remove argv and verifies removal", async () => {
    await writePackage({ name: "fixture", dependencies: { pg: "^8.16.0" }, devDependencies: {} });
    let args: readonly string[] = [];
    const exec: NpmExec = async (_file, nextArgs) => {
      args = nextArgs;
      await writePackage({ name: "fixture", dependencies: {}, devDependencies: {} });
    };
    const result = await removeNpmDependencies(root, ["pg"], exec);
    expect(args).toEqual(["uninstall", "--ignore-scripts", "--no-audit", "--no-fund", "pg"]);
    expect(result).toMatchObject({ manager: "npm", action: "remove", packages: ["pg"], packageJsonChanged: true });
  });

  it("never adds a lifecycle-script fallback", async () => {
    const calls: readonly string[][] = [];
    const mutable = calls as string[][];
    const exec: NpmExec = async (_file, args) => {
      mutable.push([...args]);
      await writePackage({ name: "fixture", dependencies: { pg: "1.0.0" }, devDependencies: {} });
    };
    await installNpmDependencies(root, ["pg"], false, exec);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--ignore-scripts");
  });

  it("sanitizes executor errors and does not leak credentials or paths", async () => {
    const marker = "SECRET_TOKEN_MARKER";
    const exec: NpmExec = async () => { throw new Error(`${marker} ${root}`); };
    let caught: unknown;
    try {
      await installNpmDependencies(root, ["pg"], false, exec);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect(String((caught as Error).message)).toBe("npm dependency install failed");
    expect(JSON.stringify(caught)).not.toContain(marker);
    expect(JSON.stringify(caught)).not.toContain(root);
  });
});
