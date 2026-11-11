//! Separate Windows-user-bound DPAPI vault for the *isolated Tauri* Owner Token.
//! The official CLI keeps only an owner-token SHA-256 hash. Never reads WinForms
//! credentials and never writes a token to disk in plaintext.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

const MAX_TOKEN_LEN: usize = 160;
const VAULT_FILE: &str = "tauri-owner-token.dpapi";

fn state_dir(home: &Path) -> PathBuf {
    home.join(".local").join("share").join("chatgpt2codex")
}
fn path(home: &Path) -> PathBuf { state_dir(home).join(VAULT_FILE) }

fn matching_current_token(home: &Path, candidate: &str) -> bool {
    if candidate.len() < 20 || candidate.len() > MAX_TOKEN_LEN ||
        !candidate.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return false;
    }
    let file = state_dir(home).join("owner-token.json");
    let Ok(bytes) = fs::read(file) else { return false; };
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&bytes) else { return false; };
    let Some(expected) = json["tokenHash"].as_str() else { return false; };
    let hash = URL_SAFE_NO_PAD.encode(Sha256::digest(candidate.as_bytes()));
    // Comparing a derived digest instead of plaintext. No candidate in any error/log.
    if expected.len() != hash.len() { return false; }
    let mut mismatch = 0u8;
    for (a, b) in expected.bytes().zip(hash.bytes()) { mismatch |= a ^ b; }
    mismatch == 0
}

/// Called after the CLI has stored the hash, or after the user supplies an
/// existing token. The candidate must match this isolated HOME's current hash.
pub(crate) fn store(home: &Path, candidate: &str) -> Result<(), String> {
    if !matching_current_token(home, candidate) {
        return Err("토큰이 이 Tauri 인스턴스의 현재 Owner Token과 일치하지 않습니다.".into());
    }
    let encrypted = crate::migration_backup::dpapi::encrypt(candidate.as_bytes())?;
    let parent = state_dir(home);
    fs::create_dir_all(&parent).map_err(|_| "토큰 보관 경로를 만들 수 없습니다.")?;
    let dst = path(home);
    let tmp = parent.join(format!(".{VAULT_FILE}.{}.tmp", std::process::id()));
    let outcome = fs::write(&tmp, encrypted)
        .and_then(|_| fs::rename(&tmp, &dst));
    if outcome.is_err() {
        let _ = fs::remove_file(&tmp);
        return Err("암호화된 토큰 보관 파일을 저장하지 못했습니다.".into());
    }
    Ok(())
}

pub(crate) fn recover(home: &Path) -> Result<String, String> {
    let bytes = fs::read(path(home))
        .map_err(|_| "보관된 복사용 토큰이 없습니다. 기존 토큰을 직접 등록하거나 재발급하세요.")?;
    if bytes.len() > 4096 || bytes.is_empty() {
        return Err("암호화된 토큰 보관 파일이 유효하지 않습니다.".into());
    }
    let plaintext = crate::migration_backup::dpapi::decrypt(&bytes)?;
    let candidate = String::from_utf8(plaintext)
        .map_err(|_| "토큰 복원 데이터가 유효하지 않습니다.")?;
    if !matching_current_token(home, &candidate) {
        return Err("보관된 토큰이 현재 Owner Token과 일치하지 않습니다. 새 토큰을 등록해야 합니다.".into());
    }
    Ok(candidate)
}

pub(crate) fn available(home: &Path) -> bool { recover(home).is_ok() }

#[cfg(windows)]
mod clipboard {
    use std::ffi::c_void;
    use std::ptr;
    use std::thread;
    use std::time::Duration;

    const GMEM_MOVEABLE: u32 = 0x0002;
    const CF_UNICODETEXT: u32 = 13;
    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(window: *mut c_void) -> i32;
        fn EmptyClipboard() -> i32;
        fn SetClipboardData(format: u32, handle: *mut c_void) -> *mut c_void;
        fn CloseClipboard() -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalAlloc(flags: u32, bytes: usize) -> *mut c_void;
        fn GlobalLock(handle: *mut c_void) -> *mut c_void;
        fn GlobalUnlock(handle: *mut c_void) -> i32;
        fn GlobalFree(handle: *mut c_void) -> *mut c_void;
    }

    /// Native clipboard write: the token is never returned to JS/WebView.
    pub(super) fn set_token(token: &str) -> Result<(), String> {
        let wide: Vec<u16> = token.encode_utf16().chain(std::iter::once(0)).collect();
        let len = wide.len() * std::mem::size_of::<u16>();
        unsafe {
            let memory = GlobalAlloc(GMEM_MOVEABLE, len);
            if memory.is_null() { return Err("클립보드용 메모리를 확보하지 못했습니다.".into()); }
            let dest = GlobalLock(memory);
            if dest.is_null() {
                let _ = GlobalFree(memory);
                return Err("클립보드 메모리를 잠그지 못했습니다.".into());
            }
            ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, dest as *mut u8, len);
            let _ = GlobalUnlock(memory);
            for attempt in 0..5 {
                if OpenClipboard(ptr::null_mut()) != 0 {
                    if EmptyClipboard() == 0 || SetClipboardData(CF_UNICODETEXT, memory).is_null() {
                        let _ = CloseClipboard();
                        let _ = GlobalFree(memory);
                        return Err("클립보드에 토큰을 복사하지 못했습니다.".into());
                    }
                    let _ = CloseClipboard();
                    // Windows clipboard now owns the allocation.
                    return Ok(());
                }
                if attempt < 4 { thread::sleep(Duration::from_millis(40)); }
            }
            let _ = GlobalFree(memory);
            Err("클립보드가 다른 앱에서 사용 중입니다. 다시 시도하세요.".into())
        }
    }
}
#[cfg(not(windows))]
mod clipboard {
    pub(super) fn set_token(_: &str) -> Result<(), String> {
        Err("Owner Token 클립보드 복사는 Windows Tauri 앱에서만 지원합니다.".into())
    }
}
pub(crate) fn copy_to_clipboard(home: &Path) -> Result<(), String> {
    let token = recover(home)?;
    clipboard::set_token(&token)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn dpapi_vault_never_stores_plaintext_and_rejects_stale_or_wrong_token() {
        let home = std::env::temp_dir().join(format!(
            "c2c-vault-test-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let state = state_dir(&home);
        fs::create_dir_all(&state).unwrap();
        let token = "some-unique-user-token-value-123456";
        let hash = URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()));
        fs::write(state.join("owner-token.json"), format!(r#"{{"tokenHash":"{}"}}"#, hash)).unwrap();
        assert!(!available(&home));
        assert!(store(&home, "incorrect-user-token-value-123").is_err());
        store(&home, token).unwrap();
        assert!(available(&home));
        assert_eq!(recover(&home).unwrap(), token);
        assert!(!fs::read(path(&home)).unwrap().windows(token.len())
            .any(|window| window == token.as_bytes()));
        fs::write(state.join("owner-token.json"), r#"{"tokenHash":"different"}"#).unwrap();
        assert!(!available(&home));
        assert!(recover(&home).is_err());
        fs::remove_dir_all(home).unwrap();
    }
}
