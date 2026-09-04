import { promises as fs } from "node:fs";
import path from "node:path";
import { createFile } from "../code/patch.js";
import { resolveInProject } from "../policy/paths.js";
import { DomainError, ErrorCode } from "../types.js";
import { rangeHash } from "../util/hash.js";

export const MAX_SKILL_BYTES = 256 * 1024;
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type ProjectSkillSource = "codex" | "agents" | "claude" | "chatgpt2codex";

const SKILL_ROOTS: ReadonlyArray<{ source: ProjectSkillSource; root: string }> = [
  { source: "codex", root: ".codex/skills" },
  { source: "agents", root: ".agents/skills" },
  { source: "claude", root: ".claude/skills" },
  { source: "chatgpt2codex", root: ".chatgpt2codex/skills" },
];

export interface SkillFrontmatter {
  name?: string;
  description?: string;
}

export interface ProjectSkillListItem {
  name: string;
  path: string;
  scope: "project";
  source: ProjectSkillSource;
  description?: string;
  skill: string;
}

export interface ProjectSkillReadResult extends ProjectSkillListItem {
  frontmatter: SkillFrontmatter;
  content: string;
  hash: string;
  bytes: number;
}

type GuardPath = (absPath: string) => Promise<void>;

function invalidSkill(message: string, skill: string): never {
  throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, message, { skill });
}

export function validateSkillName(name: string): string {
  if (!SKILL_NAME_RE.test(name) || name.includes("..") || name.includes("/") || name.includes("\\") || path.isAbsolute(name)) {
    return invalidSkill("Invalid project skill name", name);
  }
  return name;
}

function rootForSource(source: ProjectSkillSource): string {
  const found = SKILL_ROOTS.find((entry) => entry.source === source);
  if (!found) throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "Unsupported project skill source", { source });
  return found.root;
}

function skillPath(source: ProjectSkillSource, name: string): string {
  return path.posix.join(rootForSource(source), name, "SKILL.md");
}

function unquoteScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return {};
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return {};
  const block = normalized.slice(4, end);
  const metadata: SkillFrontmatter = {};
  for (const line of block.split("\n")) {
    if (!line || /^\s/.test(line) || line.trimStart().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = unquoteScalar(line.slice(colon + 1));
    if (!value || value === "|" || value === ">") continue;
    if (key === "name") metadata.name = value;
    if (key === "description") metadata.description = value;
  }
  return metadata;
}

async function readUtf8Skill(absPath: string, relPath: string): Promise<{ content: string; bytes: number }> {
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Project skill not found: ${relPath}`, { path: relPath });
    }
    throw err;
  }
  if (!stat.isFile()) {
    throw new DomainError(ErrorCode.NOT_A_FILE, `Project skill is not a regular file: ${relPath}`, { path: relPath });
  }
  if (stat.size > MAX_SKILL_BYTES) {
    throw new DomainError(ErrorCode.FILE_TOO_LARGE, `SKILL.md exceeds ${MAX_SKILL_BYTES} bytes`, {
      path: relPath,
      bytes: stat.size,
      maxBytes: MAX_SKILL_BYTES,
    });
  }
  const data = await fs.readFile(absPath);
  if (data.byteLength > MAX_SKILL_BYTES) {
    throw new DomainError(ErrorCode.FILE_TOO_LARGE, `SKILL.md exceeds ${MAX_SKILL_BYTES} bytes`, {
      path: relPath,
      bytes: data.byteLength,
      maxBytes: MAX_SKILL_BYTES,
    });
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new DomainError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, "SKILL.md must be valid UTF-8 text", { path: relPath });
  }
  if (content.includes("\0")) {
    throw new DomainError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, "SKILL.md must be text, not binary data", { path: relPath });
  }
  return { content, bytes: data.byteLength };
}

async function inspectSkill(
  projectRoot: string,
  source: ProjectSkillSource,
  name: string,
  guardPath?: GuardPath,
): Promise<ProjectSkillReadResult> {
  validateSkillName(name);
  const relPath = skillPath(source, name);
  const absPath = await resolveInProject(projectRoot, relPath, { allowSymlink: false, rejectRoot: true });
  await guardPath?.(absPath);
  const { content, bytes } = await readUtf8Skill(absPath, relPath);
  const frontmatter = parseSkillFrontmatter(content);
  return {
    name,
    path: relPath,
    scope: "project",
    source,
    description: frontmatter.description,
    skill: `${source}:${name}`,
    frontmatter,
    content,
    hash: rangeHash(content),
    bytes,
  };
}

export async function listProjectSkills(projectRoot: string, guardPath?: GuardPath): Promise<ProjectSkillListItem[]> {
  const items: ProjectSkillListItem[] = [];
  for (const { source, root } of SKILL_ROOTS) {
    const absRoot = await resolveInProject(projectRoot, root, { allowSymlink: false, rejectRoot: true });
    let entries;
    try {
      entries = await fs.readdir(absRoot, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SKILL_NAME_RE.test(entry.name) || entry.name.includes("..")) continue;
      try {
        const skill = await inspectSkill(projectRoot, source, entry.name, guardPath);
        items.push({
          name: skill.name,
          path: skill.path,
          scope: "project",
          source: skill.source,
          description: skill.description,
          skill: skill.skill,
        });
      } catch (err) {
        if (err instanceof DomainError && (err.code === ErrorCode.PROJECT_NOT_FOUND || err.code === ErrorCode.NOT_A_FILE)) continue;
        throw err;
      }
    }
  }
  return items.sort((a, b) => a.path.localeCompare(b.path));
}

function parseSkillIdentifier(skill: string): { source?: ProjectSkillSource; name: string } {
  if (skill.includes("/") || skill.includes("\\") || skill.includes("..") || path.isAbsolute(skill)) {
    return invalidSkill("Invalid project skill identifier", skill);
  }
  const colon = skill.indexOf(":");
  if (colon < 0) return { name: validateSkillName(skill) };
  if (colon !== skill.lastIndexOf(":")) return invalidSkill("Invalid project skill identifier", skill);
  const source = skill.slice(0, colon) as ProjectSkillSource;
  if (!SKILL_ROOTS.some((entry) => entry.source === source)) return invalidSkill("Invalid project skill source", skill);
  const name = validateSkillName(skill.slice(colon + 1));
  return { source, name };
}

export async function readProjectSkill(
  projectRoot: string,
  skillIdentifier: string,
  guardPath?: GuardPath,
): Promise<ProjectSkillReadResult> {
  const parsed = parseSkillIdentifier(skillIdentifier);
  if (parsed.source) return inspectSkill(projectRoot, parsed.source, parsed.name, guardPath);
  const matches = (await listProjectSkills(projectRoot, guardPath)).filter((item) => item.name === parsed.name);
  if (matches.length === 0) {
    throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Project skill not found: ${parsed.name}`, { skill: parsed.name });
  }
  if (matches.length > 1) {
    throw new DomainError(ErrorCode.AMBIGUOUS_PROJECT, `Project skill name is ambiguous; use source:name`, {
      skill: parsed.name,
      matches: matches.map((item) => item.skill),
    });
  }
  return inspectSkill(projectRoot, matches[0]!.source, parsed.name, guardPath);
}

function assertSkillContent(content: string): number {
  if (content.includes("\0")) {
    throw new DomainError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, "SKILL.md must be text, not binary data");
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_SKILL_BYTES) {
    throw new DomainError(ErrorCode.FILE_TOO_LARGE, `SKILL.md exceeds ${MAX_SKILL_BYTES} bytes`, {
      bytes,
      maxBytes: MAX_SKILL_BYTES,
    });
  }
  return bytes;
}

export async function writeProjectSkill(
  projectRoot: string,
  input: {
    skill: string;
    source?: ProjectSkillSource;
    content: string;
    preconditionHash?: string;
  },
  guardPath?: GuardPath,
): Promise<ProjectSkillReadResult & { created: boolean }> {
  assertSkillContent(input.content);
  const parsed = parseSkillIdentifier(input.skill);
  if (parsed.source && input.source && parsed.source !== input.source) {
    throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "Skill source conflicts with qualified skill identifier", {
      skill: input.skill,
      source: input.source,
    });
  }
  let source = parsed.source ?? input.source;
  if (!source && input.preconditionHash) {
    const existing = await readProjectSkill(projectRoot, parsed.name, guardPath);
    source = existing.source;
  }
  if (!source) {
    throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "source is required when creating an unqualified project skill", {
      skill: parsed.name,
    });
  }
  const relPath = skillPath(source, parsed.name);
  const absPath = await resolveInProject(projectRoot, relPath, { allowSymlink: false, rejectRoot: true });
  await guardPath?.(absPath);

  let exists = false;
  try {
    const stat = await fs.lstat(absPath);
    exists = true;
    if (stat.isSymbolicLink()) {
      throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "Project skill path must not be a symlink", { path: relPath });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  if (exists && !input.preconditionHash) {
    throw new DomainError(ErrorCode.FILE_EXISTS, `Project skill already exists: ${relPath}`, { path: relPath });
  }
  if (!exists && input.preconditionHash) {
    throw new DomainError(ErrorCode.HASH_MISMATCH, `Project skill missing for precondition check: ${relPath}`, {
      path: relPath,
      expected: input.preconditionHash,
    });
  }

  await createFile(projectRoot, relPath, input.content, exists, exists ? input.preconditionHash : undefined);
  const result = await inspectSkill(projectRoot, source, parsed.name, guardPath);
  return { ...result, created: !exists };
}

export const PROJECT_SKILL_SOURCES = SKILL_ROOTS.map((entry) => entry.source) as readonly ProjectSkillSource[];
