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
