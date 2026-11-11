import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { filterProfiles, filterProfilesForKind, filterProfileEntries, filterAfterProfileAdd, parseProfileDetails, parseProfileTest, profileAliasValid, validateDraft } from "../desktop/src/profile-model";

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

  it("filters All/Python/Docker by (kind, alias), not by shared alias alone", () => {
    const profiles = [
      { alias: "same", python: true, docker: true },
      { alias: "python-only", python: true, docker: false },
      { alias: "docker-only", python: false, docker: true }
    ];
    expect(filterProfileEntries(profiles, "all", "")).toEqual([
      { alias: "docker-only", kind: "docker" },
      { alias: "python-only", kind: "python" },
      { alias: "same", kind: "python" },
      { alias: "same", kind: "docker" }
    ]);
    expect(filterProfileEntries(profiles, "python", "").map(p => p.alias))
      .toEqual(["python-only", "same"]);
    expect(filterProfileEntries(profiles, "docker", "").map(p => p.alias))
      .toEqual(["docker-only", "same"]);
    expect(filterProfileEntries(profiles, "all", "SAME")).toEqual([
      { alias: "same", kind: "python" },
      { alias: "same", kind: "docker" }
    ]);
    expect(profiles.length).toBe(3);
  });

  it("uses the summary cards as active filters without a redundant upper tab bar", () => {
    const screen = readFileSync("desktop/src/ProfilesScreen.tsx", "utf8");
    const css = readFileSync("desktop/src/profiles.css", "utf8");
    expect(screen).toContain('aria-label="프로필 목록 필터"');
    for (const filter of ["all", "python", "docker"]) {
      expect(screen).toContain('aria-pressed={filter === "' + filter + '"}');
      expect(screen).toContain('onClick={() => switchFilter("' + filter + '")}');
    }
    expect(screen).toContain('filterProfileEntries(profiles, filter, query)');
    expect(screen).toContain('key={profile.kind + ":" + profile.alias}');
    expect(screen).toContain('selected?.kind === profile.kind && selected?.alias === profile.alias');
    expect(screen).not.toContain('profiles-kind-nav');
    expect(screen).not.toContain('role="tablist"');
    expect(css).toContain('.profiles-stats>button.active');
    expect(css).toContain('.profiles-stats>button:focus-visible');
    expect(css).not.toContain('.profiles-kind-nav');
  });

  it("keeps All selected when either add button opens or saves, switching only specific filters", () => {
    expect(filterAfterProfileAdd("all", "python")).toBe("all");
    expect(filterAfterProfileAdd("all", "docker")).toBe("all");
    expect(filterAfterProfileAdd("python", "docker")).toBe("docker");
    expect(filterAfterProfileAdd("docker", "python")).toBe("python");
    expect(filterAfterProfileAdd("python", "python")).toBe("python");
    expect(filterAfterProfileAdd("docker", "docker")).toBe("docker");
  });

  it("keeps Python and Docker add buttons visible and switches filter when registering", () => {
    const screen = readFileSync("desktop/src/ProfilesScreen.tsx", "utf8");
    expect(screen).toContain('onClick={() => beginEditor("python")}');
    expect(screen).toContain('onClick={() => beginEditor("docker")}');
    expect(screen).toMatch(/className="profiles-button primary"[\s\S]*?beginEditor\("python"\)/);
    expect(screen).toMatch(/className="profiles-button primary"[\s\S]*?beginEditor\("docker"\)/);
    expect(screen).toContain('setFilter(filterAfterProfileAdd(filter, kind))');
    expect(screen).toContain('setFilter(filterAfterProfileAdd(filter, editorKind))');
    expect(screen).toContain('setEditorKind(kind)');
    expect(screen).toContain('const operation: OwnedCliParityOperation = editorKind === "python" ?');
    expect(screen).toContain('selectedKind === "python" ? "실행 파일 검사" : "설정 확인"');
    expect(screen).toContain('selected.kind === "python" ?');
    expect(screen).toContain('readOnly={editingExisting}');
  });

  it("keeps independent CLI mutations and no bulk removal or combined registration", () => {
    const screen = readFileSync("desktop/src/ProfilesScreen.tsx", "utf8");
    const runtime = readFileSync("desktop/src/runtime.ts", "utf8");
    const rust = readFileSync("desktop/src-tauri/src/cli_parity.rs", "utf8");
    expect(screen).toContain('operation: kind === "python" ? "profile-remove-python" : "profile-remove-docker"');
    expect(screen).toContain('"profile-add-python" : "profile-add-docker"');
    expect(screen).not.toContain('"profile-add-both"');
    expect(screen).not.toContain('"profile-remove-all"');
    expect(screen).not.toContain('별칭 전체 제거');
    expect(runtime).not.toContain('"profile-add-both"');
    expect(rust).not.toContain('"profile-add-both" =>');
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
