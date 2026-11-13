import { invoke } from "@tauri-apps/api/core";

export interface PreviewStartupInspection {
  supported: boolean;
  enabled: boolean;
  conflict: boolean;
  details: string;
}

export async function inspectPreviewAutostart(): Promise<PreviewStartupInspection> {
  if (!isNativeApp()) {
    return { supported: false, enabled: false, conflict: false, details: "Windows 설치형 Tauri 앱에서만 지원합니다." };
  }
  return invoke<PreviewStartupInspection>("inspect_preview_autostart");
}

export async function setPreviewAutostart(enable: boolean): Promise<PreviewStartupInspection> {
  if (!isNativeApp()) throw new Error("Windows Tauri 앱에서만 변경할 수 있습니다.");
  return invoke<PreviewStartupInspection>("set_preview_autostart", { enable });
}

export interface RuntimeHealth {
  online: boolean;
  service: string;
  port: number;
  endpoint: string;
  details: string;
}

export function isNativeApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function checkRuntime(port: number): Promise<RuntimeHealth> {
  if (!isNativeApp()) {
    return {
      online: false,
      service: "Preview",
      port,
      endpoint: "http://127.0.0.1:" + port + "/mcp",
      details: "브라우저 미리보기에서는 로컬 서버를 검사하지 않습니다. Tauri 앱에서 실행해 주세요."
    };
  }
  return invoke<RuntimeHealth>("runtime_health", { port });
}

/** Exit after an audited stop of only the isolated Tauri-owned MCP/tunnel.
 * Rejects and leaves the app open on ambiguous ownership or an occupied port. */
export async function closePreviewWithOwnedMcp(): Promise<void> {
  if (!isNativeApp()) throw new Error("Windows Tauri 앱에서만 완전 종료할 수 있습니다.");
  await invoke<void>("close_preview_with_owned_mcp");
}

/** Native Tauri window only; hiding leaves the MCP running. */
export async function hidePreviewWindow(): Promise<void> {
  if (!isNativeApp()) throw new Error("Windows Tauri 앱에서만 트레이로 숨길 수 있습니다.");
  await invoke<void>("hide_preview_window");
}

export type PublicTunnelState = "online" | "offline" | "unavailable" | "unsupported";

export interface PublicTunnelHealth {
  state: PublicTunnelState;
  endpoint: string | null;
  details: string;
}

export interface CatalogRepository {
  id: string;
  name: string;
  available: boolean;
}
export interface CatalogProfile {
  alias: string;
  python: boolean;
  docker: boolean;
}
export interface CatalogInspection {
  available: boolean;
  projects: CatalogRepository[];
  profiles: CatalogProfile[];
  details: string;
}
/** Read-only. Lists use the app-owned, hash-verified CLI. */
export async function inspectOwnedCatalog(): Promise<CatalogInspection> {
  if (!isNativeApp()) {
    return { available: false, projects: [], profiles: [],
      details: "프로젝트/프로필 조회는 Windows Tauri 앱에서만 지원합니다." };
  }
  return invoke<CatalogInspection>("inspect_owned_catalog");
}

/** Unregister an entry from the isolated Tauri CLI catalog only; never delete its directory. */
export async function unregisterOwnedRepository(id: string): Promise<void> {
  if (!isNativeApp()) throw new Error("Windows Tauri 앱에서만 프로젝트 등록을 해제할 수 있습니다.");
  await invoke<void>("unregister_owned_repository", { id });
}

/** Native OS-picked folder preview. Its serial is a one-shot registration token;
 * registration never takes a path supplied by the frontend. */
export interface PickedRepositoryFolder {
  serial: number;
  path: string;
  suggestedId: string;
  suggestedName: string;
}
export async function pickOwnedRepositoryFolder(): Promise<PickedRepositoryFolder | null> {
  if (!isNativeApp()) throw new Error("Windows Tauri 앱에서만 폴더를 선택할 수 있습니다.");
  return invoke<PickedRepositoryFolder | null>("pick_owned_repository_folder");
}
export async function registerOwnedPickedRepository(serial: number, id: string, name: string): Promise<void> {
  if (!isNativeApp()) throw new Error("Windows Tauri 앱에서만 등록할 수 있습니다.");
  await invoke<void>("register_owned_picked_repository", { serial, id, name });
}
export async function cancelOwnedPickedRepository(serial: number): Promise<void> {
  if (!isNativeApp()) return;
  await invoke<void>("cancel_owned_picked_repository", { serial });
}

/** External HTTPS identity probe for the app-owned Quick Tunnel. */
export async function inspectOwnedPublicTunnelHealth(): Promise<PublicTunnelHealth> {
  if (!isNativeApp()) {
    return { state: "unavailable", endpoint: null, details: "Windows Tauri 앱에서만 외부 연결을 검사합니다." };
  }
  return invoke<PublicTunnelHealth>("inspect_owned_public_tunnel_health");
}

export type ManagedAction = "status" | "prepare" | "rotate-token" | "start" | "start-public" | "stop" | "restart";
export interface ManagedResult {
  available: boolean;
  ready: boolean;
  running: boolean;
  tunnelCapable: boolean;
  tunnelRunning: boolean;
  publicConnector?: string;
  instance: string;
  port: number;
  details: string;
  oneTimeOwnerToken?: string;
  tokenCopyAvailable?: boolean;
}

/** Change the actual owned MCP listening port, restarting it when running. */
export async function setOwnedPort(port: number): Promise<ManagedResult> {
  if (!isNativeApp()) throw new Error("서버 포트는 Windows Tauri 앱에서만 변경할 수 있습니다.");
  return invoke<ManagedResult>("set_owned_port", { port });
}

export async function manageOwnedCli(action: ManagedAction): Promise<ManagedResult> {
  if (!isNativeApp()) {
    return { available: false, ready: false, running: false, tunnelCapable: false, tunnelRunning: false,
      instance: "tauri-preview-v1", port: 7979, details: "Windows Tauri 앱에서만 지원합니다." };
  }
  return invoke<ManagedResult>("manage_owned_cli", { action });
}

/** Native Windows clipboard copy: secret never enters WebView JS. */
export async function copyOwnedOwnerToken(): Promise<void> {
  if (!isNativeApp()) throw new Error("Owner Token 복사는 Windows Tauri 앱에서만 지원합니다.");
  await invoke<void>("copy_owned_owner_token");
}

/** Explicit owner-provided token import, validated against the isolated CLI hash. */
export async function registerOwnedOwnerToken(candidate: string): Promise<void> {
  if (!isNativeApp()) throw new Error("Owner Token 등록은 Windows Tauri 앱에서만 지원합니다.");
  await invoke<boolean>("register_owned_owner_token", { candidate });
}

/** F5-E: typed, finite CLI parity contract; no generic argv/shell bridge. */
export type OwnedCliParityOperation =
  | "profile-list" | "profile-show" | "profile-test"
  | "profile-add-python" | "profile-add-docker"
  | "profile-remove-python" | "profile-remove-docker" | "profile-remove-all"
  | "config-show" | "config-export" | "config-set" | "config-unset"
  | "reload" | "status" | "health" | "doctor" | "logs-server" | "logs-tunnel"
  | "repository-show" | "secret-list" | "lock-list" | "job-list"
  | "job-status" | "job-logs" | "job-resume" | "job-cancel"
  | "control-list" | "control-auto-status";

export interface OwnedCliParityRequest {
  operation: OwnedCliParityOperation;
  alias?: string;
  target?: string;
  value?: string;
  key?: string;
  composeFile?: string;
  projectName?: string;
  services?: string;
  controlServices?: string;
}
export interface OwnedCliParityResponse {
  operation: OwnedCliParityOperation;
  command: string;
  json: unknown | null;
  text: string | null;
  note: string;
  /** Milliseconds for Rust plan + verified CLI launch + response parsing. */
  bridgeMs?: number;
  /** Milliseconds in the CLI command handler (excludes Node startup). CI only. */
  cliMs?: number;
  bundleVerifyMs?: number;
  childProcessMs?: number;
}
export async function runOwnedCliParity(request: OwnedCliParityRequest): Promise<OwnedCliParityResponse> {
  if (!isNativeApp()) throw new Error("CLI 작업은 Windows Tauri 프리뷰에서만 지원합니다.");
  return invoke<OwnedCliParityResponse>("run_owned_cli_parity", { request });
}

export interface CliConsoleCheck {
  command: string;
  operation: string;
  mutating: boolean;
  note: string;
}

/** Validate a single C2C command using the exact native allowlist. Does not execute it. */
export async function checkOwnedCliConsole(input: string): Promise<CliConsoleCheck> {
  if (!isNativeApp()) throw new Error("CLI 문법 검사는 Windows Tauri 앱에서만 지원합니다.");
  return invoke<CliConsoleCheck>("check_owned_cli_console", { input });
}

/** Runs only the CLI grammar validated by the native parser; never a shell. */
export async function runOwnedCliConsole(input: string, confirmed: boolean): Promise<OwnedCliParityResponse> {
  if (!isNativeApp()) throw new Error("CLI 명령은 Windows Tauri 앱에서만 실행할 수 있습니다.");
  return invoke<OwnedCliParityResponse>("run_owned_cli_console", { input, confirmed });
}
