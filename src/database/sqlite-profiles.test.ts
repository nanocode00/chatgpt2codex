import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSQLiteProfiles, SQLITE_PROFILES_ENV } from "./sqlite-profiles.js";

function env(value?: string): NodeJS.ProcessEnv {
  return value === undefined ? {} : { [SQLITE_PROFILES_ENV]: value };
}

describe("SQLite operator profiles", () => {
  it("returns empty profiles when unset or blank", () => {
    expect(parseSQLiteProfiles(env())).toEqual({ aliases: [], profiles: new Map() });
    expect(parseSQLiteProfiles(env("  \n"))).toEqual({ aliases: [], profiles: new Map() });
  });

  it("accepts structured relative path descriptors and sorts aliases", () => {
    const parsed = parseSQLiteProfiles(env(JSON.stringify({ course: { path: "data/course.db" }, app: { path: "var/app.sqlite" } })));
    expect(parsed.aliases).toEqual(["app", "course"]);
    expect(parsed.profiles.get("course")).toEqual({ path: "data/course.db" });
  });

  it("rejects absolute, traversal, null-byte, malformed, and extra-field profiles", () => {
    const absolute = path.resolve("/tmp/sqlite-profile.db");
    for (const raw of [
      JSON.stringify({ bad: { path: absolute } }),
      JSON.stringify({ bad: { path: "../../other.db" } }),
      JSON.stringify({ bad: { path: "data/../other.db" } }),
      JSON.stringify({ bad: { path: "data/\0bad.db" } }),
      JSON.stringify({ bad: "data/app.db" }),
      JSON.stringify({ bad: { path: "data/app.db", mode: "rw" } }),
      "not-json",
    ]) {
      expect(() => parseSQLiteProfiles(env(raw))).toThrow(/SQLite profile config invalid/);
    }
  });

  it("does not leak raw configured paths from validation failures", () => {
    const secretPath = "/very/private/super-secret/database.sqlite";
    let message = "";
    try {
      parseSQLiteProfiles(env(JSON.stringify({ prod: { path: secretPath } })));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("SQLite profile config invalid");
    expect(message).not.toContain(secretPath);
    expect(message).not.toContain("super-secret");
  });
});
