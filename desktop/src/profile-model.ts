import type { CatalogProfile } from "./runtime";

export interface ProfileDetails {
  alias: string;
  python: string | null;
  docker: {
    composeFile: string;
    projectName: string;
    services: string[];
    controlServices: string[];
  } | null;
}

export interface ProfileTestResult {
  alias: string;
  python: { configured: boolean; available: boolean | null; version: string | null } | null;
  docker: { configured: boolean; valid: boolean | null } | null;
}

const MAX_TEXT = 512;
function text(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    !/[\x00-\x1f\x7f]/.test(value);
}
function aliasOk(value: unknown): value is string {
  return text(value, 64) && /^[A-Za-z0-9._-]+$/.test(value) &&
    !value.startsWith("-") && !value.includes("..");
}
function names(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 64 || !value.every(v => text(v, 80))) return null;
  return value as string[];
}
export function parseProfileDetails(raw: unknown, expectedAlias: string): ProfileDetails | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!aliasOk(expectedAlias) || record.alias !== expectedAlias) return null;
  if (!(record.python === null || text(record.python))) return null;
  let docker: ProfileDetails["docker"] = null;
  if (record.docker !== null) {
    if (!record.docker || typeof record.docker !== "object" || Array.isArray(record.docker)) return null;
    const d = record.docker as Record<string, unknown>;
    const services = names(d.services);
    const controlServices = names(d.controlServices);
    if (!text(d.composeFile) || !text(d.projectName, 80) || !services || !controlServices) return null;
    docker = { composeFile: d.composeFile, projectName: d.projectName, services, controlServices };
  }
  return { alias: expectedAlias, python: record.python as string | null, docker };
}

/** CLI profile test checks a Python executable, but reports only configured Docker metadata. */
export function parseProfileTest(raw: unknown, expectedAlias: string): ProfileTestResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!aliasOk(expectedAlias) || record.alias !== expectedAlias) return null;
  const part = (value: unknown): { configured: boolean; available: boolean | null; version: string | null } | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const obj = value as Record<string, unknown>;
    if (typeof obj.configured !== "boolean") return null;
    return {
      configured: obj.configured,
      available: typeof obj.available === "boolean" ? obj.available : null,
      version: text(obj.version, 200) ? obj.version : null,
    };
  };
  const python = part(record.python);
  const dockerPart = record.docker && typeof record.docker === "object" && !Array.isArray(record.docker)
    ? record.docker as Record<string, unknown> : null;
  if (!python || !dockerPart || typeof dockerPart.configured !== "boolean") return null;
  return {
    alias: expectedAlias, python,
    docker: { configured: dockerPart.configured, valid: typeof dockerPart.valid === "boolean" ? dockerPart.valid : null }
  };
}

export function filterProfiles(profiles: CatalogProfile[], search: string): CatalogProfile[] {
  const needle = search.trim().toLocaleLowerCase();
  return [...profiles].sort((a, b) => a.alias.localeCompare(b.alias))
    .filter(p => p.alias.toLocaleLowerCase().includes(needle));
}

export function profileAliasValid(value: string): boolean { return aliasOk(value); }

/** Candidate validation is for friendly UI errors; Rust and the CLI remain authoritative. */
export function validateDraft(
  type: "python" | "docker",
  alias: string,
  input: { pythonPath: string; composeFile: string; projectName: string; services: string; controlServices: string }
): string | null {
  if (!aliasOk(alias)) return "프로필 별칭은 1~64자의 영문·숫자·._-만 사용할 수 있으며, '-'로 시작하거나 '..'을 포함할 수 없습니다.";
  if (type === "python") {
    if (!text(input.pythonPath)) return "존재하는 python.exe의 Windows 절대 경로를 입력하세요.";
    if (!/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\)/.test(input.pythonPath) || !/\\python\.exe$/i.test(input.pythonPath)) {
      return "python.exe의 Windows 절대 경로를 입력하세요.";
    }
  } else {
    if (!text(input.composeFile) || !/\.ya?ml$/i.test(input.composeFile) ||
        /^[A-Za-z]:|^[/\\]|(^|[/\\])\.\.([/\\]|$)/.test(input.composeFile)) {
      return "Compose 파일은 상위 폴더(..)를 포함하지 않는 .yml/.yaml 상대 경로여야 합니다.";
    }
    if (!text(input.projectName, 80) || !/^[A-Za-z0-9._-]+$/.test(input.projectName) ||
        input.projectName.startsWith("-") || input.projectName.includes("..")) {
      return "Compose 프로젝트 이름을 확인하세요 (영문·숫자·._-).";
    }
    for (const [label, value, required] of [
      ["서비스", input.services, true], ["제어 서비스", input.controlServices, false]
    ] as const) {
      const parts = value.split(",").map(v => v.trim()).filter(Boolean);
      if (!value.trim() && !required) continue;
      if (parts.length < 1 || parts.length > 16 || parts.some(v => !/^[A-Za-z0-9_-]{1,80}$/.test(v))) {
        return label + "는 쉼표로 구분된 1~16개의 서비스 이름이어야 합니다.";
      }
    }
  }
  return null;
}

/** The form can register either kind, or both in one CLI operation.
 * Validate only enabled fields; untouched kinds stay untouched in the CLI store.
 */
export function validateProfileSelection(
  alias: string,
  input: { pythonPath: string; composeFile: string; projectName: string; services: string; controlServices: string },
  selection: { python: boolean; docker: boolean }
): string | null {
  if (!selection.python && !selection.docker) return "Python과 Docker 중 하나 이상을 선택하세요.";
  if (selection.python) {
    const issue = validateDraft("python", alias, input);
    if (issue) return issue;
  }
  if (selection.docker) {
    const issue = validateDraft("docker", alias, input);
    if (issue) return issue;
  }
  return null;
}
