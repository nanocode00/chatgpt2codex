//! Windows DPAPI, current-user-bound credential backup.
//! NEVER returns any owner-token/OAuth bytes to the WebView, logs or clipboard.
//! Does not restore to the live HOME, send process signals, or edit WinForms.
use crate::migration::{
    inspect_paths, legacy_state, os_paths, parse_ini, read_limited, MAX_SETTINGS_BYTES,
    MAX_STATE_BYTES, LEGACY_APP_DIR,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const FORMAT: &str = "c2c-legacy-credentials-dpapi-v1";
const MAGIC: &[u8] = b"C2C-DPAPI-1\n";
const ARCHIVE_NAME: &str = "legacy-auth-backup.dpapi";
const MAX_ARCHIVE_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialBackupReport {
    pub exists: bool,
    pub verified: bool,
    pub encrypted: bool,
    pub path: Option<String>,
    pub created_at_unix: Option<u64>,
    pub oauth_clients: Option<usize>,
    pub details: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupEntry {
    name: String,
    #[serde(with = "base64_bytes")]
    data: Vec<u8>,
    sha256: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupPayload {
    version: u8,
    format: String,
    created_at_unix: u64,
    owner: BackupEntry,
    oauth: BackupEntry,
    settings: BackupEntry,
    selected_project: Option<BackupEntry>,
}

mod base64_bytes {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&STANDARD.encode(bytes))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(deserializer)?;
        STANDARD.decode(text).map_err(serde::de::Error::custom)
    }
}

fn digest(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

fn secure_entry(name: &str, data: Vec<u8>) -> BackupEntry {
    let sha256 = digest(&data);
    BackupEntry { name: name.to_owned(), data, sha256 }
}

fn archive_path(preview: &Path) -> PathBuf {
    preview.join("migration").join(ARCHIVE_NAME)
}

fn check_owner(data: &[u8]) -> Result<(), String> {
    let record: serde_json::Value = serde_json::from_slice(data)
        .map_err(|_| "기존 Owner Token 기록을 확인하지 못했습니다.")?;
    let hash = record["tokenHash"].as_str().unwrap_or("");
    if record["version"] != 1 || record["createdAt"].as_u64().is_none() ||
        hash.len() != 43 ||
        !hash.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err("기존 Owner Token 기록 형식이 맞지 않습니다.".into());
    }
    Ok(())
}

fn check_oauth(data: &[u8]) -> Result<usize, String> {
    let record: serde_json::Value = serde_json::from_slice(data)
        .map_err(|_| "기존 OAuth 기록을 확인하지 못했습니다.")?;
    if record["version"] != 1 ||
        record["clients"].as_array().is_none() ||
        record["accessTokens"].as_array().is_none() ||
        record["refreshTokens"].as_array().is_none() {
        return Err("기존 OAuth 기록 형식이 맞지 않습니다.".into());
    }
    let clients = record["clients"].as_array().unwrap();
    if clients.len() > 10_000 {
        return Err("OAuth 클라이언트 기록이 예상 크기를 초과합니다.".into());
    }
    Ok(clients.len())
}

fn read_required(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    read_limited(path, limit)?.ok_or("백업할 필수 기존 파일을 찾지 못했습니다.".into())
}

fn read_optional(path: &Path, limit: u64) -> Result<Option<Vec<u8>>, String> {
    read_limited(path, limit)
}

fn required_stable(path: &Path, limit: u64, expected: &[u8]) -> Result<(), String> {
    let second = read_required(path, limit)?;
    if digest(expected) != digest(&second) {
        return Err("백업 중 기존 인증/설정 파일이 변경됐습니다. 나중에 다시 시도하세요.".into());
    }
    Ok(())
}

fn optional_stable(path: &Path, limit: u64, expected: &Option<Vec<u8>>) -> Result<(), String> {
    let second = read_optional(path, limit)?;
    if expected.as_ref().map(|v| digest(v)) != second.as_ref().map(|v| digest(v)) {
        return Err("백업 중 기존 프로젝트 선택 정보가 변경됐습니다.".into());
    }
    Ok(())
}

fn create_payload(local: &Path, profile: &Path, preview: &Path) -> Result<BackupPayload, String> {
    let preflight = inspect_paths(local, profile, preview)?;
    if !preflight.settings_found || !preflight.owner_hash_valid || !preflight.oauth_valid {
        return Err("기존 설정, Owner Token 해시와 OAuth 상태가 모두 확인돼야 백업할 수 있습니다.".into());
    }
    let settings_path = local.join(LEGACY_APP_DIR).join("settings.ini");
    let project_path = local.join(LEGACY_APP_DIR).join("selected-project.txt");
    let owner_path = legacy_state(profile, "owner-token.json");
    let oauth_path = legacy_state(profile, "oauth.json");
    let settings = read_required(&settings_path, MAX_SETTINGS_BYTES)?;
    let owner = read_required(&owner_path, MAX_SETTINGS_BYTES)?;
    let oauth = read_required(&oauth_path, MAX_STATE_BYTES)?;
    let selected_project = read_optional(&project_path, MAX_SETTINGS_BYTES)?;
    parse_ini(std::str::from_utf8(&settings).map_err(|_| "설정 인코딩 오류입니다.")?)?;
    check_owner(&owner)?;
    check_oauth(&oauth)?;
    // These extra reads detect concurrent OAuth/settings writes without
    // mutating or locking the WinForms service. This is NOT an atomic cutover.
    required_stable(&settings_path, MAX_SETTINGS_BYTES, &settings)?;
    required_stable(&owner_path, MAX_SETTINGS_BYTES, &owner)?;
    required_stable(&oauth_path, MAX_STATE_BYTES, &oauth)?;
    optional_stable(&project_path, MAX_SETTINGS_BYTES, &selected_project)?;
    let epoch = SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|_| "컴퓨터 시각을 확인할 수 없습니다.")?.as_secs();
    Ok(BackupPayload {
        version: 1,
        format: FORMAT.into(),
        created_at_unix: epoch,
        owner: secure_entry("owner-token.json", owner),
        oauth: secure_entry("oauth.json", oauth),
        settings: secure_entry("settings.ini", settings),
        selected_project: selected_project.map(|v| secure_entry("selected-project.txt", v)),
    })
}

fn validate_payload(payload: &BackupPayload) -> Result<usize, String> {
    if payload.version != 1 || payload.format != FORMAT {
        return Err("백업 파일의 버전이 일치하지 않습니다.".into());
    }
    for (entry, expected, limit) in [
        (&payload.owner, "owner-token.json", MAX_SETTINGS_BYTES),
        (&payload.oauth, "oauth.json", MAX_STATE_BYTES),
        (&payload.settings, "settings.ini", MAX_SETTINGS_BYTES),
    ] {
        if entry.name != expected || entry.data.len() as u64 > limit || digest(&entry.data) != entry.sha256 {
            return Err("백업 내부 파일 검증에 실패했습니다.".into());
        }
    }
    if let Some(project) = &payload.selected_project {
        if project.name != "selected-project.txt" ||
            project.data.len() as u64 > MAX_SETTINGS_BYTES || digest(&project.data) != project.sha256 {
            return Err("백업 프로젝트 경로 검증에 실패했습니다.".into());
        }
    }
    check_owner(&payload.owner.data)?;
    parse_ini(std::str::from_utf8(&payload.settings.data)
        .map_err(|_| "백업 설정의 인코딩 오류입니다.")?)?;
    check_oauth(&payload.oauth.data)
}

#[cfg(windows)]
mod dpapi {
    use std::ffi::c_void;
    use std::ptr;
    #[repr(C)]
    struct DataBlob { length: u32, data: *mut u8 }
    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(input: *const DataBlob, description: *const u16,
            entropy: *const DataBlob, reserved: *mut c_void, prompt: *mut c_void,
            flags: u32, output: *mut DataBlob) -> i32;
        fn CryptUnprotectData(input: *const DataBlob, description: *mut *mut u16,
            entropy: *const DataBlob, reserved: *mut c_void, prompt: *mut c_void,
            flags: u32, output: *mut DataBlob) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" { fn LocalFree(address: *mut c_void) -> *mut c_void; }

    fn convert(input: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
        if input.is_empty() || input.len() > 16 * 1024 * 1024 {
            return Err("DPAPI 입력 크기가 유효하지 않습니다.".into());
        }
        let in_blob = DataBlob { length: input.len() as u32, data: input.as_ptr() as *mut u8 };
        let mut out_blob = DataBlob { length: 0, data: ptr::null_mut() };
        // CRYPTPROTECT_UI_FORBIDDEN. Protected to Windows CURRENT USER only.
        let ok = unsafe {
            if encrypt {
                CryptProtectData(&in_blob, ptr::null(), ptr::null(), ptr::null_mut(),
                    ptr::null_mut(), 0x1, &mut out_blob)
            } else {
                CryptUnprotectData(&in_blob, ptr::null_mut(), ptr::null(), ptr::null_mut(),
                    ptr::null_mut(), 0x1, &mut out_blob)
            }
        };
        if ok == 0 {
            return Err("Windows DPAPI 인증정보 보호/복호화에 실패했습니다. 현재 Windows 사용자 계정인지 확인하세요.".into());
        }
        let bytes = unsafe {
            let data = std::slice::from_raw_parts(out_blob.data, out_blob.length as usize).to_vec();
            let _ = LocalFree(out_blob.data as *mut c_void);
            data
        };
        Ok(bytes)
    }
    pub(super) fn encrypt(input: &[u8]) -> Result<Vec<u8>, String> { convert(input, true) }
    pub(super) fn decrypt(input: &[u8]) -> Result<Vec<u8>, String> { convert(input, false) }
}

#[cfg(not(windows))]
mod dpapi {
    pub(super) fn encrypt(_: &[u8]) -> Result<Vec<u8>, String> {
        Err("Windows DPAPI 백업은 Windows에서만 지원합니다.".into())
    }
    pub(super) fn decrypt(_: &[u8]) -> Result<Vec<u8>, String> {
        Err("Windows DPAPI 백업은 Windows에서만 지원합니다.".into())
    }
}

fn encode_encrypted(payload: &BackupPayload) -> Result<Vec<u8>, String> {
    let plaintext = serde_json::to_vec(payload).map_err(|_| "백업 데이터를 직렬화하지 못했습니다.")?;
    let encrypted = dpapi::encrypt(&plaintext)?;
    let mut result = Vec::with_capacity(MAGIC.len() + encrypted.len());
    result.extend_from_slice(MAGIC);
    result.extend_from_slice(&encrypted);
    Ok(result)
}

fn decode_encrypted(contents: &[u8]) -> Result<BackupPayload, String> {
    let ciphertext = contents.strip_prefix(MAGIC)
        .ok_or("암호화 백업 파일이 아닙니다.")?;
    let plaintext = dpapi::decrypt(ciphertext)?;
    let payload: BackupPayload = serde_json::from_slice(&plaintext)
        .map_err(|_| "암호화 백업 내부 구조가 손상됐습니다.")?;
    validate_payload(&payload)?;
    Ok(payload)
}

fn report(backup: Option<(&Path, &BackupPayload)>) -> CredentialBackupReport {
    match backup {
        None => CredentialBackupReport {
            exists: false, verified: false, encrypted: false, path: None,
            created_at_unix: None, oauth_clients: None,
            details: "Windows 사용자 계정에 묶인 인증정보 백업이 아직 없습니다.".into(),
        },
        Some((path, value)) => CredentialBackupReport {
            exists: true, verified: true, encrypted: true,
            path: Some(path.to_string_lossy().into_owned()),
            created_at_unix: Some(value.created_at_unix),
            oauth_clients: None,
            details: "Windows DPAPI 복호화 및 내부 SHA-256/형식 검증에 통과했습니다. 원본 파일은 변경하지 않았습니다.".into(),
        },
    }
}

fn verified_report(path: &Path, payload: &BackupPayload) -> Result<CredentialBackupReport, String> {
    let clients = validate_payload(payload)?;
    let mut result = report(Some((path, payload)));
    result.oauth_clients = Some(clients);
    Ok(result)
}

fn inspect_backup(preview: &Path) -> Result<CredentialBackupReport, String> {
    let path = archive_path(preview);
    let Some(bytes) = read_limited(&path, MAX_ARCHIVE_BYTES)? else {
        return Ok(report(None));
    };
    let payload = decode_encrypted(&bytes)?;
    verified_report(&path, &payload)
}

fn save_backup(local: &Path, profile: &Path, preview: &Path) -> Result<CredentialBackupReport, String> {
    let dest = archive_path(preview);
    if dest.exists() {
        return Err("이미 인증정보 백업이 존재합니다. 기존 백업은 덮어쓰지 않습니다.".into());
    }
    let payload = create_payload(local, profile, preview)?;
    validate_payload(&payload)?;
    let encrypted = encode_encrypted(&payload)?;
    if encrypted.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err("암호화된 백업 파일이 예상 크기를 초과합니다.".into());
    }
    fs::create_dir_all(dest.parent().ok_or("백업 디렉터리가 유효하지 않습니다.")?)
        .map_err(|_| "백업 디렉터리를 만들 수 없습니다.")?;
    let mut file = OpenOptions::new().write(true).create_new(true).open(&dest)
        .map_err(|_| "기존 백업을 덮어쓰지 않고 새 백업을 만들 수 없습니다.")?;
    let written = file.write_all(&encrypted).and_then(|_| file.sync_all());
    drop(file);
    if written.is_err() {
        let _ = fs::remove_file(&dest);
        return Err("암호화 백업을 기록하지 못했습니다.".into());
    }
    let checked = inspect_backup(preview);
    if checked.is_err() {
        // Only remove the newly created file; never any pre-existing archive.
        let _ = fs::remove_file(&dest);
    }
    checked
}

#[tauri::command]
pub async fn inspect_credential_backup() -> Result<CredentialBackupReport, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (_, _, preview) = os_paths()?;
        inspect_backup(&preview)
    }).await.map_err(|_| "인증정보 백업 검사 실패".to_string())?
}

#[tauri::command]
pub async fn create_credential_backup() -> Result<CredentialBackupReport, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (local, profile, preview) = os_paths()?;
        save_backup(&local, &profile, &preview)
    }).await.map_err(|_| "인증정보 백업 생성 실패".to_string())?
}


/// Outcome metadata only: no decrypted Owner Token hashes, OAuth credentials,
/// client identifiers, settings contents, or absolute source paths leave Rust.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreRehearsalReport {
    pub passed: bool,
    pub restored_files: usize,
    pub oauth_clients: usize,
    pub original_files_modified: bool,
    pub temporary_directory_retained: bool,
    pub details: String,
}

struct EncryptedDrillDirectory {
    path: PathBuf,
}

impl Drop for EncryptedDrillDirectory {
    fn drop(&mut self) {
        // This directory contains only *DPAPI-encrypted* shadow copies.
        // If the process crashes, no plaintext credentials remain on disk.
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn drill_root(preview: &Path) -> Result<EncryptedDrillDirectory, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NONCE: AtomicU64 = AtomicU64::new(0);

    let parent = preview.join("migration").join("restore-drills");
    fs::create_dir_all(&parent)
        .map_err(|_| "격리 복원 디렉터리를 준비하지 못했습니다.")?;
    // Deny the simplest preexisting symlink/junction substitution.
    if fs::symlink_metadata(&parent).map_err(|_| "격리 복원 경로를 확인하지 못했습니다.")?.file_type().is_symlink() {
        return Err("격리 복원 폴더가 링크이므로 안전하게 사용할 수 없습니다.".into());
    }
    for _ in 0..8 {
        let since_epoch = SystemTime::now().duration_since(UNIX_EPOCH)
            .map_err(|_| "시스템 시간이 유효하지 않습니다.")?;
        let unique = format!("drill-{}-{}-{}", std::process::id(),
            since_epoch.as_nanos(), NONCE.fetch_add(1, Ordering::Relaxed));
        let path = parent.join(unique);
        match fs::create_dir(&path) {
            Ok(()) => return Ok(EncryptedDrillDirectory { path }),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("격리 복원 작업 공간을 만들지 못했습니다.".into()),
        }
    }
    Err("중복되지 않는 격리 복원 경로를 확보하지 못했습니다.".into())
}

/// Write the restored entry as DPAPI-protected ciphertext in a *dedicated*
/// fixture file, read it back, decrypt in memory, and verify its bytes/hash.
/// Never write a plaintext OAuth or owner-token file even temporarily.
fn shadow_restore_one(dir: &Path, entry: &BackupEntry) -> Result<(), String> {
    let (safe_filename, bound) = match entry.name.as_str() {
        "owner-token.json" => ("owner-token.shadow.dpapi", MAX_SETTINGS_BYTES),
        "oauth.json" => ("oauth.shadow.dpapi", MAX_STATE_BYTES),
        "settings.ini" => ("settings.shadow.dpapi", MAX_SETTINGS_BYTES),
        "selected-project.txt" => ("selected-project.shadow.dpapi", MAX_SETTINGS_BYTES),
        _ => return Err("허용되지 않은 복원 파일명입니다.".into()),
    };
    if entry.data.len() as u64 > bound || digest(&entry.data) != entry.sha256 {
        return Err("복원 파일의 체크섬 또는 크기가 일치하지 않습니다.".into());
    }
    // Non-empty, filename-bound frame also handles an optional empty
    // selected-project file. Never place the framed plaintext on disk.
    let prefix = format!("C2C-RESTORE-SHADOW:{}\\n", entry.name);
    let mut framed = prefix.as_bytes().to_vec();
    framed.extend_from_slice(&entry.data);
    let protected = dpapi::encrypt(&framed)?;
    let path = dir.join(safe_filename);
    let mut file = OpenOptions::new().write(true).create_new(true).open(&path)
        .map_err(|_| "격리된 암호화 복원 파일을 생성하지 못했습니다.")?;
    file.write_all(&protected).and_then(|_| file.sync_all())
        .map_err(|_| "암호화 복원 파일을 기록하지 못했습니다.")?;
    drop(file);
    let reread = read_limited(&path, bound + 4096)?
        .ok_or("격리 복원 파일을 다시 열지 못했습니다.")?;
    if reread != protected {
        return Err("격리 복원 파일이 기록 중 변경됐습니다.".into());
    }
    let framed = dpapi::decrypt(&reread)?;
    let restored = framed.strip_prefix(prefix.as_bytes())
        .ok_or("격리 복원 파일 이름의 무결성이 일치하지 않습니다.")?;
    if restored.len() != entry.data.len() || digest(restored) != entry.sha256 {
        return Err("복원 파일을 복호화한 결과가 원본 백업과 다릅니다.".into());
    }
    Ok(())
}

fn restore_rehearsal_from_archive(preview: &Path) -> Result<RestoreRehearsalReport, String> {
    // Does not access live WinForms sources. Any subsequent updates to
    // oauth.json after the snapshot are explicitly out of scope.
    let bytes = read_limited(&archive_path(preview), MAX_ARCHIVE_BYTES)?
        .ok_or("복원할 암호화 인증정보 백업을 찾지 못했습니다.")?;
    let payload = decode_encrypted(&bytes)?;
    let clients = validate_payload(&payload)?;
    let temporary = drill_root(preview)?;

    shadow_restore_one(&temporary.path, &payload.owner)?;
    shadow_restore_one(&temporary.path, &payload.oauth)?;
    shadow_restore_one(&temporary.path, &payload.settings)?;
    let mut count = 3;
    if let Some(project) = &payload.selected_project {
        shadow_restore_one(&temporary.path, project)?;
        count += 1;
    }

    // Existing serialized backup validates format once more after a complete
    // encrypted write/read roundtrip; nothing is imported into live CLI.
    validate_payload(&payload)?;
    let completed_dir = temporary.path.clone();
    drop(temporary); // best-effort cleanup, then verify before success
    if completed_dir.exists() {
        return Err("격리 복원 임시 파일을 정리하지 못했습니다. 별도 임시 폴더를 점검해야 합니다.".into());
    }

    Ok(RestoreRehearsalReport {
        passed: true,
        restored_files: count,
        oauth_clients: clients,
        original_files_modified: false,
        temporary_directory_retained: false,
        details: "격리된 임시 폴더에 DPAPI 암호화 파일을 복원한 뒤 다시 읽고 해시·형식을 확인했습니다. 평문 인증 파일은 디스크에 쓰지 않았으며 기존 WinForms 및 MCP 설정을 변경하지 않았습니다.".into(),
    })
}

#[tauri::command]
pub async fn rehearse_credential_restore() -> Result<RestoreRehearsalReport, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (_, _, preview) = os_paths()?;
        restore_rehearsal_from_archive(&preview)
    }).await.map_err(|_| "인증정보 격리 복원 리허설 작업이 실패했습니다.".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(base: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let local = base.join("local");
        let profile = base.join("profile");
        let preview = base.join("preview");
        fs::create_dir_all(local.join(LEGACY_APP_DIR)).unwrap();
        let state = legacy_state(&profile, "owner-token.json");
        fs::create_dir_all(state.parent().unwrap()).unwrap();
        fs::write(local.join(LEGACY_APP_DIR).join("settings.ini"), "Port=Nzk3OQ==\nEnablePublicTunnel=dHJ1ZQ==\n").unwrap();
        fs::write(&state, format!("{{\"version\":1,\"createdAt\":123,\"tokenHash\":\"{}\"}}", "A".repeat(43))).unwrap();
        fs::write(legacy_state(&profile, "oauth.json"),
            "{\"version\":1,\"clients\":[{\"clientId\":\"secret-fixture-client\"}],\"accessTokens\":[],\"refreshTokens\":[]}").unwrap();
        (local, profile, preview)
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_encrypts_verifies_without_plaintext_or_live_mutations() {
        let root = std::env::temp_dir().join(format!("c2c-auth-backup-{}", std::process::id()));
        if root.exists() { fs::remove_dir_all(&root).unwrap(); }
        let (local, profile, preview) = fixture(&root);
        let source = legacy_state(&profile, "oauth.json");
        let original = fs::read(&source).unwrap();
        let result = save_backup(&local, &profile, &preview).unwrap();
        assert!(result.exists && result.verified && result.encrypted);
        assert_eq!(result.oauth_clients, Some(1));
        let archive = fs::read(archive_path(&preview)).unwrap();
        assert!(archive.starts_with(MAGIC));
        assert!(!String::from_utf8_lossy(&archive).contains("secret-fixture-client"));
        assert!(!String::from_utf8_lossy(&archive).contains("Port=Nzk3OQ=="));
        assert_eq!(fs::read(source).unwrap(), original);
        let verified = inspect_backup(&preview).unwrap();
        assert!(verified.verified);
        assert!(save_backup(&local, &profile, &preview).is_err());
        let mut tampered = archive.clone();
        *tampered.last_mut().unwrap() ^= 0x41;
        fs::write(archive_path(&preview), tampered).unwrap();
        assert!(inspect_backup(&preview).is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn encrypted_shadow_restore_isolated_and_cleaned_without_live_writes() {
        let root = std::env::temp_dir().join(format!("c2c-restore-drill-{}", std::process::id()));
        if root.exists() { fs::remove_dir_all(&root).unwrap(); }
        let (local, profile, preview) = fixture(&root);
        let original_oauth = fs::read(legacy_state(&profile, "oauth.json")).unwrap();
        let original_owner = fs::read(legacy_state(&profile, "owner-token.json")).unwrap();
        let original_settings = fs::read(local.join(LEGACY_APP_DIR).join("settings.ini")).unwrap();

        save_backup(&local, &profile, &preview).unwrap();
        // An independent, encrypted file read/decrypt/restore roundtrip.
        let report = restore_rehearsal_from_archive(&preview).unwrap();
        assert!(report.passed);
        assert_eq!(report.restored_files, 3);
        assert_eq!(report.oauth_clients, 1);
        assert!(!report.original_files_modified);
        assert!(!report.temporary_directory_retained);
        let drill_base = preview.join("migration").join("restore-drills");
        assert_eq!(fs::read_dir(&drill_base).unwrap().count(), 0);
        assert_eq!(fs::read(legacy_state(&profile, "oauth.json")).unwrap(), original_oauth);
        assert_eq!(fs::read(legacy_state(&profile, "owner-token.json")).unwrap(), original_owner);
        assert_eq!(fs::read(local.join(LEGACY_APP_DIR).join("settings.ini")).unwrap(), original_settings);
        // The first archive also remains valid and unchanged.
        assert!(inspect_backup(&preview).unwrap().verified);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn tampered_archive_refuses_restore_and_does_not_create_shadow_dir() {
        let root = std::env::temp_dir().join(format!("c2c-restore-deny-{}", std::process::id()));
        if root.exists() { fs::remove_dir_all(&root).unwrap(); }
        let (local, profile, preview) = fixture(&root);
        save_backup(&local, &profile, &preview).unwrap();
        let archive_path = archive_path(&preview);
        let mut archive = fs::read(&archive_path).unwrap();
        *archive.last_mut().unwrap() ^= 0x1b;
        fs::write(archive_path, archive).unwrap();
        assert!(restore_rehearsal_from_archive(&preview).is_err());
        assert!(!preview.join("migration").join("restore-drills").exists());
        assert!(legacy_state(&profile, "oauth.json").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn shadow_filename_allowlist_rejects_traversal_and_mismatched_digest() {
        let root = std::env::temp_dir().join(format!("c2c-restore-path-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let mut record = secure_entry("../owner-token.json", b"secret-fixture".to_vec());
        assert!(shadow_restore_one(&root, &record).is_err());
        record.name = "owner-token.json".into();
        record.sha256 = "forged".into();
        assert!(shadow_restore_one(&root, &record).is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn no_live_restore_and_all_entries_are_hashed() {
        let sample = BackupPayload {
            version: 1, format: FORMAT.into(), created_at_unix: 10,
            owner: secure_entry("owner-token.json", b"fake".to_vec()),
            oauth: secure_entry("oauth.json", b"fake".to_vec()),
            settings: secure_entry("settings.ini", b"fake".to_vec()),
            selected_project: None,
        };
        assert!(validate_payload(&sample).is_err());
        assert_eq!(ARCHIVE_NAME, "legacy-auth-backup.dpapi");
    }
}

// F3 release gate: synthetic credentials only, never the real archived OAuth
// state. The real archived owner record contains a HASH, not the bearer secret.
// Running this test outside an ephemeral Windows CI runner is intentionally a
// no-op, so it cannot accidentally spawn a CLI against a user's real profile.
#[cfg(all(test, windows))]
mod fixture_cli_restore_e2e {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use serde_json::json;
    use std::net::{Ipv4Addr, TcpListener};
    use std::process::{Child, Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    struct Sandbox {
        path: PathBuf,
        child: Option<Child>,
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            if let Some(child) = self.child.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn new_ci_sandbox() -> Option<Sandbox> {
        if std::env::var("GITHUB_ACTIONS").ok().as_deref() != Some("true") ||
            std::env::var("CI").ok().as_deref() != Some("true") ||
            std::env::var("C2C_F3_E2E").ok().as_deref() != Some("true") {
            return None;
        }
        let base = PathBuf::from(std::env::var_os("RUNNER_TEMP")?);
        let meta = fs::symlink_metadata(&base).expect("CI runner temp is missing");
        assert!(meta.is_dir() && !meta.file_type().is_symlink());
        let unique = format!("c2c-f3-private-{}-{}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos());
        let path = base.join(unique);
        fs::create_dir(&path).expect("create new CI-only fixture sandbox");
        Some(Sandbox { path, child: None })
    }

    // Restrict the directory BEFORE materializing any plaintext fixture. ACLs
    // must not be inherited from a runner's more permissive temp directory.
    fn enforce_private_acl(home: &Path, verify_only: bool) {
        const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$path = $env:C2C_F3_HOME
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
if ($env:C2C_F3_VERIFY_ONLY -ne 'true') {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($who in @($me, $system)) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($who, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $path -AclObject $acl
}
$items = @($path) + @(Get-ChildItem -LiteralPath $path -Recurse -Force | ForEach-Object FullName)
foreach ($item in $items) {
    $acl = Get-Acl -LiteralPath $item
    if ($item -eq $path -and -not $acl.AreAccessRulesProtected) { throw 'Inherited ACL on fixture home' }
    foreach ($ace in $acl.Access) {
        if ($ace.AccessControlType -ne 'Allow') { continue }
        $sid = $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if ($sid -ne $me.Value -and $sid -ne $system.Value) {
            throw 'Fixture ACL grants another identity access'
        }
    }
}
"#;
        let status = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
            .env("C2C_F3_HOME", home)
            .env("C2C_F3_VERIFY_ONLY", if verify_only { "true" } else { "false" })
            .stdout(Stdio::null()).stderr(Stdio::null())
            .status().expect("Windows ACL tool unavailable");
        assert!(status.success(), "fixture home/files must be owner-and-SYSTEM only");
    }

    fn restored_fixture_file(path: &Path, entry: &BackupEntry) {
        assert_eq!(digest(&entry.data), entry.sha256);
        let mut file = OpenOptions::new().write(true).create_new(true)
            .open(path).expect("create fresh isolated fixture entry");
        file.write_all(&entry.data).expect("write verified fixture bytes");
        file.sync_all().expect("persist isolated fixture bytes");
        assert_eq!(digest(&fs::read(path).unwrap()), entry.sha256);
    }

    #[test]
    fn encrypted_fixture_restores_to_disposable_cli_and_authenticates() {
        let Some(mut sandbox) = new_ci_sandbox() else { return };
        let (local, source_profile, archive_preview) = (
            sandbox.path.join("source-local"), sandbox.path.join("source-profile"),
            sandbox.path.join("archive-preview"),
        );
        let home = sandbox.path.join("disposable-cli-home");
        let workspace = sandbox.path.join("workspace");
        fs::create_dir(&home).unwrap();
        enforce_private_acl(&home, false);
        fs::create_dir(&workspace).unwrap();
        fs::write(workspace.join("package.json"), "{\"private\":true,\"name\":\"c2c-f3-ci-fixture\"}").unwrap();

        let socket = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        assert!(port > 1024 && port != 7979 && port != 18797);
        drop(socket);
        let resource = format!("http://127.0.0.1:{port}/mcp");
        let bearer = "ci-f3-disposable-owner-bearer-not-a-real-credential";
        let oauth_token = "ci-f3-disposable-oauth-access-not-a-real-credential";
        let b64hash = |v: &str| URL_SAFE_NO_PAD.encode(Sha256::digest(v.as_bytes()));
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();

        fs::create_dir_all(local.join(LEGACY_APP_DIR)).unwrap();
        fs::create_dir_all(legacy_state(&source_profile, "oauth.json").parent().unwrap()).unwrap();
        fs::write(local.join(LEGACY_APP_DIR).join("settings.ini"), "Port=Nzk3OQ==\nEnablePublicTunnel=ZmFsc2U=\n").unwrap();
        let owner = serde_json::to_vec(&json!({"version":1,"createdAt":now,"tokenHash":b64hash(bearer)})).unwrap();
        let oauth = serde_json::to_vec(&json!({
            "version":1,"updatedAt":now*1000,
            "clients":[{"clientId":"ci-f3-client","clientJson":{
                "client_id":"ci-f3-client","redirect_uris":["http://127.0.0.1/callback"],
                "token_endpoint_auth_method":"none", "grant_types":["authorization_code"],
                "response_types":["code"]},"issuedAt":now}],
            "accessTokens":[{"tokenHash":b64hash(oauth_token),"clientId":"ci-f3-client",
                "scopes":["chatgpt2codex"],"expiresAt":now+3600,"resource":resource}],
            "refreshTokens":[]
        })).unwrap();
        fs::write(legacy_state(&source_profile, "owner-token.json"), &owner).unwrap();
        fs::write(legacy_state(&source_profile, "oauth.json"), &oauth).unwrap();
        save_backup(&local, &source_profile, &archive_preview).unwrap();
        let archive_before = fs::read(archive_path(&archive_preview)).unwrap();
        let payload = decode_encrypted(&archive_before).unwrap();
        assert_eq!(validate_payload(&payload).unwrap(), 1);

        let state = legacy_state(&home, "owner-token.json");
        fs::create_dir_all(state.parent().unwrap()).unwrap();
        restored_fixture_file(&state, &payload.owner);
        restored_fixture_file(&legacy_state(&home, "oauth.json"), &payload.oauth);
        restored_fixture_file(&home.join("settings.ini"), &payload.settings);
        enforce_private_acl(&home, true);
        assert_eq!(fs::read(legacy_state(&source_profile,"oauth.json")).unwrap(), oauth);
        assert_eq!(fs::read(legacy_state(&source_profile,"owner-token.json")).unwrap(), owner);
        assert_eq!(fs::read(archive_path(&archive_preview)).unwrap(), archive_before);

        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap();
        let cli = repo.join("dist").join("cli.js");
        assert!(cli.is_file(), "CI must build the actual CLI before F3 E2E");
        let mut proc = Command::new("node");
        proc.arg(cli).args(["serve", "--http", "--host", "127.0.0.1", "--port", &port.to_string(),
            "--workspace", workspace.to_str().unwrap(), "--instance", "f3-private-restore",
            "--public-url", &format!("http://127.0.0.1:{port}")]);
        proc.current_dir(&workspace).env_clear();
        for key in ["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) { proc.env(key, value); }
        }
        proc.env("HOME", &home).env("USERPROFILE", &home)
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .stdout(Stdio::null()).stderr(Stdio::null());
        sandbox.child = Some(proc.spawn().expect("launch isolated CI fixture CLI"));

        let base = format!("http://127.0.0.1:{port}");
        let deadline = Instant::now() + Duration::from_secs(16);
        loop {
            assert!(sandbox.child.as_mut().unwrap().try_wait().unwrap().is_none(), "isolated CLI exited early");
            if ureq::get(&format!("{base}/healthz")).timeout(Duration::from_secs(1))
                .call().is_ok() { break; }
            assert!(Instant::now() < deadline, "isolated CLI health timed out");
            thread::sleep(Duration::from_millis(150));
        }
        let action = format!("{base}/actions/agent-guide");
        assert!(matches!(ureq::post(&action).send_json(json!({})), Err(ureq::Error::Status(401, _))));
        assert!(matches!(ureq::post(&action).set("authorization", "Bearer invalid-fixture")
            .send_json(json!({})), Err(ureq::Error::Status(401, _))));
        assert!(ureq::post(&action).set("authorization", &format!("Bearer {bearer}"))
            .send_json(json!({})).is_ok(), "restored owner hash must authenticate");
        let mcp = format!("{base}/mcp");
        let request = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2025-06-18","capabilities":{},
            "clientInfo":{"name":"c2c-f3-fixture","version":"1.0"}}});
        assert!(matches!(ureq::post(&mcp).set("accept", "application/json, text/event-stream")
            .send_json(request.clone()), Err(ureq::Error::Status(401, _))));
        let authorized = ureq::post(&mcp).set("authorization", &format!("Bearer {oauth_token}"))
            .set("accept", "application/json, text/event-stream")
            .send_json(request).expect("restored OAuth hash must authorize isolated MCP");
        assert!(authorized.status() < 300);
        assert_eq!(fs::read(archive_path(&archive_preview)).unwrap(), archive_before);
        assert_eq!(fs::read(legacy_state(&source_profile,"oauth.json")).unwrap(), oauth);
        assert_eq!(fs::read(legacy_state(&source_profile,"owner-token.json")).unwrap(), owner);
    }
}
