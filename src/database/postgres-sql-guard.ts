import { DomainError, ErrorCode } from "../types.js";

const MAX_SQL = 65_536;
const BANNED = new Set([
  "insert", "update", "delete", "merge", "create", "alter", "drop", "truncate",
  "grant", "revoke", "comment", "copy", "call", "do", "execute", "prepare",
  "begin", "commit", "rollback", "savepoint", "release", "set", "reset", "discard",
  "vacuum", "analyze", "reindex", "cluster", "refresh", "listen", "unlisten", "notify", "lock",
]);
const RISKY_FUNCTIONS = new Set([
  "nextval", "setval", "set_config", "pg_notify", "pg_cancel_backend", "pg_terminate_backend", "pg_reload_conf",
  "pg_rotate_logfile", "pg_read_file", "pg_write_file", "pg_ls_dir", "lo_import", "lo_export",
]);

function isRiskyFunction(name: string): boolean {
  return RISKY_FUNCTIONS.has(name) || name.startsWith("pg_advisory_") || name.startsWith("pg_try_advisory_");
}

function reject(): never {
  throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "PostgreSQL query is not allowed by the read-only SQL policy");
}

function tokenize(sql: string): { tokens: string[]; normalized: string } {
  if (typeof sql !== "string" || sql.length === 0 || sql.length > MAX_SQL || sql.includes("\0")) reject();
  const tokens: string[] = [];
  let normalized = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if ((ch === "u" || ch === "U") && next === "&" && (sql[i + 2] === "'" || sql[i + 2] === '"')) reject();
    if (/\s/.test(ch)) { normalized += " "; i++; continue; }
    if (ch === "-" && next === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
      normalized += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      let depth = 1;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; continue; }
        if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; continue; }
        i++;
      }
      if (depth !== 0) reject();
      normalized += " ";
      continue;
    }
    if ((ch === "e" || ch === "E") && next === "'") {
      i += 2;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === "\\") { i += 2; continue; }
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; closed = true; break; }
        i++;
      }
      if (!closed) reject();
      normalized += " '' ";
      continue;
    }
    if (ch === "'") {
      i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; closed = true; break; }
        i++;
      }
      if (!closed) reject();
      normalized += " '' ";
      continue;
    }
    if (ch === '"') {
      i++;
      let closed = false;
      let identifier = "";
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') { identifier += '"'; i += 2; continue; }
        if (sql[i] === '"') { i++; closed = true; break; }
        identifier += sql[i];
        i++;
      }
      if (!closed) reject();
      const lowerIdentifier = identifier.toLowerCase();
      if (isRiskyFunction(lowerIdentifier)) reject();
      normalized += " \"identifier\" ";
      continue;
    }
    if (ch === "$" ) {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        const tag = match[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end < 0) reject();
        i = end + tag.length;
        normalized += " '' ";
        continue;
      }
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i++;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i]!)) i++;
      const token = sql.slice(start, i).toLowerCase();
      tokens.push(token);
      normalized += ` ${token} `;
      continue;
    }
    if (ch === ";") { tokens.push(";"); normalized += ";"; i++; continue; }
    if (ch === "(" || ch === ")") { tokens.push(ch); normalized += ch; i++; continue; }
    normalized += ch;
    i++;
  }
  return { tokens, normalized };
}

export function assertSafePostgresReadOnlySql(sql: string): string {
  const { tokens } = tokenize(sql);
  if (tokens.length === 0) reject();
  const semicolons = tokens.reduce((count, token) => count + (token === ";" ? 1 : 0), 0);
  if (semicolons > 1 || (semicolons === 1 && tokens[tokens.length - 1] !== ";")) reject();
  const effective = semicolons === 1 ? tokens.slice(0, -1) : tokens;
  if (!["select", "with", "values"].includes(effective[0] ?? "")) reject();
  if (effective[0] === "with") {
    let depth = 0;
    let main: string | undefined;
    for (let i = 1; i < effective.length; i++) {
      const token = effective[i]!;
      if (token === "(") { depth++; continue; }
      if (token === ")") { depth--; if (depth < 0) reject(); continue; }
      if (depth === 0 && ["select", "values", "insert", "update", "delete", "merge"].includes(token)) { main = token; break; }
    }
    if (depth < 0 || main !== "select") reject();
  }
  for (let i = 0; i < effective.length; i++) {
    const token = effective[i]!;
    if (BANNED.has(token)) reject();
    if (token === "into") reject();
    if (token === "for" && ["update", "share", "no", "key"].includes(effective[i + 1] ?? "")) reject();
    if (token === "uescape") reject();
    if (isRiskyFunction(token)) reject();
  }
  return sql.replace(/;\s*$/, "");
}
