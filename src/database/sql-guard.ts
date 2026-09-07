import { DomainError, ErrorCode } from "../types.js";

const BLOCKED = new Set([
  "ATTACH", "DETACH", "PRAGMA", "VACUUM", "INSERT", "UPDATE", "DELETE", "REPLACE",
  "CREATE", "DROP", "ALTER", "REINDEX", "ANALYZE", "BEGIN", "COMMIT", "ROLLBACK",
  "SAVEPOINT", "RELEASE", "LOAD_EXTENSION",
]);

interface Token { kind: "word" | "quotedIdentifier" | "symbol"; value: string; }

function invalid(message: string): never {
  throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, message);
}

export function tokenizeSql(sql: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < sql.length;) {
    const ch = sql[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "-" && sql[i + 1] === "-") {
      i += 2; while (i < sql.length && sql[i] !== "\n") i++; continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2); if (end < 0) invalid("SQL contains an unterminated comment");
      i = end + 2; continue;
    }
    if (ch === "'") {
      const quote = ch; i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      if (i > sql.length || sql[i - 1] !== quote) invalid("SQL contains an unterminated quoted value");
      continue;
    }
    if (ch === '"' || ch === "`" || ch === "[") {
      const start = i + 1;
      const close = ch === "[" ? "]" : ch;
      i++;
      let value = "";
      while (i < sql.length) {
        if (sql[i] === close) {
          if (close !== "]" && sql[i + 1] === close) { value += close; i += 2; continue; }
          break;
        }
        value += sql[i]!;
        i++;
      }
      if (i >= sql.length || sql[i] !== close) invalid("SQL contains an unterminated quoted identifier");
      i++;
      tokens.push({ kind: "quotedIdentifier", value: value.toUpperCase() });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i++; while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i]!)) i++;
      tokens.push({ kind: "word", value: sql.slice(start, i).toUpperCase() }); continue;
    }
    tokens.push({ kind: "symbol", value: ch }); i++;
  }
  return tokens;
}

export function assertSafeReadOnlySql(sql: string): string {
  if (sql.length === 0 || sql.length > 65536) invalid("SQL must be between 1 and 65536 characters");
  const tokens = tokenizeSql(sql);
  if (tokens.length === 0) invalid("SQL statement is required");
  let semicolons = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "symbol" && token.value === ";") {
      semicolons++;
      if (i !== tokens.length - 1) invalid("Exactly one SQL statement is allowed");
    }
    if (token.kind === "word" && (BLOCKED.has(token.value) || token.value.startsWith("PRAGMA_"))) {
      invalid("SQL operation is not allowed in read-only database mode");
    }
    if (token.kind === "quotedIdentifier" && (token.value === "LOAD_EXTENSION" || token.value.startsWith("PRAGMA_"))) {
      invalid("SQL operation is not allowed in read-only database mode");
    }
  }
  if (semicolons > 1) invalid("Exactly one SQL statement is allowed");

  const words = tokens.filter((t) => t.kind === "word").map((t) => t.value);
  const first = words[0];
  if (first === "SELECT" || first === "VALUES") return sql;
  if (first === "WITH") {
    if (!words.includes("SELECT")) invalid("WITH queries must resolve to SELECT");
    return sql;
  }
  if (first === "EXPLAIN") {
    const idx = words[1] === "QUERY" && words[2] === "PLAN" ? 3 : 1;
    if (words[idx] !== "SELECT") invalid("Only EXPLAIN SELECT is allowed");
    return sql;
  }
  invalid("Only SELECT, WITH ... SELECT, VALUES, and EXPLAIN SELECT queries are allowed");
}
