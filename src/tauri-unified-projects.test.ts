import { describe, expect, it } from "vitest";
import { filterProjects, parseProjectDetails } from "../desktop/src/project-details";

describe("Tauri unified projects screen", () => {
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
