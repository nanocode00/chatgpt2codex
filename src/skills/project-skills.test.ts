import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErrorCode } from "../types.js";
import {
  MAX_SKILL_BYTES,
  listProjectSkills,
  parseSkillFrontmatter,
  readProjectSkill,
  writeProjectSkill,
} from "./project-skills.js";

async function put(root: string, rel: string, content: string | Buffer): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

function expectCode(code: ErrorCode) {
  return expect.objectContaining({ code });
}

describe("project-local skills", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-skills-"));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-skills-outside-"));
  });

  afterEach(async () => {
    await Promise.all([
      fs.rm(root, { recursive: true, force: true }),
      fs.rm(outside, { recursive: true, force: true }),
    ]);
  });

  it("discovers only the four allowed roots and does not return bodies from list", async () => {
    const bodyMarker = "DO-NOT-RETURN-THIS-BODY";
    await put(root, ".codex/skills/foo/SKILL.md", `---\nname: foo\ndescription: Codex skill\n---\n${bodyMarker}`);
    await put(root, ".agents/skills/bar/SKILL.md", "---\ndescription: Agents skill\n---\nAgents body");
    await put(root, ".claude/skills/baz/SKILL.md", "---\ndescription: Claude skill\n---\nClaude body");
    await put(root, ".chatgpt2codex/skills/qux/SKILL.md", "---\ndescription: ChatGPT skill\n---\nChatGPT body");
    await put(root, ".hidden/skills/nope/SKILL.md", "hidden body");

    const skills = await listProjectSkills(root);
    expect(skills.map((item) => item.path)).toEqual([
      ".agents/skills/bar/SKILL.md",
      ".chatgpt2codex/skills/qux/SKILL.md",
      ".claude/skills/baz/SKILL.md",
      ".codex/skills/foo/SKILL.md",
    ]);
    expect(skills.map((item) => item.source)).toEqual(["agents", "chatgpt2codex", "claude", "codex"]);
    expect(skills.every((item) => item.scope === "project")).toBe(true);
    expect(skills.find((item) => item.name === "foo")?.description).toBe("Codex skill");
    expect(JSON.stringify(skills)).not.toContain(bodyMarker);
    expect(JSON.stringify(skills)).not.toContain("Agents body");
    expect(JSON.stringify(skills)).not.toContain("hidden body");
  });

  it("reads a skill with metadata, content, and update hash", async () => {
    const content = "---\nname: foo\ndescription: Read me\n---\n# Body\n";
    await put(root, ".codex/skills/foo/SKILL.md", content);
    const skill = await readProjectSkill(root, "foo");
    expect(skill).toMatchObject({
      name: "foo",
      path: ".codex/skills/foo/SKILL.md",
      source: "codex",
      scope: "project",
      description: "Read me",
      content,
      bytes: Buffer.byteLength(content),
    });
    expect(skill.frontmatter).toEqual({ name: "foo", description: "Read me" });
    expect(skill.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("treats malformed frontmatter conservatively without making the body unreadable", async () => {
    const content = "---\nname: broken\ndescription: never closed\n# still content";
    await put(root, ".agents/skills/broken/SKILL.md", content);
    const skill = await readProjectSkill(root, "agents:broken");
    expect(skill.content).toBe(content);
    expect(skill.frontmatter).toEqual({});
    expect(parseSkillFrontmatter(content)).toEqual({});
  });

  it.each(["../evil", "/tmp/evil", "a/b", "a\\b", "..", "", "UPPER", "a..b"])(
    "rejects unsafe or invalid skill identifier %j",
    async (skill) => {
      await expect(readProjectSkill(root, skill)).rejects.toMatchObject(expectCode(ErrorCode.PATH_OUTSIDE_PROJECT));
      await expect(
        writeProjectSkill(root, { skill, source: "codex", content: "# safe" }),
      ).rejects.toMatchObject(expectCode(ErrorCode.PATH_OUTSIDE_PROJECT));
    },
  );

  it("rejects a symlink escape", async () => {
    await put(outside, "SKILL.md", "outside");
    await fs.mkdir(path.join(root, ".codex/skills"), { recursive: true });
    await fs.symlink(outside, path.join(root, ".codex/skills/escape"), "dir");
    await expect(readProjectSkill(root, "codex:escape")).rejects.toMatchObject(expectCode(ErrorCode.PATH_OUTSIDE_PROJECT));
    await expect(
      writeProjectSkill(root, { skill: "codex:escape", content: "replacement" }),
    ).rejects.toMatchObject(expectCode(ErrorCode.PATH_OUTSIDE_PROJECT));
  });

  it("enforces the 256 KiB UTF-8 text limit for reads and writes", async () => {
    const oversized = "x".repeat(MAX_SKILL_BYTES + 1);
    await put(root, ".codex/skills/huge/SKILL.md", oversized);
    await expect(readProjectSkill(root, "codex:huge")).rejects.toMatchObject(expectCode(ErrorCode.FILE_TOO_LARGE));
    await expect(
      writeProjectSkill(root, { skill: "newhuge", source: "codex", content: oversized }),
    ).rejects.toMatchObject(expectCode(ErrorCode.FILE_TOO_LARGE));

    await put(root, ".agents/skills/binary/SKILL.md", Buffer.from([0xff, 0xfe, 0xfd]));
    await expect(readProjectSkill(root, "agents:binary")).rejects.toMatchObject(
      expectCode(ErrorCode.UNSUPPORTED_MEDIA_TYPE),
    );
  });

  it("prevents create-style overwrite of an existing skill", async () => {
    await put(root, ".codex/skills/foo/SKILL.md", "old");
    await expect(
      writeProjectSkill(root, { skill: "codex:foo", content: "new" }),
    ).rejects.toMatchObject(expectCode(ErrorCode.FILE_EXISTS));
    expect(await fs.readFile(path.join(root, ".codex/skills/foo/SKILL.md"), "utf8")).toBe("old");
  });

  it("rejects hash mismatch and updates only with a matching read hash", async () => {
    await put(root, ".claude/skills/foo/SKILL.md", "old");
    const before = await readProjectSkill(root, "claude:foo");
    await expect(
      writeProjectSkill(root, { skill: "claude:foo", content: "new", preconditionHash: "0".repeat(64) }),
    ).rejects.toMatchObject(expectCode(ErrorCode.HASH_MISMATCH));
    expect(await fs.readFile(path.join(root, ".claude/skills/foo/SKILL.md"), "utf8")).toBe("old");

    const updated = await writeProjectSkill(root, {
      skill: "claude:foo",
      content: "new",
      preconditionHash: before.hash,
    });
    expect(updated.created).toBe(false);
    expect(updated.content).toBe("new");
    expect(updated.hash).not.toBe(before.hash);
  });
});
