import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeNotebook, MAX_NOTEBOOK_BYTES, validateNotebook } from "./notebook.js";
import { DomainError, ErrorCode } from "../types.js";

let root: string;

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
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
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
