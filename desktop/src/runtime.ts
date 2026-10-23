import { invoke } from "@tauri-apps/api/core";

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

export type ManagedAction = "status" | "prepare" | "start" | "stop" | "restart";
export interface ManagedResult {
  available: boolean;
  ready: boolean;
  running: boolean;
  instance: string;
  port: number;
  details: string;
  oneTimeOwnerToken?: string;
}
export async function manageOwnedCli(action: ManagedAction): Promise<ManagedResult> {
  if (!isNativeApp()) {
    return { available: false, ready: false, running: false,
      instance: "tauri-preview-v1", port: 18797, details: "Windows Tauri 프리뷰에서만 지원합니다." };
  }
  return invoke<ManagedResult>("manage_owned_cli", { action });
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
