import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codeSearch } from "./search.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-search-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("codeSearch", () => {
  it("finds a matching line in a project file and reports a backend", async () => {
    await fs.writeFile(path.join(root, "a.ts"), "const needle = 42;\nconst other = 1;\n", "utf8");

    const result = await codeSearch(root, "needle");

    expect(["ripgrep", "ripgrep-js-fallback"]).toContain(result.backend);
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    const match = result.matches.find((m) => m.path === "a.ts");
    expect(match).toBeDefined();
    expect(match?.line).toBe(1);
    expect(match?.snippet).toContain("needle");
  });

  it("returns no matches for a query that does not appear anywhere", async () => {
    await fs.writeFile(path.join(root, "a.ts"), "const x = 1;\n", "utf8");

    const result = await codeSearch(root, "definitely_not_present_xyz");

    expect(result.matches).toEqual([]);
  });

  it("respects maxResults cap", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `needle ${i}`).join("\n");
    await fs.writeFile(path.join(root, "many.ts"), lines, "utf8");

    const result = await codeSearch(root, "needle", undefined, 5);

    expect(result.matches.length).toBeLessThanOrEqual(5);
  });

  it("does not descend into node_modules-style noise directories via the fallback walker", async () => {
    await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(root, "node_modules", "pkg", "index.js"), "needle_in_haystack", "utf8");
    await fs.writeFile(path.join(root, "real.ts"), "needle_in_haystack", "utf8");

    const result = await codeSearch(root, "needle_in_haystack");

    const paths = result.matches.map((m) => m.path);
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(paths).toContain("real.ts");
  });

  it("keeps .codex excluded from code_search while project skills use dedicated discovery", async () => {
    await fs.mkdir(path.join(root, ".codex", "skills", "hidden-skill"), { recursive: true });
    await fs.writeFile(path.join(root, ".codex", "skills", "hidden-skill", "SKILL.md"), "codex_skill_search_marker", "utf8");
    await fs.writeFile(path.join(root, "visible.ts"), "codex_skill_search_marker", "utf8");

    const result = await codeSearch(root, "codex_skill_search_marker");
    const paths = result.matches.map((m) => m.path);
    expect(paths.some((p) => p.includes(".codex"))).toBe(false);
    expect(paths).toContain("visible.ts");
  });

  it("returns an empty match set for an empty query rather than throwing", async () => {
    await fs.writeFile(path.join(root, "a.ts"), "content", "utf8");
    const result = await codeSearch(root, "");
    expect(result.matches).toEqual([]);
  });
});
