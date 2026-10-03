import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";
import { resolveInProject } from "../policy/paths.js";
import { isSecretPath } from "../policy/secrets.js";

export const TRANSFER_MAX_BYTES = 20 * 1024 * 1024;
export const TRANSFER_CHUNK_BYTES = 256 * 1024;
export const TRANSFER_MAX_ACTIVE = 8;
const TRANSFER_TTL_MS = 30 * 60 * 1000;
const INTAKE_DIR = ".chatgpt2codex/imports";
const SHA256 = /^[a-fA-F0-9]{64}$/;

interface Transfer {
  id: string;
  projectId: string;
  root: string;
  filename: string;
  destRel: string;
  stageDir: string;
  stageFile: string;
  handle: fs.FileHandle;
  expectedBytes: number;
  expectedSha256: string;
  receivedBytes: number;
  nextIndex: number;
  hash: ReturnType<typeof createHash>;
  startedAt: number;
}

function invalid(message: string): never {
  throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, message);
}

function safeFilename(filename: string): string {
  const normalized = filename.normalize("NFC");
  if (!normalized || normalized.length > 160 || normalized === "." || normalized === ".." ||
      normalized.startsWith(".") || /[/\\\0-\x1f\x7f]/.test(normalized) ||
      path.basename(normalized) !== normalized || isSecretPath(normalized)) {
    return invalid("Invalid or secret-classified transfer filename");
  }
  return normalized;
}

function decodeChunk(value: string): Buffer {
  // Buffer.from(base64) silently tolerates malformed characters, so require canonical base64.
  if (!value || value.length > Math.ceil(TRANSFER_CHUNK_BYTES / 3) * 4 ||
      value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return invalid("Invalid or oversized transfer chunk");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > TRANSFER_CHUNK_BYTES ||
      bytes.toString("base64") !== value) {
    return invalid("Non-canonical or oversized transfer chunk");
  }
  return bytes;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export class FileTransferManager {
  private active = new Map<string, Transfer>();

  private async discard(t: Transfer): Promise<void> {
    this.active.delete(t.id);
    await t.handle.close().catch(() => undefined);
    await fs.rm(t.stageDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private async reap(): Promise<void> {
    const now = Date.now();
    for (const t of this.active.values()) {
      if (now - t.startedAt > TRANSFER_TTL_MS) await this.discard(t);
    }
  }

  private async owned(projectId: string, root: string, id: string): Promise<Transfer> {
    await this.reap();
    const t = this.active.get(id);
    // ChatGPT's remote MCP client may initialize a fresh session for each tool
    // invocation. Bind the transfer to the selected project and the
    // unguessable transfer ID, not a connection-scoped MCP session ID.
    // The tool boundary requires a valid full-write lease on *every* call.
    if (!t || t.projectId !== projectId || path.resolve(t.root) !== path.resolve(root)) {
      return invalid("Transfer not found for this project");
    }
    return t;
  }

  async begin(input: {
    projectId: string; root: string; sessionId?: string;
    filename: string; sizeBytes: number; sha256: string; destPath?: string;
  }): Promise<{ transferId: string; chunkBytes: number; destination: string }> {
    await this.reap();
    if (this.active.size >= TRANSFER_MAX_ACTIVE) return invalid("Too many active transfers");
    const filename = safeFilename(input.filename);
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > TRANSFER_MAX_BYTES)
      return invalid("Transfer size must be between 1 and 20971520 bytes");
    if (!SHA256.test(input.sha256)) return invalid("Invalid expected SHA-256");

    const destRel = input.destPath ?? path.join(INTAKE_DIR, filename);
    if (isSecretPath(destRel)) return invalid("Cannot transfer into a secret-classified path");
    const destAbs = await resolveInProject(input.root, destRel, { allowSymlink: false, rejectRoot: true });
    const rootAbs = await fs.realpath(input.root);
    const rel = path.relative(rootAbs, destAbs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return invalid("Destination escapes the project");

    const stagingRoot = await resolveInProject(input.root, path.join(INTAKE_DIR, ".staging"), { allowSymlink: false });
    await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const stageDir = await fs.mkdtemp(path.join(stagingRoot, "upload-"));
    const stageFile = path.join(stageDir, "upload.part");
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(stageFile, "wx", 0o600);
    } catch (err) {
      await fs.rm(stageDir, { recursive: true, force: true });
      throw err;
    }
    const id = randomUUID();
    this.active.set(id, {
      id, projectId: input.projectId, root: rootAbs,
      filename, destRel: rel, stageDir, stageFile, handle,
      expectedBytes: input.sizeBytes, expectedSha256: input.sha256.toLowerCase(),
      receivedBytes: 0, nextIndex: 0, hash: createHash("sha256"), startedAt: Date.now(),
    });
    return { transferId: id, chunkBytes: TRANSFER_CHUNK_BYTES, destination: rel };
  }

  async chunk(input: {
    projectId: string; root: string; sessionId?: string;
    transferId: string; index: number; dataBase64: string;
  }): Promise<{ receivedBytes: number; nextIndex: number }> {
    const t = await this.owned(input.projectId, input.root, input.transferId);
    if (input.index !== t.nextIndex) return invalid("Out-of-order or duplicate transfer chunk");
    const bytes = decodeChunk(input.dataBase64);
    if (t.receivedBytes + bytes.length > t.expectedBytes) return invalid("Transfer exceeds declared byte count");
    await t.handle.writeFile(bytes);
    t.hash.update(bytes);
    t.receivedBytes += bytes.length;
    t.nextIndex += 1;
    t.startedAt = Date.now();
    return { receivedBytes: t.receivedBytes, nextIndex: t.nextIndex };
  }

  async finish(input: {
    projectId: string; root: string; sessionId?: string; transferId: string;
  }): Promise<{ filePath: string; bytes: number; sha256: string; deduped: boolean }> {
    const t = await this.owned(input.projectId, input.root, input.transferId);
    if (t.receivedBytes !== t.expectedBytes) return invalid("Transfer is incomplete");
    const digest = t.hash.digest("hex");
    if (digest !== t.expectedSha256) {
      await this.discard(t);
      return invalid("Transfer SHA-256 mismatch");
    }
    await t.handle.sync();
    await t.handle.close();
    try {
      const abs = await resolveInProject(t.root, t.destRel, { allowSymlink: false, rejectRoot: true });
      await fs.mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
      // Recheck path confinement after directory creation.
      await resolveInProject(t.root, t.destRel, { allowSymlink: false, rejectRoot: true });
      let deduped = false;
      try {
        // Atomic, no-overwrite placement on the same filesystem.
        await fs.link(t.stageFile, abs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        // Never follow an existing symlink when checking deduplication.
        const existing = await fs.lstat(abs);
        if (!existing.isFile() || existing.size !== t.expectedBytes ||
            (await sha256File(abs)) !== digest) {
          return invalid("Destination exists with different content");
        }
        deduped = true;
      }
      return { filePath: t.destRel, bytes: t.receivedBytes, sha256: digest, deduped };
    } finally {
      this.active.delete(t.id);
      await fs.rm(t.stageDir, { recursive: true, force: true });
    }
  }

  async abort(input: {
    projectId: string; root: string; sessionId?: string; transferId: string;
  }): Promise<{ aborted: true }> {
    const t = await this.owned(input.projectId, input.root, input.transferId);
    await this.discard(t);
    return { aborted: true };
  }
}
