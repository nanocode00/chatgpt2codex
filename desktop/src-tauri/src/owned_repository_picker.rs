//! Windows native folder picker for *isolated* Tauri repository registration.
//! JavaScript never supplies a filesystem path to the registration command.
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

static PICKED: OnceLock<Mutex<Option<PendingFolder>>> = OnceLock::new();
static SERIAL: AtomicU64 = AtomicU64::new(1);

struct PendingFolder {
    serial: u64,
    path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFolder {
    serial: u64,
    path: String,
    suggested_id: String,
    suggested_name: String,
}

fn pending() -> &'static Mutex<Option<PendingFolder>> {
    PICKED.get_or_init(|| Mutex::new(None))
}

fn suggested_id(name: &str) -> String {
    let mut value = String::new();
    for c in name.to_ascii_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            value.push(c);
        } else if matches!(c, '-' | '_' | '.' | ' ') {
            if !value.is_empty() && !value.ends_with('-') {
                value.push('-');
            }
        }
        if value.len() >= 60 { break; }
    }
    let value = value.trim_end_matches('-');
    if value.is_empty() { "project".to_string() } else { value.to_owned() }
}

fn preview_for(path: PathBuf) -> Result<PickedFolder, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| "선택한 폴더의 실제 경로를 확인할 수 없습니다.".to_string())?;
    if !canonical.is_dir() {
        return Err("프로젝트 폴더가 아닙니다.".into());
    }
    let shown = canonical.to_str()
        .filter(|s| s.len() <= 4096 && !s.chars().any(char::is_control))
        .ok_or("폴더 경로를 표시할 수 없습니다.")?
        .to_owned();
    let basename = canonical.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Project");
    let suggested_name = basename.chars().take(65).collect::<String>();
    let serial = SERIAL.fetch_add(1, Ordering::Relaxed);
    let next = PickedFolder {
        serial, path: shown, suggested_id: suggested_id(&suggested_name),
        suggested_name,
    };
    *pending().lock().map_err(|_| "프로젝트 폴더 선택 잠금 오류")? =
        Some(PendingFolder { serial, path: canonical });
    Ok(next)
}

#[tauri::command]
pub async fn pick_owned_repository_folder(app: AppHandle) -> Result<Option<PickedFolder>, String> {
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_dialog::DialogExt;
            crate::managed_cli::verify_preview_bundle()?;
            // Rust-only dialog: frontend has no unrestricted filesystem/dialog permission.
            let selected = app.dialog().file().blocking_pick_folder();
            match selected {
                Some(path) => {
                    let path = path.into_path()
                        .map_err(|_| "Windows 폴더 선택 결과를 해석할 수 없습니다.")?;
                    preview_for(path).map(Some)
                }
                None => {
                    *pending().lock().map_err(|_| "프로젝트 폴더 선택 잠금 오류")? = None;
                    Ok(None)
                }
            }
        }).await.map_err(|_| "폴더 선택 작업이 중단됐습니다.".to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("Windows Tauri 앱에서만 폴더 선택을 지원합니다.".into())
    }
}

#[tauri::command]
pub async fn register_owned_picked_repository(
    serial: u64, id: String, name: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut selection = pending().lock()
            .map_err(|_| "프로젝트 선택 잠금 오류".to_string())?;
        let selected = selection.as_ref()
            .filter(|item| item.serial == serial)
            .ok_or("폴더 선택이 만료됐습니다. 폴더를 다시 선택하세요.")?;
        crate::managed_cli::register_picked_repository(&selected.path, id.trim(), name.trim())?;
        *selection = None;
        Ok(())
    }).await.map_err(|_| "프로젝트 등록 작업이 중단됐습니다.".to_string())?
}

#[tauri::command]
pub fn cancel_owned_picked_repository(serial: u64) -> Result<(), String> {
    let mut choice = pending().lock().map_err(|_| "프로젝트 선택 잠금 오류")?;
    if choice.as_ref().is_some_and(|item| item.serial == serial) {
        *choice = None;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn suggested_ids_are_bounded_and_safe() {
        assert_eq!(suggested_id("Tauri Smoke"), "tauri-smoke");
        assert_eq!(suggested_id("한글 프로젝트"), "project");
        assert_eq!(suggested_id("___A____B___"), "a-b");
        assert!(suggested_id(&"x".repeat(300)).len() <= 60);
    }
}
