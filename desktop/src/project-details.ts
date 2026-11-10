import type { CatalogRepository } from "./runtime";

export interface ProjectDetails {
  id: string;
  name: string;
  root: string;
  branch: string | null;
  dirty: boolean | null;
  hasAgentsMd: boolean | null;
  hasCodeBrain: boolean | null;
  packageHints: string[];
}

/**
 * Windows fs.realpath/canonicalize may produce Win32 device namespace paths
 * such as \\?\C:\repo or \\?\UNC\server\share\repo.
 * Only normalize the *presentation* (and user-facing clipboard copy).
 * Never use the display value for CLI arguments, ownership checks, or identity.
 */
export function displayProjectPath(raw: string): string {
  const extendedPrefix = "\\\\?\\";
  if (!raw.startsWith(extendedPrefix)) return raw;

  const remainder = raw.slice(extendedPrefix.length);
  if (/^[A-Za-z]:\\/.test(remainder)) return remainder;
  if (/^UNC\\[^\\]+\\[^\\]+(?:\\|$)/i.test(remainder)) {
    return "\\\\" + remainder.slice(4);
  }
  // Preserve non-drive device paths (Volume GUIDs, etc.) verbatim.
  return raw;
}

export function filterProjects(items: CatalogRepository[], query: string): CatalogRepository[] {
  const needle = query.trim().toLocaleLowerCase();
  return [...items].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .filter(item => !needle || item.name.toLocaleLowerCase().includes(needle) || item.id.toLocaleLowerCase().includes(needle));
}

const validText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

/** The canonical CLI can return arbitrary metadata; show only a fixed, bounded subset. */
export function parseProjectDetails(value: unknown, expectedId: string): ProjectDetails | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.id !== expectedId || !validText(record.id, 64)
      || !validText(record.name, 160) || !validText(record.root, 4096)) return null;
  if (typeof record.project !== "object" || !record.project || Array.isArray(record.project)) return null;
  const project = record.project as Record<string, unknown>;
  if (project.projectId !== expectedId || project.root !== record.root) return null;
  const branch = typeof project.branch === "string" && validText(project.branch, 200) ? project.branch : null;
  const dirty = typeof project.dirty === "boolean" ? project.dirty : null;
  const hasAgentsMd = typeof project.hasAgentsMd === "boolean" ? project.hasAgentsMd : null;
  const hasCodeBrain = typeof project.hasCodeBrain === "boolean" ? project.hasCodeBrain : null;
  const packageHints = Array.isArray(project.packageHints) ?
    project.packageHints.filter((v): v is string => validText(v, 80)).slice(0, 12) : [];
  return {
    id: record.id as string, name: record.name as string, root: record.root as string,
    branch, dirty, hasAgentsMd, hasCodeBrain, packageHints
  };
}
