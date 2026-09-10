import { describe, expect, it } from "vitest";
import { parsePostgresProfiles, POSTGRES_PROFILES_ENV } from "./postgres-profiles.js";

function env(value: unknown): NodeJS.ProcessEnv {
  return { [POSTGRES_PROFILES_ENV]: JSON.stringify(value) };
}

describe("PostgreSQL profiles", () => {
  it("parses project binding, env indirection, and defaults schemas to public", () => {
    const parsed = parsePostgresProfiles(env({ app: { projectRoot: "/srv/app", connectionStringEnv: "APP_POSTGRES_READONLY_URL" } }));
    expect(parsed.aliases).toEqual(["app"]);
    expect(parsed.profiles.get("app")).toEqual({ projectRoot: "/srv/app", connectionStringEnv: "APP_POSTGRES_READONLY_URL", schemas: ["public"] });
  });

  it("accepts explicit user schemas without connection credentials in the profile", () => {
    const parsed = parsePostgresProfiles(env({ app: { projectRoot: "/srv/app", connectionStringEnv: "APP_DB_URL", schemas: ["public", "reporting"] } }));
    expect(parsed.profiles.get("app")?.schemas).toEqual(["public", "reporting"]);
  });

  it.each([
    { projectRoot: "relative", connectionStringEnv: "APP_DB_URL" },
    { projectRoot: "/srv/app", connectionStringEnv: "lowercase" },
    { projectRoot: "/srv/app", connectionStringEnv: "APP_DB_URL", schemas: ["pg_catalog"] },
    { projectRoot: "/srv/app", connectionStringEnv: "APP_DB_URL", schemas: ["information_schema"] },
    { projectRoot: "/srv/app", connectionStringEnv: "APP_DB_URL", dsn: "postgres://secret" },
  ])("rejects unsafe profile values %#", (profile) => {
    expect(() => parsePostgresProfiles(env({ app: profile }))).toThrow(/PostgreSQL profile config invalid/);
  });
});
