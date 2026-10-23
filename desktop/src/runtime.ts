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
