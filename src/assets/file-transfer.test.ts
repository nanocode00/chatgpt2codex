import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileTransferManager, TRANSFER_CHUNK_BYTES, TRANSFER_MAX_BYTES } from "./file-transfer.js";

describe("on-demand generic binary file transfer", () => {
  let root: string;
  let t: FileTransferManager;
  const projectId = "fixture";
  const sessionId = "session-a";
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");
  const png = Buffer.from("89504e470d0a1a0a0000000049454e44ae426082", "hex");

  const hash = (x: Buffer) => createHash("sha256").update(x).digest("hex");
  const start = (name: string, data: Buffer, destPath?: string) =>
    t.begin({ projectId, root, sessionId, filename: name, sizeBytes: data.length, sha256: hash(data), destPath });
  const send = (transferId: string, index: number, bytes: Buffer) =>
    t.chunk({ projectId, root, sessionId, transferId, index, dataBase64: bytes.toString("base64") });
  const finish = (transferId: string) => t.finish({ projectId, root, sessionId, transferId });

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "c2c-transfer-test-"));
    t = new FileTransferManager();
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("preserves original PDF and PNG bytes across two independent requested transfers", async () => {
    const a = await start("paper.pdf", pdf);
    const b = await start("diagram.png", png);
    await send(a.transferId, 0, pdf.subarray(0, 12));
    await send(b.transferId, 0, png);
    await send(a.transferId, 1, pdf.subarray(12));
    const rb = await finish(b.transferId);
    const ra = await finish(a.transferId);
    expect(rb).toMatchObject({ bytes: png.length, sha256: hash(png), deduped: false });
    expect(ra).toMatchObject({ bytes: pdf.length, sha256: hash(pdf), deduped: false });
    expect(await readFile(path.join(root, ra.filePath))).toEqual(pdf);
    expect(await readFile(path.join(root, rb.filePath))).toEqual(png);
    const pending = await start("paper.pdf", pdf);
    expect(pending.destination).toEqual(ra.filePath);
    await t.abort({ projectId, root, sessionId, transferId: pending.transferId });
  });

  it("blocks malformed, duplicate, and out-of-order chunks and rejects incomplete finalization", async () => {
    const a = await start("paper.pdf", pdf);
    await expect(send(a.transferId, 1, pdf)).rejects.toThrow(/Out-of-order/);
    await expect(t.chunk({ projectId, root, sessionId, transferId: a.transferId, index: 0, dataBase64: "??==" })).rejects.toThrow(/Invalid/);
    await send(a.transferId, 0, pdf.subarray(0, 5));
    await expect(send(a.transferId, 0, pdf)).rejects.toThrow(/Out-of-order/);
    await expect(finish(a.transferId)).rejects.toThrow(/incomplete/);
    await send(a.transferId, 1, pdf.subarray(5));
    await finish(a.transferId);
  });

  it("detects a mismatched digest and discards the partial transfer", async () => {
    const a = await t.begin({ projectId, root, sessionId, filename: "wrong.pdf", sizeBytes: pdf.length, sha256: "a".repeat(64) });
    await send(a.transferId, 0, pdf);
    await expect(finish(a.transferId)).rejects.toThrow(/SHA-256 mismatch/);
    await expect(finish(a.transferId)).rejects.toThrow(/not found/);
  });

  it("deduplicates exact content but does not overwrite different content", async () => {
    const a = await start("paper.pdf", pdf);
    await send(a.transferId, 0, pdf);
    await finish(a.transferId);
    const b = await start("paper.pdf", pdf);
    await send(b.transferId, 0, pdf);
    expect((await finish(b.transferId)).deduped).toBe(true);
    const altered = Buffer.concat([pdf, Buffer.from("changed")]);
    const c = await start("paper.pdf", altered);
    await send(c.transferId, 0, altered);
    await expect(finish(c.transferId)).rejects.toThrow(/Destination exists/);
    expect(await readFile(path.join(root, ".chatgpt2codex/imports/paper.pdf"))).toEqual(pdf);
  });

  it("prevents escape paths, symlinks, secret filenames, and other-project access", async () => {
    await expect(start("../unsafe.pdf", pdf)).rejects.toThrow(/filename/);
    await expect(start(".env", pdf)).rejects.toThrow(/filename/);
    await expect(start("safe.pdf", pdf, "../../outside.pdf")).rejects.toThrow(/escapes/);
    const outside = await mkdtemp(path.join(os.tmpdir(), "c2c-transfer-outside-"));
    try {
      await mkdir(path.join(root, "uploads"));
      await symlink(outside, path.join(root, "uploads", "go"));
      await expect(start("safe.pdf", pdf, "uploads/go/escape.pdf")).rejects.toThrow(/symlink/);
      const a = await start("safe.pdf", pdf);
      await expect(t.chunk({ projectId: "different-project", root, sessionId, transferId: a.transferId, index: 0, dataBase64: pdf.toString("base64") })).rejects.toThrow(/not found/);
      await t.chunk({ projectId, root, sessionId: "another-session", transferId: a.transferId, index: 0, dataBase64: pdf.toString("base64") });
      const completed = await t.finish({ projectId, root, sessionId, transferId: a.transferId });
      expect(completed.sha256).toBe(hash(pdf));
      const canceled = await start("cancel.pdf", pdf);
      expect(await t.abort({ projectId, root, sessionId, transferId: canceled.transferId })).toEqual({ aborted: true });
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it("enforces declared bytes, maximum size, chunk bound and cleans abort", async () => {
    await expect(t.begin({ projectId, root, sessionId, filename: "large.bin", sizeBytes: TRANSFER_MAX_BYTES + 1, sha256: hash(pdf) })).rejects.toThrow(/size/);
    const a = await start("paper.pdf", pdf);
    await expect(send(a.transferId, 0, Buffer.alloc(TRANSFER_CHUNK_BYTES + 1, 1))).rejects.toThrow(/oversized/);
    await expect(send(a.transferId, 0, Buffer.concat([pdf, Buffer.from("too much")]))).rejects.toThrow(/byte count/);
    const abort = await t.abort({ projectId, root, sessionId, transferId: a.transferId });
    expect(abort.aborted).toBe(true);
    await expect(stat(path.join(root, ".chatgpt2codex/imports/paper.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
