//! Tauri window and tray lifecycle. Minimize keeps the taskbar button;
//! closing the window hides to tray; explicit Quit stops the owned MCP.
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, Manager, WindowEvent,
};
use std::sync::atomic::{AtomicBool, Ordering};

const MAIN_WINDOW: &str = "main";
const MENU_SHOW: &str = "app-show";
const MENU_QUIT: &str = "app-quit";
static TRAY_QUIT_PENDING: AtomicBool = AtomicBool::new(false);

pub(crate) fn restore_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub(crate) fn hide_main(app: &AppHandle) -> Result<(), String> {
    let window = app.get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| "Tauri 프리뷰 창을 찾을 수 없습니다.".to_string())?;
    window.hide().map_err(|_| "프리뷰 창을 트레이로 숨기지 못했습니다.".to_string())
}

pub(crate) fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, MENU_SHOW, "창 열기", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "종료", true, None::<&str>)?;
    let quit_for_event = quit.clone();
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let icon = app.default_window_icon().cloned()
        .ok_or_else(|| std::io::Error::other("missing Tauri preview tray icon"))?;

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("ChatGPT To Codex · Tauri Preview")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            MENU_SHOW => restore_main(app),
            MENU_QUIT => {
                // Do not schedule the destructive CLI stop twice if the user
                // clicks Quit repeatedly while the Windows process is busy.
                if TRAY_QUIT_PENDING.compare_exchange(
                    false, true, Ordering::AcqRel, Ordering::Acquire
                ).is_err() { return; }
                let _ = quit_for_event.set_enabled(false);
                let _ = quit_for_event.set_text("종료 중...");
                // A hidden tray-only window gives no feedback for the multi-
                // second CLI ownership/termination path. Restore it first.
                restore_main(app);
                let _ = app.emit("c2c:tray-exit-started", ());
                let handle = app.clone();
                let quit_item = quit_for_event.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = crate::cli_operations::close_preview_with_owned_mcp(handle.clone()).await {
                        TRAY_QUIT_PENDING.store(false, Ordering::Release);
                        let _ = quit_item.set_text("종료");
                        let _ = quit_item.set_enabled(true);
                        restore_main(&handle);
                        let _ = handle.emit("c2c:tray-exit-error", error);
                    }
                });
            }
            _ => (),
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } = event {
                restore_main(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

pub(crate) fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW {
        return;
    }
    match event {
        // X always hides to tray. Even if hiding fails, never exit without
        // an explicit request to stop the owned MCP.
        WindowEvent::CloseRequested { api, .. } => {
            let _ = window.hide();
            api.prevent_close();
        }
        _ => (),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_action_ids_are_distinct_from_runtime_management() {
        assert_ne!(MENU_SHOW, MENU_QUIT);
        assert!(!MENU_SHOW.contains("stop"));
        assert!(!MENU_QUIT.contains("server"));
        assert_eq!(MAIN_WINDOW, "main");
    }
}
