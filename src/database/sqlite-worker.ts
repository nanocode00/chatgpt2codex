import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

type WorkerInput =
  | { mode: "query"; dbPath: string; sql: string; maxRows: number }
  | { mode: "inspect"; dbPath: string };

const CELL_TEXT_MAX = 4096;
const TOTAL_JSON_MAX = 128 * 1024;
const COLUMN_MAX = 128;

function normalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
  if (value instanceof Uint8Array) return { type: "blob", bytes: value.byteLength };
  if (typeof value === "string" && value.length > CELL_TEXT_MAX) {
    return { type: "text", value: value.slice(0, CELL_TEXT_MAX), truncated: true, originalChars: value.length };
  }
  return value;
}

function boundedRows(rows: Iterable<Record<string, unknown>>, maxRows: number) {
  const out: Array<Record<string, unknown>> = [];
  let truncated = false;
  for (const row of rows) {
    if (out.length >= maxRows) { truncated = true; break; }
    const keys = Object.keys(row);
    if (keys.length > COLUMN_MAX) throw new Error("TOO_MANY_COLUMNS");
    const normalized: Record<string, unknown> = {};
    for (const key of keys) normalized[key] = normalizeValue(row[key]);
    out.push(normalized);
    if (Buffer.byteLength(JSON.stringify(out), "utf8") > TOTAL_JSON_MAX) {
      out.pop(); truncated = true; break;
    }
  }
  return { rows: out, truncated };
}

function openDatabase(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath, {
    readOnly: true,
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
  } as any);
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function run(input: WorkerInput): unknown {
  const db = openDatabase(input.dbPath);
  try {
    if (input.mode === "query") {
      const statement = db.prepare(input.sql);
      statement.setReadBigInts(true);
      const result = boundedRows(statement.iterate() as Iterable<Record<string, unknown>>, input.maxRows);
      return { ...result, maxRows: input.maxRows };
    }

    let objects: Array<{ name: string; type: "table" | "view" }>;
    try {
      objects = db.prepare(
        "SELECT name, type FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name LIMIT 200",
      ).all() as Array<{ name: string; type: "table" | "view" }>;
    } catch {
      throw new Error("SCHEMA_OBJECTS_FAILED");
    }
    const schemaObjects: Array<Record<string, unknown>> = [];
    let truncated = false;
    for (const object of objects) {
      const item = {
        name: object.name,
        kind: object.type,
        columns: (() => {
          let rows: Array<Record<string, unknown>>;
          try {
            rows = db.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(object.name)})`).all() as Array<Record<string, unknown>>;
          } catch {
            throw new Error("SCHEMA_COLUMNS_RUN_FAILED");
          }
          return rows.map((column) => ({
          name: column.name,
          declaredType: column.type,
          nullable: Number(column.notnull ?? 0) === 0,
          primaryKey: Number(column.pk ?? 0) > 0,
          }));
        })(),
      };
      schemaObjects.push(item);
      if (Buffer.byteLength(JSON.stringify(schemaObjects), "utf8") > TOTAL_JSON_MAX) {
        schemaObjects.pop();
        truncated = true;
        break;
      }
    }
    return { objects: schemaObjects, truncated };
  } finally {
    db.close();
  }
}

try {
  parentPort?.postMessage({ ok: true, value: run(workerData as WorkerInput) });
} catch (error) {
  const knownCodes = new Set(["TOO_MANY_COLUMNS", "SCHEMA_OBJECTS_FAILED", "SCHEMA_COLUMNS_RUN_FAILED"]);
  const code = error instanceof Error && knownCodes.has(error.message) ? error.message : "SQLITE_FAILURE";
  parentPort?.postMessage({ ok: false, code });
}
