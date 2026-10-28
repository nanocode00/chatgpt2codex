//! F4-D2-A: Windows-only Tauri preview window and tray lifecycle.
//! Deliberately controls this Tauri window only. It never touches WinForms,
//! the installed default C2C instance, 7979, tokens, or cloudflared.
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager, WindowEvent,
};

const MAIN_WINDOW: &str = "main";
const MENU_SHOW: &str = "preview-show";
const MENU_QUIT: &str = "preview-quit";

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
    let open = MenuItem::with_id(app, MENU_SHOW, "창 열기", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "프리뷰 종료", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let icon = app.default_window_icon().cloned()
        .ok_or_else(|| std::io::Error::other("missing Tauri preview tray icon"))?;

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("ChatGPT To Codex · Tauri Preview")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW => restore_main(app),
            MENU_QUIT => app.exit(0),
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
        // X hides the preview; tray "프리뷰 종료" and in-app exit are
        // explicit. Do not block closure if Windows refuses to hide.
        WindowEvent::CloseRequested { api, .. } => {
            if window.hide().is_ok() {
                api.prevent_close();
            }
        }
        // Native minimize hides to the tray, instead of leaving a
        // background window visible in the taskbar.
        WindowEvent::Resized(_) => {
            if window.is_minimized().unwrap_or(false) {
                let _ = hide_main(window.app_handle());
            }
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
