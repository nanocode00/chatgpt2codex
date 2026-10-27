//! F4-D3: guarded, opt-in Windows *Tauri-only* login startup.
//!
//! Never uses the WinForms "ChatGPT To Codex" Run value or touches a
//! default/7979 CLI, Cloudflare tunnel, OAuth files, Owner Token, or service.
//! Portable unsigned preview ZIPs are inspection-only.
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
use winreg::RegKey;

const RUN_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "ChatGPT To Codex Tauri Preview";
const PROGRAM_FOLDER: &str = "ChatGPT To Codex Tauri Preview";
const EXE_NAME: &str = "chatgpt2codex-desktop.exe";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupInspection {
    pub supported: bool,
    pub enabled: bool,
    pub conflict: bool,
    pub details: String,
}

fn local_target() -> Result<PathBuf, String> {
    let local = std::env::var_os("LOCALAPPDATA")
        .ok_or("Windows 사용자 로컬 설치 위치를 확인할 수 없습니다.")?;
    Ok(PathBuf::from(local)
        .join("Programs")
        .join(PROGRAM_FOLDER)
        .join(EXE_NAME))
}

// This is an exact allowed *separate Tauri* installation path, not the
// current user's legacy "Programs/ChatGPT To Codex" directory. A ZIP
// unpacked into Downloads/Temp/another arbitrary folder cannot self-register.
fn is_approved_executable(current_exe: &Path, target: &Path) -> bool {
    // Reject redirected EXE or installation folder. In particular,
    // do not autostart a symlink in the approved directory pointing to
    // some other command.
    if [current_exe, target, target.parent().unwrap_or(target)]
        .iter()
        .any(|path| fs::symlink_metadata(path).is_err() ||
            fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()))
    {
        return false;
    }
    let (Ok(current), Ok(approved)) = (fs::canonicalize(current_exe), fs::canonicalize(target)) else {
        return false;
    };
    current == approved
}

fn command_for(target: &Path) -> String {
    format!("\"{}\"", target.display())
}

fn read_value(root: &RegKey, key_path: &str, name: &str) -> Result<Option<String>, String> {
    let key = match root.open_subkey_with_flags(key_path, KEY_READ) {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("자동 시작 레지스트리 읽기에 실패했습니다.".into()),
    };
    match key.get_value::<String, _>(name) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("자동 시작 등록 값을 읽을 수 없습니다.".into()),
    }
}

fn write_value(root: &RegKey, key_path: &str, name: &str, value: &str) -> Result<(), String> {
    let key = root.open_subkey_with_flags(key_path, KEY_WRITE)
        .map_err(|_| "자동 시작 등록 키를 열 수 없습니다.".to_owned())?;
    key.set_value(name, &value)
        .map_err(|_| "자동 시작 값을 등록하지 못했습니다.".to_owned())
}

fn delete_value(root: &RegKey, key_path: &str, name: &str) -> Result<(), String> {
    let key = root.open_subkey_with_flags(key_path, KEY_WRITE)
        .map_err(|_| "자동 시작 등록 키를 열 수 없습니다.".to_owned())?;
    key.delete_value(name)
        .map_err(|_| "자동 시작 등록을 해제하지 못했습니다.".to_owned())
}

fn inspect_with(root: &RegKey, key_path: &str, name: &str, current: &Path, target: &Path) -> Result<StartupInspection, String> {
    let allowed = is_approved_executable(current, target);
    let stored = read_value(root, key_path, name)?;
    let expected = command_for(target);
    let conflict = stored.as_ref().is_some_and(|value| value != &expected);
    let enabled = stored.as_ref().is_some_and(|value| value == &expected);
    let details = if conflict {
        "Tauri 자동 시작 이름에 다른 항목이 등록되어 있어 변경하지 않습니다."
    } else if !allowed {
        "휴대용 ZIP 프리뷰에서는 자동 시작 등록을 허용하지 않습니다. 별도 설치형 Tauri 패키지가 필요합니다."
    } else if enabled {
        "현재 사용자 계정에서 Tauri 프리뷰 자동 시작이 등록되어 있습니다."
    } else {
        "현재 사용자 계정에 Tauri 프리뷰 자동 시작이 등록되지 않았습니다."
    };
    Ok(StartupInspection {
        supported: allowed && !conflict,
        enabled, conflict,
        details: details.into(),
    })
}

fn change_with(root: &RegKey, key_path: &str, name: &str, current: &Path, target: &Path, enable: bool) -> Result<StartupInspection, String> {
    let expected = command_for(target);
    let stored = read_value(root, key_path, name)?;
    if let Some(ref value) = stored {
        if value != &expected {
            return Err("다른 자동 시작 등록을 덮어쓰거나 삭제할 수 없습니다.".into());
        }
    }
    if enable {
        if !is_approved_executable(current, target) {
            return Err("휴대용 ZIP 프리뷰는 자동 시작 등록을 지원하지 않습니다.".into());
        }
        if stored.is_none() {
            write_value(root, key_path, name, &expected)?;
        }
    } else if stored.is_some() {
        // Disable only the exact owned Tauri entry; never remove legacy.
        delete_value(root, key_path, name)?;
    }
    inspect_with(root, key_path, name, current, target)
}

#[tauri::command]
pub fn inspect_preview_autostart() -> Result<StartupInspection, String> {
    let exe = std::env::current_exe().map_err(|_| "프리뷰 경로를 확인할 수 없습니다.")?;
    inspect_with(&RegKey::predef(HKEY_CURRENT_USER), RUN_PATH, VALUE_NAME, &exe, &local_target()?)
}

#[tauri::command]
pub fn set_preview_autostart(enable: bool) -> Result<StartupInspection, String> {
    let exe = std::env::current_exe().map_err(|_| "프리뷰 경로를 확인할 수 없습니다.")?;
    change_with(&RegKey::predef(HKEY_CURRENT_USER), RUN_PATH, VALUE_NAME, &exe, &local_target()?, enable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_separate_unique_identity() {
        assert_ne!(VALUE_NAME, "ChatGPT To Codex");
        assert_ne!(PROGRAM_FOLDER, "ChatGPT To Codex");
        assert_eq!(command_for(Path::new(r"C:\Example Folder\example.exe")), r#""C:\Example Folder\example.exe""#);
    }

    #[test]
    fn registry_roundtrip_disposable_ci_only() {
        if std::env::var("GITHUB_ACTIONS").ok().as_deref() != Some("true")
            || std::env::var("CI").ok().as_deref() != Some("true")
            || std::env::var_os("RUNNER_TEMP").is_none()
        {
            // Never write real Windows registry keys during local cargo test.
            return;
        }
        let root = RegKey::predef(HKEY_CURRENT_USER);
        let path = format!(
            r"Software\C2C-F4D3-AutoStart-Runner\{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        );
        let (test_key, _) = root.create_subkey(&path).unwrap();
        drop(test_key);
        let temp = PathBuf::from(std::env::var_os("RUNNER_TEMP").unwrap());
        let fake_dir = temp.join(format!("c2c-f4d3-autostart-test-{}", std::process::id()));
        fs::create_dir_all(&fake_dir).unwrap();
        let exe = fake_dir.join("chatgpt2codex-desktop.exe");
        fs::write(&exe, b"isolated fixture only").unwrap();
        let cleanup = || {
            let _ = root.delete_subkey(&path);
            let _ = fs::remove_file(&exe);
            let _ = fs::remove_dir_all(&fake_dir);
        };
        let result = std::panic::catch_unwind(|| {
            // Emulate a WinForms value in the isolated fixture only. Neither
            // this UI feature nor its rollback may alter that legacy name.
            let legacy = "\"C:\\Legacy.exe\"";
            let reg = root.open_subkey_with_flags(&path, KEY_WRITE).unwrap();
            reg.set_value("ChatGPT To Codex", &legacy).unwrap();
            let first = inspect_with(&root, &path, VALUE_NAME, &exe, &exe).unwrap();
            assert!(first.supported);
            assert!(!first.enabled);
            let enabled = change_with(&root, &path, VALUE_NAME, &exe, &exe, true).unwrap();
            assert!(enabled.enabled);
            let repeat = change_with(&root, &path, VALUE_NAME, &exe, &exe, true).unwrap();
            assert!(repeat.enabled);
            let disabled = change_with(&root, &path, VALUE_NAME, &exe, &exe, false).unwrap();
            assert!(!disabled.enabled);
            let unchanged: String = reg.get_value("ChatGPT To Codex").unwrap();
            assert_eq!(unchanged, legacy);

            let key = root.open_subkey_with_flags(&path, KEY_WRITE).unwrap();
            key.set_value(VALUE_NAME, &"\"C:\\Unrelated.exe\"").unwrap();
            assert!(inspect_with(&root, &path, VALUE_NAME, &exe, &exe).unwrap().conflict);
            assert!(change_with(&root, &path, VALUE_NAME, &exe, &exe, true).is_err());
            assert!(change_with(&root, &path, VALUE_NAME, &exe, &exe, false).is_err());
            let foreign: String = key.get_value(VALUE_NAME).unwrap();
            assert_eq!(foreign, "\"C:\\Unrelated.exe\"");
            key.delete_value(VALUE_NAME).unwrap();

            // Portable preview cannot enable even with no competing entry.
            let other = fake_dir.join("unrelated.exe");
            fs::write(&other, b"not allowed").unwrap();
            assert!(!inspect_with(&root, &path, VALUE_NAME, &other, &exe).unwrap().supported);
            assert!(change_with(&root, &path, VALUE_NAME, &other, &exe, true).is_err());
            fs::remove_file(other).unwrap();
        });
        cleanup();
        result.unwrap();
    }
}
