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

export interface CliInspection {
  available: boolean;
  instance: string;
  alive: boolean;
  healthy: boolean;
  tunnelAlive: boolean | null;
  publicHealthy: boolean | null;
  endpoint: string | null;
  publicConnector: string | null;
  details: string;
}

export async function inspectInstalledCli(instance = "default"): Promise<CliInspection> {
  if (!isNativeApp()) {
    return {
      available: false, instance, alive: false, healthy: false,
      tunnelAlive: null, publicHealthy: null, endpoint: null, publicConnector: null,
      details: "CLI 인스턴스 조회는 Windows Tauri 앱에서만 지원합니다."
    };
  }
  return invoke<CliInspection>("inspect_cli_health", { instance });
}

export type CliLogComponent = "server" | "tunnel";

export interface CliLogPreview {
  available: boolean;
  instance: string;
  component: CliLogComponent;
  content: string;
  details: string;
  truncated: boolean;
}

export async function inspectInstalledCliLogs(component: CliLogComponent, instance = "default"): Promise<CliLogPreview> {
  if (!isNativeApp()) {
    return { available: false, instance, component, content: "", truncated: false,
      details: "로그 조회는 Windows 네이티브 프리뷰에서만 지원합니다." };
  }
  return invoke<CliLogPreview>("inspect_cli_logs", { instance, component });
}

export async function closePreviewWindow(): Promise<void> {
  if (!isNativeApp()) return;
  await invoke<void>("close_preview_window");
}

/** Exit after an audited stop of only the isolated Tauri-owned MCP/tunnel.
 * Rejects and leaves the app open on ambiguous ownership or an occupied port. */
export async function closePreviewWithOwnedMcp(): Promise<void> {
  if (!isNativeApp()) throw new Error("Windows Tauri 앱에서만 완전 종료할 수 있습니다.");
  await invoke<void>("close_preview_with_owned_mcp");
}

/** F5-B: native Tauri window only. Never touches CLI or the WinForms server. */
export async function hidePreviewWindow(): Promise<void> {
  if (!isNativeApp()) throw new Error("Windows Tauri 앱에서만 트레이로 숨길 수 있습니다.");
  await invoke<void>("hide_preview_window");
}

export type TrustedLink = "github" | "developer" | "local_health" | "public_health";
/** The Rust command selects exact destinations and revalidates health on click. */
export async function openTrustedLink(kind: TrustedLink, port?: number): Promise<void> {
  if (!isNativeApp()) throw new Error("Windows Tauri 앱에서만 외부 브라우저를 열 수 있습니다.");
  await invoke<void>("open_trusted_link", { kind, port: port ?? null });
}

export type PublicTunnelState = "online" | "offline" | "unavailable" | "unsupported";

export interface PublicTunnelHealth {
  state: PublicTunnelState;
  endpoint: string | null;
  details: string;
}

/** Read-only public HTTPS probe. No token is used or sent. */
export async function inspectPublicTunnel(instance = "default"): Promise<PublicTunnelHealth> {
  if (!isNativeApp()) {
    return { state: "unavailable", endpoint: null, details: "공개 상태 확인은 Tauri 네이티브 앱에서만 지원합니다." };
  }
  return invoke<PublicTunnelHealth>("inspect_public_tunnel_health", { instance });
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
  legacyProject: string | null;
  legacyProjectExists: boolean;
  details: string;
}
/** Read-only. Lists use the isolated hash-verified preview CLI, not WinForms. */
export async function inspectOwnedCatalog(): Promise<CatalogInspection> {
  if (!isNativeApp()) {
    return { available: false, projects: [], profiles: [], legacyProject: null,
      legacyProjectExists: false, details: "프로젝트/프로필 조회는 Windows Tauri 앱에서만 지원합니다." };
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

/** External HTTPS identity probe for the exact Tauri-owned Quick Tunnel.
 * Never uses the installed WinForms/default connector or a WebView URL. */
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
  tokenCopyAvailable: boolean;
}
export async function manageOwnedCli(action: ManagedAction): Promise<ManagedResult> {
  if (!isNativeApp()) {
    return { available: false, ready: false, running: false, tunnelCapable: false, tunnelRunning: false,
      instance: "tauri-preview-v1", port: 18797, details: "Windows Tauri 프리뷰에서만 지원합니다." };
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

export interface LegacyMigrationReport {
  sourceFound: boolean;
  settingsFound: boolean;
  selectedProject: string | null;
  projectExists: boolean;
  port: number | null;
  tunnelEnabled: boolean | null;
  customHostnameConfigured: boolean;
  launchAtStartup: boolean | null;
  startMcpOnOpen: boolean | null;
  autoCheckUpdates: boolean | null;
  language: string | null;
  ownerHashValid: boolean;
  oauthValid: boolean;
  oauthClientCount: number | null;
  runtimeRecordFound: boolean;
  localPortListening: boolean;
  canTransitionNow: boolean;
  snapshotSaved: boolean;
  snapshotPath: string | null;
  warnings: string[];
}

export async function inspectLegacyMigration(): Promise<LegacyMigrationReport> {
  return invoke<LegacyMigrationReport>("inspect_legacy_migration");
}

export async function saveLegacySettingsSnapshot(): Promise<LegacyMigrationReport> {
  return invoke<LegacyMigrationReport>("save_legacy_settings_snapshot");
}

export interface CredentialBackupReport {
  exists: boolean;
  verified: boolean;
  encrypted: boolean;
  path: string | null;
  createdAtUnix: number | null;
  oauthClients: number | null;
  details: string;
}

export async function inspectCredentialBackup(): Promise<CredentialBackupReport> {
  return invoke<CredentialBackupReport>("inspect_credential_backup");
}

export async function createCredentialBackup(): Promise<CredentialBackupReport> {
  return invoke<CredentialBackupReport>("create_credential_backup");
}

export interface RestoreRehearsalReport {
  passed: boolean;
  restoredFiles: number;
  oauthClients: number;
  originalFilesModified: boolean;
  temporaryDirectoryRetained: boolean;
  details: string;
}

/** Does not restore into any running or installed WinForms runtime. */
export async function rehearseCredentialRestore(): Promise<RestoreRehearsalReport> {
  return invoke<RestoreRehearsalReport>("rehearse_credential_restore");
}

export interface CutoverReadinessCheck {
  id: string;
  label: string;
  status: "passed" | "blocked" | "unverified";
  details: string;
}
export interface CutoverReadiness {
  canTransitionNow: boolean;
  dryRunOnly: boolean;
  checks: CutoverReadinessCheck[];
}
/** Read-only and never a production cutover approval. */
export async function inspectCutoverReadiness(): Promise<CutoverReadiness> {
  return invoke<CutoverReadiness>("inspect_cutover_readiness");
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
}
export async function runOwnedCliParity(request: OwnedCliParityRequest): Promise<OwnedCliParityResponse> {
  if (!isNativeApp()) throw new Error("CLI 작업은 Windows Tauri 프리뷰에서만 지원합니다.");
  return invoke<OwnedCliParityResponse>("run_owned_cli_parity", { request });
}
