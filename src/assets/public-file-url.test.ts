import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchPublicBinaryFromUrl, type FetchLike } from "./image-url.js";
import { FileTransferManager } from "./file-transfer.js";

const pdf = Buffer.from("%PDF-1.4\n" + "sample public research document\n".repeat(5000) + "%%EOF\n");
const digest = createHash("sha256").update(pdf).digest("hex");
const lookupImpl = async (hostname: string) => {
  if (hostname === "public.example" || hostname === "cdn.public.example") return [{ address: "93.184.216.34", family: 4 }];
  if (hostname === "private.example") return [{ address: "169.254.169.254", family: 4 }];
  throw new Error("Unknown DNS test host");
};
function response(status: number, data: Buffer, headers: Record<string, string> = {}): Awaited<ReturnType<FetchLike>> {
  return {
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(data); c.close(); },
    }),
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
  };
}
const options = { lookupImpl, fetchImpl: async () => response(200, pdf) };

describe("public HTTPS original-binary file intake", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "c2c-public-file-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("imports multi-chunk public PDF without model Base64 and verifies exact bytes and digest", async () => {
    const manager = new FileTransferManager();
    const result = await manager.fromPublicUrl({
      projectId: "repo", root, filename: "research.pdf", url: "https://public.example/paper.pdf",
      sizeBytes: pdf.length, sha256: digest,
    }, options);
    expect(result).toMatchObject({ bytes: pdf.length, sha256: digest, deduped: false });
    expect(await readFile(path.join(root, result.filePath))).toEqual(pdf);
    const duplicate = await manager.fromPublicUrl({
      projectId: "repo", root, filename: "research.pdf", url: "https://public.example/paper.pdf",
      sizeBytes: pdf.length, sha256: digest,
    }, options);
    expect(duplicate.deduped).toBe(true);
  });

  it("rejects incorrect original size or SHA before writing any destination", async () => {
    const manager = new FileTransferManager();
    const input = { projectId: "repo", root, filename: "research.pdf", url: "https://public.example/paper.pdf", sizeBytes: pdf.length, sha256: digest };
    await expect(manager.fromPublicUrl({ ...input, sha256: "a".repeat(64) }, options)).rejects.toThrow(/mismatch/);
    await expect(manager.fromPublicUrl({ ...input, sizeBytes: pdf.length + 1 }, options)).rejects.toThrow(/mismatch/);
    await expect(stat(path.join(root, ".chatgpt2codex/imports/research.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects private addresses, insecure links, queries and insecure redirects", async () => {
    await expect(fetchPublicBinaryFromUrl("https://private.example/data.pdf", options)).rejects.toThrow(/blocked/);
    await expect(fetchPublicBinaryFromUrl("http://public.example/file.pdf", options)).rejects.toThrow(/HTTPS/);
    await expect(fetchPublicBinaryFromUrl("https://public.example/file.pdf?token=private", options)).rejects.toThrow(/HTTPS/);
    await expect(fetchPublicBinaryFromUrl("https://u:p@public.example/file.pdf", options)).rejects.toThrow(/HTTPS/);
    await expect(fetchPublicBinaryFromUrl("https://public.example/file.pdf", {
      lookupImpl, fetchImpl: async () => response(302, Buffer.alloc(0), { location: "http://public.example/untrusted" }),
    })).rejects.toThrow(/HTTPS/);
  });

  it("validates redirect DNS destinations and only uses pinned IPs", async () => {
    const checked: Array<{ url: string; address: string }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      checked.push({ url, address: init?.pinnedAddresses?.[0]?.address ?? "" });
      if (checked.length === 1) return response(302, Buffer.alloc(0), { location: "https://cdn.public.example/file.pdf" });
      return response(200, pdf);
    };
    const received = await fetchPublicBinaryFromUrl("https://public.example/file.pdf", {
      lookupImpl, fetchImpl, maxBytes: pdf.length,
    });
    expect(received).toEqual(pdf);
    expect(checked.map(v => v.address)).toEqual(["93.184.216.34", "93.184.216.34"]);
    const toPrivate: FetchLike = async () => response(302, Buffer.alloc(0), { location: "https://private.example/internal" });
    await expect(fetchPublicBinaryFromUrl("https://public.example/file.pdf", {
      lookupImpl, fetchImpl: toPrivate,
    })).rejects.toThrow(/blocked/);
  });

  it("enforces streaming body limits, including incorrect response Content-Length", async () => {
    await expect(fetchPublicBinaryFromUrl("https://public.example/file.pdf", {
      lookupImpl, maxBytes: 128, fetchImpl: async () => response(200, pdf, { "content-length": String(pdf.length) }),
    })).rejects.toThrow(/limit/);
    await expect(fetchPublicBinaryFromUrl("https://public.example/file.pdf", {
      lookupImpl, maxBytes: 128, fetchImpl: async () => response(200, pdf),
    })).rejects.toThrow(/exceeds/);
  });
});
