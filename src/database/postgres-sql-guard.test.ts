import { describe, expect, it } from "vitest";
import { assertSafePostgresReadOnlySql } from "./postgres-sql-guard.js";

describe("PostgreSQL read-only SQL guard", () => {
  it.each([
    "SELECT 1",
    "WITH x AS (SELECT 1) SELECT * FROM x",
    "VALUES (1), (2)",
    "/* outer /* nested */ comment */ SELECT 'update' AS text",
    "SELECT E'it\\'s safe'",
    "SELECT \"update\" FROM t",
    "SELECT $$ DELETE FROM x $$",
    "SELECT $tag$ UPDATE x SET y=1 $tag$",
    "SELECT 1;",
  ])("allows read-only statement: %s", (sql) => {
    expect(() => assertSafePostgresReadOnlySql(sql)).not.toThrow();
  });

  it.each([
    "INSERT INTO t VALUES (1)", "UPDATE t SET x=1", "DELETE FROM t", "MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE",
    "CREATE TABLE t(x int)", "ALTER TABLE t ADD x int", "DROP TABLE t", "TRUNCATE t", "GRANT SELECT ON t TO x",
    "COPY t TO STDOUT", "CALL f()", "DO $$ BEGIN END $$", "PREPARE x AS SELECT 1", "BEGIN", "SET work_mem='1MB'",
    "VACUUM", "ANALYZE t", "REFRESH MATERIALIZED VIEW v", "LISTEN x", "NOTIFY x", "LOCK TABLE t",
    "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x",
    "SELECT INTO new_table * FROM t",
    "SELECT id INTO new_table FROM t",
    "SELECT * FROM t FOR UPDATE", "SELECT * FROM t FOR SHARE", "SELECT * FROM t FOR NO KEY UPDATE", "SELECT * FROM t FOR KEY SHARE",
    "SELECT nextval('s')", "SELECT setval('s', 1)", "SELECT pg_notify('x','y')", "SELECT pg_advisory_lock(1)",
    "SELECT set_config('work_mem','64MB',true)", "SELECT set_config('role','admin',true)", "SELECT pg_catalog.set_config('role','admin',true)", "SELECT \"set_config\"('role','admin',true)",
    "SELECT pg_try_advisory_lock_shared(1)", "SELECT pg_advisory_xact_lock(1)", "SELECT pg_advisory_xact_lock_shared(1)", "SELECT pg_try_advisory_xact_lock(1)", "SELECT pg_try_advisory_xact_lock_shared(1)", "SELECT pg_advisory_unlock(1)",
    "SELECT pg_cancel_backend(1)", "SELECT pg_terminate_backend(1)", "SELECT pg_read_file('/x')",
    "SELECT \"pg_read_file\"('/x')",
    "SELECT U&\"set_config\"('role','admin',true)", "SELECT U&'pg_notify'", "SELECT U&\"pg_notify\" UESCAPE '!'",
    "SELECT 1; SELECT 2", "SELECT 1;;", "SELECT 'unterminated",
    "SELECT E'unterminated",
    "WITH x AS (SELECT 1) VALUES (1)",
  ])("rejects unsafe statement: %s", (sql) => {
    expect(() => assertSafePostgresReadOnlySql(sql)).toThrow(/read-only SQL policy/);
  });
});
