import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { filterProfiles, parseProfileDetails, parseProfileTest, profileAliasValid, validateDraft, validateProfileSelection } from "../desktop/src/profile-model";

const draft = { pythonPath: String.raw`C:\Users\me\miniconda3\envs\dev\python.exe`, composeFile: "compose.yaml",
  projectName: "local-app", services: "api, db", controlServices: "api" };

describe("Tauri unified execution profiles", () => {
  it("filters by alias without mutating or hiding Python/Docker combinations", () => {
    const profiles = [{ alias: "zeta", python: false, docker: true },
      { alias: "both", python: true, docker: true },
      { alias: "alpha", python: true, docker: false }];
    expect(filterProfiles(profiles, "").map(p => p.alias)).toEqual(["alpha", "both", "zeta"]);
    expect(filterProfiles(profiles, "BOTH")).toEqual([{ alias: "both", python: true, docker: true }]);
    expect(profiles[0]?.alias).toBe("zeta");
  });

  it("accepts only the selected alias and bounded known metadata", () => {
    const raw = {
      alias: "both",
      python: String.raw`C:\dev\python.exe`,
      docker: { composeFile: "compose.yaml", projectName: "local-app",
        services: ["api", "db"], controlServices: ["api"], unknownSecret: "must-be-hidden" },
      internalSecret: "must-be-hidden"
    };
    const parsed = parseProfileDetails(raw, "both");
    expect(parsed).toEqual({
      alias: "both", python: String.raw`C:\dev\python.exe`,
      docker: { composeFile: "compose.yaml", projectName: "local-app", services: ["api", "db"], controlServices: ["api"] }
    });
    expect(JSON.stringify(parsed)).not.toContain("must-be-hidden");
    expect(parseProfileDetails(raw, "other")).toBeNull();
    expect(parseProfileDetails({ ...raw, python: "a".repeat(600) }, "both")).toBeNull();
    expect(parseProfileDetails({ ...raw, docker: { services: ["api"] } }, "both")).toBeNull();
    expect(parseProfileDetails({ ...raw, alias: "../no" }, "../no")).toBeNull();
  });

  it("marks missing Python fields as unknown; Docker valid does not imply a live test", () => {
    const raw = { alias: "dev", python: { configured: true, available: false, version: "3.11.5" },
      docker: { configured: true, valid: true, profile: { secret: "not shown" } } };
    const parsed = parseProfileTest(raw, "dev");
    expect(parsed).toEqual({
      alias: "dev", python: { configured: true, available: false, version: "3.11.5" },
      docker: { configured: true, valid: true }
    });
    expect(JSON.stringify(parsed)).not.toContain("not shown");
    expect(parseProfileTest(raw, "other")).toBeNull();
    expect(parseProfileTest({ ...raw, python: {} }, "dev")).toBeNull();
  });

  it("validates aliases, python.exe paths and bounded Docker fields before invoking Rust", () => {
    expect(profileAliasValid("a.good_alias-2")).toBe(true);
    expect(profileAliasValid("-bad")).toBe(false);
    expect(profileAliasValid("a..b")).toBe(false);
    expect(validateDraft("python", "python-dev", draft)).toBeNull();
    expect(validateDraft("python", "python-dev", { ...draft, pythonPath: "python" })).toBeTruthy();
    expect(validateDraft("python", "python-dev", { ...draft, pythonPath: "C:\\evil.exe" })).toBeTruthy();
    expect(validateDraft("docker", "docker-dev", draft)).toBeNull();
    expect(validateDraft("docker", "docker-dev", { ...draft, composeFile: "../other.yaml" })).toBeTruthy();
    expect(validateDraft("docker", "docker-dev", { ...draft, services: "api;rm" })).toBeTruthy();
    expect(validateDraft("docker", "docker-dev", { ...draft, projectName: "" })).toBeTruthy();
  });


  it("allows either one or both profile kinds, but never neither", () => {
    expect(validateProfileSelection("dev", draft, { python: false, docker: false })).toContain("하나 이상");
    expect(validateProfileSelection("dev", draft, { python: true, docker: false })).toBeNull();
    expect(validateProfileSelection("dev", draft, { python: false, docker: true })).toBeNull();
    expect(validateProfileSelection("dev", draft, { python: true, docker: true })).toBeNull();
    expect(validateProfileSelection("dev", { ...draft, pythonPath: "" }, { python: false, docker: true })).toBeNull();
    expect(validateProfileSelection("dev", { ...draft, projectName: "" }, { python: true, docker: false })).toBeNull();
    expect(validateProfileSelection("dev", { ...draft, pythonPath: "" }, { python: true, docker: true })).toBeTruthy();
    expect(validateProfileSelection("dev", { ...draft, services: "" }, { python: true, docker: true })).toBeTruthy();
    expect(validateProfileSelection("-invalid", draft, { python: false, docker: true })).toBeTruthy();
  });

  it("shows optional Python/Docker sections and calls one combined operation", () => {
    const screen = readFileSync("desktop/src/ProfilesScreen.tsx", "utf8");
    const css = readFileSync("desktop/src/profiles.css", "utf8");
    const runtime = readFileSync("desktop/src/runtime.ts", "utf8");
    expect(screen).toContain('checked={includePython}');
    expect(screen).toContain('checked={includeDocker}');
    expect(screen).toContain('"profile-add-both"');
    expect(screen).toContain('includePython && includeDocker ? "profile-add-both"');
    expect(screen).toContain("validateProfileSelection");
    expect(css).toContain(".profiles-form-kind-grid");
    expect(runtime).toContain('"profile-add-both"');
  });

  it("focuses the configured kind and keeps another kind as a compact add action", () => {
    const code = readFileSync("desktop/src/ProfilesScreen.tsx", "utf8");
    const css = readFileSync("desktop/src/profiles.css", "utf8");
    expect(code).toContain('selected.python && selected.docker && <div className="profiles-detail-switch"');
    expect(code).toContain('selected.python !== selected.docker && <div className="profiles-secondary-kind"');
    expect(code).toContain('visibleKind === "python" ?');
    expect(code).toContain("profiles-docker-fields");
    expect(code).toContain("Docker 데몬 연결이나 컨테이너 실행 여부를 검사하지 않습니다");
    expect(css).toContain(".profiles-kind-focused");
    expect(css).toContain(".profiles-secondary-kind");
  });

  it("keeps the execution environment list to 3 rows and marks Docker checks honestly", () => {
    const css = readFileSync("desktop/src/profiles.css", "utf8");
    const screen = readFileSync("desktop/src/ProfilesScreen.tsx", "utf8");
    expect(css).toContain(".profiles-items{height:202px;min-height:202px;max-height:202px");
    expect(css).toContain("scrollbar-gutter:stable");
    expect(css).toContain("@container profiles");
    expect(screen).toContain("데몬·컨테이너 미검사");
    expect(screen).toContain('"profile-add-python"');
    expect(screen).toContain('"profile-add-docker"');
    expect(screen).toContain('"profile-remove-all"');
    expect(screen).toContain("profile-show");
  });
});
