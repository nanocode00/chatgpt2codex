import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { filterProfiles, filterProfilesForKind, parseProfileDetails, parseProfileTest, profileAliasValid, validateDraft } from "../desktop/src/profile-model";

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
    expect(profileAliasValid("auto")).toBe(false);
    expect(profileAliasValid("Dev")).toBe(true);
    expect(validateDraft("python", "python-dev", draft)).toBeNull();
    expect(validateDraft("python", "python-dev", { ...draft, pythonPath: "python" })).toBeTruthy();
    expect(validateDraft("python", "python-dev", { ...draft, pythonPath: "C:\\evil.exe" })).toBeTruthy();
    expect(validateDraft("docker", "docker-dev", draft)).toBeNull();
    expect(validateDraft("docker", "docker-dev", { ...draft, composeFile: "../other.yaml" })).toBeTruthy();
    expect(validateDraft("docker", "docker-dev", { ...draft, services: "api;rm" })).toBeTruthy();
    expect(validateDraft("docker", "docker-dev", { ...draft, projectName: "" })).toBeTruthy();
  });



  it("treats identical aliases in Python and Docker as two independent profiles", () => {
    const profiles = [
      { alias: "shared", python: true, docker: true },
      { alias: "python-only", python: true, docker: false },
      { alias: "docker-only", python: false, docker: true }
    ];
    expect(filterProfilesForKind(profiles, "python", "").map(p => p.alias))
      .toEqual(["python-only", "shared"]);
    expect(filterProfilesForKind(profiles, "docker", "").map(p => p.alias))
      .toEqual(["docker-only", "shared"]);
    expect(filterProfilesForKind(profiles, "python", "shared").length).toBe(1);
    expect(filterProfilesForKind(profiles, "docker", "shared").length).toBe(1);
    expect(profiles[0]).toEqual({ alias: "shared", python: true, docker: true });
  });

  it("separates type-specific UI operations without bulk removal or combined registration", () => {
    const screen = readFileSync("desktop/src/ProfilesScreen.tsx", "utf8");
    const css = readFileSync("desktop/src/profiles.css", "utf8");
    const runtime = readFileSync("desktop/src/runtime.ts", "utf8");
    const rust = readFileSync("desktop/src-tauri/src/cli_parity.rs", "utf8");
    expect(screen).toContain('role="tablist" aria-label="실행 환경 종류"');
    expect(screen).toContain('profile[activeKind]');
    expect(screen).toContain('filterProfilesForKind(profiles, activeKind, query)');
    expect(screen).toContain('key={activeKind + ":" + profile.alias}');
    expect(screen).toContain('operation: kind === "python" ? "profile-remove-python" : "profile-remove-docker"');
    expect(screen).toContain('activeKind === "python" ?');
    expect(screen).toContain('"profile-add-python" : "profile-add-docker"');
    expect(screen).not.toContain('"profile-add-both"');
    expect(screen).not.toContain('"profile-remove-all"');
    expect(screen).not.toContain('별칭 전체 제거');
    expect(screen).not.toContain('같은 별칭에 추가');
    expect(runtime).not.toContain('"profile-add-both"');
    expect(rust).not.toContain('"profile-add-both" =>');
    expect(css).toContain(".profiles-kind-nav");
    expect(css).toContain("#profiles-kind-content");
    expect(css).not.toContain(".profiles-form-kind-grid");
  });

  it("keeps the inspector scoped to selected type and describes Docker checks correctly", () => {
    const screen = readFileSync("desktop/src/ProfilesScreen.tsx", "utf8");
    expect(screen).toContain('activeKind === "python" ? "실행 파일 검사" : "설정 확인"');
    expect(screen).toContain("데몬·컨테이너 미검사");
    expect(screen).toContain("다른 종류의 동일 별칭 프로필과 실제 설치·파일은 유지됩니다.");
    expect(screen).toContain("profile-show");
    expect(screen).toContain("profile-test");
    expect(screen).toContain("readOnly={editingExisting}");
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
    expect(screen).not.toContain('"profile-remove-all"');
    expect(screen).toContain("profile-show");
  });
});
