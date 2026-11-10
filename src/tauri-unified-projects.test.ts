import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { displayProjectPath, filterProjects, parseProjectDetails } from "../desktop/src/project-details";

describe("Tauri unified projects screen", () => {
  it("keeps exactly three project rows visible and scrolls additional items", () => {
    const css = readFileSync("desktop/src/projects.css", "utf8");
    const screen = readFileSync("desktop/src/ProjectsScreen.tsx", "utf8");
    expect(css).toContain(".projects-entries{display:flex;flex-direction:column;gap:5px;height:202px;min-height:202px;max-height:202px");
    expect(css).toContain(".projects-entry{width:100%;min-width:0;min-height:64px;max-height:64px;flex:0 0 64px");
    expect(css).toContain("overflow-y:auto");
    expect(css).toContain("scrollbar-gutter:stable");
    expect(css).toContain(".projects-layout{display:grid;");
    expect(css).toContain("align-items:start;");
    expect(css).not.toContain(".projects-entries{max-height:375px}");
    expect(screen).toContain('role="region" aria-label="프로젝트 목록 스크롤 영역" tabIndex={0}');
  });

  it("uses the neutral global scrollbar across page and nested scroll panes", () => {
    const css = readFileSync("desktop/src/styles.css", "utf8");
    expect(css).toContain("*::-webkit-scrollbar-thumb");
    expect(css).toContain("*::-webkit-scrollbar-track");
    expect(css).toContain("*::-webkit-scrollbar-thumb:hover");
    expect(css).toContain("scrollbar-width:thin");
    expect(css).toContain("scrollbar-color:#626262 #222");
    expect(css).toContain("@media(forced-colors:active)");
  });

  it("removes only the Windows extended-length drive prefix for display and copy", () => {
    const path = "\\\\?\\C:\\Users\\nanocode\\fastdesk";
    expect(displayProjectPath(path)).toBe("C:\\Users\\nanocode\\fastdesk");
    expect(path).toBe("\\\\?\\C:\\Users\\nanocode\\fastdesk");
    expect(displayProjectPath("D:\\code\\repo")).toBe("D:\\code\\repo");
  });
  it("converts extended UNC presentation while retaining unsupported device namespaces", () => {
    expect(displayProjectPath("\\\\?\\UNC\\server\\share\\repo")).toBe("\\\\server\\share\\repo");
    expect(displayProjectPath("\\\\?\\Volume{1234-ABCD}\\repo")).toBe("\\\\?\\Volume{1234-ABCD}\\repo");
    expect(displayProjectPath("\\\\.\\PhysicalDrive0")).toBe("\\\\.\\PhysicalDrive0");
    expect(displayProjectPath("/home/user/repo")).toBe("/home/user/repo");
  });
  it("searches case-insensitively and preserves alphabetical ordering without mutating input", () => {
    const projects = [
      { id: "zeta", name: "Zeta", available: false },
      { id: "proj-a", name: "Alpha", available: true },
      { id: "p2", name: "Beta", available: true }
    ];
    expect(filterProjects(projects, "").map(p => p.id)).toEqual(["proj-a", "p2", "zeta"]);
    expect(filterProjects(projects, "PROJ").map(p => p.id)).toEqual(["proj-a"]);
    expect(filterProjects(projects, " beta ").map(p => p.id)).toEqual(["p2"]);
    expect(projects[0]?.id).toBe("zeta");
  });
  it("displays only bounded repository detail fields verified against the selected ID", () => {
    const obj = {
      id: "project-a", name: "Project A", root: "C:\\code\\project-a",
      project: {
        projectId: "project-a", root: "C:\\code\\project-a",
        branch: "main", dirty: true, hasAgentsMd: true, hasCodeBrain: false,
        packageHints: ["node", "python"], internalSecrets: "never show"
      },
      token: "never show"
    };
    const output = parseProjectDetails(obj, "project-a");
    expect(output).toEqual({
      id: "project-a", name: "Project A", root: "C:\\code\\project-a",
      branch: "main", dirty: true, hasAgentsMd: true, hasCodeBrain: false, packageHints: ["node", "python"]
    });
    expect(JSON.stringify(output)).not.toContain("never show");
    expect(parseProjectDetails(obj, "other")).toBeNull();
    expect(parseProjectDetails({ ...obj, project: { ...obj.project, root: "C:\\other" } }, "project-a")).toBeNull();
    expect(parseProjectDetails({ ...obj, root: "x".repeat(4097) }, "project-a")).toBeNull();
    expect(parseProjectDetails({ ...obj, project: null }, "project-a")).toBeNull();
    expect(parseProjectDetails({ ...obj, id: "../bad" }, "../bad")).toBeNull();
  });
  it("treats missing metadata as unknown, not as a confirmed clean state", () => {
    const obj = { id: "demo", name: "Demo", root: "C:\\demo", project: { projectId: "demo", root: "C:\\demo" } };
    expect(parseProjectDetails(obj, "demo")).toMatchObject({ dirty: null, branch: null, hasAgentsMd: null, packageHints: [] });
  });
});
