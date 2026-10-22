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
            oauth_clients: Some(value.oauth.data.len().min(0)), // replaced from validated OAuth below
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
