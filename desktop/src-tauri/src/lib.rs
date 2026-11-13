mod cli_health;
mod cli_operations;
mod public_health;
mod managed_cli;
mod owner_token_vault;
mod cli_parity;
mod ci_perf;
mod catalog;
mod ui_actions;
mod owned_repository_picker;
mod migration;
mod migration_backup;
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeHealth {
    online: bool,
    service: String,
    port: u16,
    endpoint: String,
    details: String,
}

fn cli_health_view(port: u16) -> Result<RuntimeHealth, String> {
    // The CLI is the sole authority for Health/PID/endpoint checks. This is
    // only a presentation adapter, not a second localhost probe.
    let args = ["health", "--instance", "tauri-preview-v1", "--local-only"]
        .iter().map(|v| (*v).to_owned()).collect::<Vec<_>>();
    let raw = managed_cli::parity_cli(&args, false, false, false, true)?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|_| "CLI Health 응답이 JSON이 아닙니다.")?;
    let healthy = value["healthy"].as_bool()
        .ok_or("CLI Health의 healthy 값이 올바르지 않습니다.")?;
    if value["instance"] != "tauri-preview-v1" {
        return Err("요청한 MCP 인스턴스의 응답이 아닙니다.".into());
    }
    let actual_port = value["port"].as_u64()
        .and_then(|v| u16::try_from(v).ok()).unwrap_or(port);
    Ok(RuntimeHealth {
        online: healthy,
        service: "ChatGPT To Codex".into(),
        port: actual_port,
        endpoint: format!("http://127.0.0.1:{actual_port}/mcp"),
        details: if healthy {
            "CLI에서 로컬 MCP Health를 확인했습니다."
        } else {
            "CLI에서 로컬 MCP가 중지되었거나 응답하지 않는 것으로 확인했습니다."
        }.into(),
    })
}

#[tauri::command]
async fn runtime_health(port: u16) -> Result<RuntimeHealth, String> {
    tauri::async_runtime::spawn_blocking(move || cli_health_view(port))
        .await.map_err(|_| "CLI Health 조회가 중단됐습니다.".to_string())?
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
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_dialog::init());
    builder
        .plugin(tauri_plugin_opener::init())
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
        .invoke_handler(tauri::generate_handler![runtime_health, cli_operations::close_preview_with_owned_mcp, public_health::inspect_owned_public_tunnel_health, managed_cli::manage_owned_cli, managed_cli::set_owned_port, managed_cli::copy_owned_owner_token, managed_cli::register_owned_owner_token, cli_parity::run_owned_cli_parity, cli_parity::check_owned_cli_console, cli_parity::run_owned_cli_console, ci_perf::ci_perf_enabled, ci_perf::ci_perf_submit, managed_cli::unregister_owned_repository, owned_repository_picker::pick_owned_repository_folder, owned_repository_picker::register_owned_picked_repository, owned_repository_picker::cancel_owned_picked_repository, catalog::inspect_owned_catalog, ui_actions::hide_preview_window, startup::inspect_preview_autostart, startup::set_preview_autostart])
        .run(tauri::generate_context!())
        .expect("failed to start ChatGPT To Codex desktop");
}
