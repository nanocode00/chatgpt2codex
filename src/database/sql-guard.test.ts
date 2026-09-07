import { describe, expect, it } from "vitest";
import { assertSafeReadOnlySql } from "./sql-guard.js";

describe("SQLite read-only SQL guard", () => {
  it.each([
    "SELECT 1",
    "SELECT 'DELETE FROM x' AS text",
    "SELECT \"DELETE\" FROM users",
    "SELECT [ATTACH] FROM users",
    "-- DELETE FROM x\nSELECT 1",
    "/* ATTACH x */ SELECT 1;",
    "WITH x AS (SELECT 1 AS n) SELECT n FROM x",
    "VALUES (1), (2)",
    "EXPLAIN SELECT * FROM users",
    "EXPLAIN QUERY PLAN SELECT * FROM users",
  ])("allows safe read query: %s", (sql) => {
    expect(assertSafeReadOnlySql(sql)).toBe(sql);
  });

  it.each([
    "INSERT INTO x VALUES (1)",
    "UPDATE x SET a = 1",
    "DELETE FROM x",
    "REPLACE INTO x VALUES (1)",
    "CREATE TABLE x(a)",
    "DROP TABLE x",
    "ALTER TABLE x ADD COLUMN b",
    "ATTACH DATABASE 'other.db' AS other",
    "DETACH DATABASE other",
    "PRAGMA schema_version",
    "SELECT * FROM pragma_database_list",
    "SELECT * FROM pragma_table_info('users')",
    "SELECT * FROM \"pragma_database_list\"",
    "VACUUM",
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
    "SAVEPOINT x",
    "RELEASE x",
    "SELECT load_extension('x')",
    "WITH x AS (SELECT 1) DELETE FROM users",
    "WITH x AS (SELECT 1) UPDATE users SET id=2",
    "EXPLAIN DELETE FROM users",
    "SELECT 1; SELECT 2",
    "SELECT 1;;",
    "/* unterminated",
    "SELECT 'unterminated",
    "BOGUS SELECT 1",
  ])("rejects unsafe or malformed query: %s", (sql) => {
    expect(() => assertSafeReadOnlySql(sql)).toThrow();
  });

  it("enforces the SQL length bound", () => {
    expect(() => assertSafeReadOnlySql("SELECT '" + "x".repeat(65536) + "'")).toThrow();
  });
});
