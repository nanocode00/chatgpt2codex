mod cli_health;
mod cli_operations;
mod public_health;
mod managed_cli;
mod catalog;
mod migration;
mod migration_backup;
mod cutover_readiness;
#[cfg(target_os = "windows")]
mod tray_lifecycle;
#[cfg(target_os = "windows")]
mod startup;
#[cfg(not(target_os = "windows"))]
mod startup {
    use serde::Serialize;
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct StartupInspection {
        supported: bool,
        enabled: bool,
        conflict: bool,
        details: &'static str,
    }
    #[tauri::command]
    pub fn inspect_preview_autostart() -> Result<StartupInspection, String> {
        Ok(StartupInspection {
            supported: false,
            enabled: false,
            conflict: false,
            details: "Windows 설치형 Tauri 앱에서만 지원합니다.",
        })
    }
    #[tauri::command]
    pub fn set_preview_autostart(_enable: bool) -> Result<StartupInspection, String> {
        Err("Windows 전용 기능입니다.".into())
    }
}
// Never link cutover mutation exercises into any release binary. Fixture only.
#[cfg(test)]
mod cutover_transaction_fixture;
#[cfg(all(test, windows))]
mod cutover_file_fixture;

use serde::Serialize;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeHealth {
    online: bool,
    service: String,
    port: u16,
    endpoint: String,
    details: String,
}

fn probe_local_runtime(port: u16) -> RuntimeHealth {
    let endpoint = format!("http://127.0.0.1:{port}/mcp");
    let mut snapshot = RuntimeHealth {
        online: false,
        service: "ChatGPT To Codex".into(),
        port,
        endpoint,
        details: "연결되지 않음".into(),
    };

    // Deliberately limit health probes to localhost. Never accept arbitrary
    // endpoints or fetch Owner Tokens from a public tunnel.
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = match TcpStream::connect_timeout(&address, Duration::from_millis(1100)) {
        Ok(stream) => stream,
        Err(_) => {
            snapshot.details = "해당 포트에서 로컬 C2C 서버를 찾을 수 없습니다.".into();
            return snapshot;
        }
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1100)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1100)));
    if stream
        .write_all(b"GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: application/json\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        snapshot.details = "서버에 상태 요청을 보내지 못했습니다.".into();
        return snapshot;
    }
    let mut response = Vec::new();
    // Bound reads and timeout even if a non-C2C service listens on the port.
    let mut buf = [0u8; 2048];
    while response.len() < 8192 {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => response.extend_from_slice(&buf[..n]),
            Err(_) => break,
        }
    }
    let raw = String::from_utf8_lossy(&response);
    if !raw.starts_with("HTTP/1.1 200 ") && !raw.starts_with("HTTP/1.0 200 ") {
        snapshot.details = "해당 포트의 HTTP 응답이 C2C Health 형식이 아닙니다.".into();
        return snapshot;
    }
    let Some((_, body)) = raw.split_once("\r\n\r\n") else {
        snapshot.details = "상태 응답을 파싱할 수 없습니다.".into();
        return snapshot;
    };
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(value) if value["ok"] == true && value["name"] == "chatgpt2codex" => {
            snapshot.online = true;
            snapshot.details = "로컬 MCP 서버가 정상 응답 중입니다.".into();
        }
        _ => snapshot.details = "해당 포트는 C2C 서버로 확인되지 않았습니다.".into(),
    }
    snapshot
}

#[tauri::command]
async fn runtime_health(port: u16) -> Result<RuntimeHealth, String> {
    // A synchronous TCP probe must not block the Tauri UI event loop.
    tauri::async_runtime::spawn_blocking(move || probe_local_runtime(port))
        .await
        .map_err(|error| format!("로컬 상태 검사에 실패했습니다: {error}"))
}

pub fn run() {
    let builder = tauri::Builder::default();
    // Register before any other plugin / setup. A second Windows Tauri
    // preview launch restores the existing window and then exits itself.
    // Neither invocation can take over the WinForms/default C2C runtime.
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        // Never inspect/log forwarded arguments: they are irrelevant to
        // preview focus and may contain sensitive user-specific paths.
        tray_lifecycle::restore_main(app);
    }));
    builder
        // The tray controls only this preview window. No installed CLI or
        // legacy WinForms lifecycle actions are registered here.
        .setup(|app| {
            #[cfg(target_os = "windows")]
            tray_lifecycle::setup(app)?;
            Ok(())
        })
        .on_window_event(|_window, _event| {
            #[cfg(target_os = "windows")]
            tray_lifecycle::on_window_event(_window, _event);
        })
        .invoke_handler(tauri::generate_handler![runtime_health, cli_health::inspect_cli_health, cli_operations::inspect_cli_logs, cli_operations::close_preview_window, public_health::inspect_public_tunnel_health, managed_cli::manage_owned_cli, catalog::inspect_owned_catalog, migration::inspect_legacy_migration, migration::save_legacy_settings_snapshot, migration_backup::inspect_credential_backup, migration_backup::create_credential_backup, migration_backup::rehearse_credential_restore, cutover_readiness::inspect_cutover_readiness, startup::inspect_preview_autostart, startup::set_preview_autostart])
        .run(tauri::generate_context!())
        .expect("failed to start ChatGPT To Codex desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_port_returns_offline() {
        let result = probe_local_runtime(0);
        assert!(!result.online);
        assert!(result.endpoint.contains("127.0.0.1:0"));
    }
}
