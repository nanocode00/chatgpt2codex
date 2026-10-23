use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_SETTINGS_BYTES: u64 = 128 * 1024;
const MAX_STATE_BYTES: u64 = 4 * 1024 * 1024;
const LEGACY_APP_DIR: &str = "ChatGPT To Codex";
const PREVIEW_APP_DIR: &str = "ChatGPTToCodex-Tauri-Preview";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationReport {
    pub source_found: bool,
    pub settings_found: bool,
    pub selected_project: Option<String>,
    pub project_exists: bool,
    pub port: Option<u16>,
    pub tunnel_enabled: Option<bool>,
    pub custom_hostname_configured: bool,
    pub launch_at_startup: Option<bool>,
    pub start_mcp_on_open: Option<bool>,
    pub auto_check_updates: Option<bool>,
    pub language: Option<String>,
    pub owner_hash_valid: bool,
    pub oauth_valid: bool,
    pub oauth_client_count: Option<usize>,
    pub runtime_record_found: bool,
    pub local_port_listening: bool,
    pub can_transition_now: bool,
    pub snapshot_saved: bool,
    pub snapshot_path: Option<String>,
    pub warnings: Vec<String>,
}

fn read_limited(path: &Path, limit: u64) -> Result<Option<Vec<u8>>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("이전 설정 파일을 읽을 수 없습니다.".into()),
    };
    let metadata = file.metadata().map_err(|_| "설정 파일 크기를 확인하지 못했습니다.")?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err("설정 또는 인증 기록이 허용된 크기를 초과합니다.".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)
        .map_err(|_| "설정 파일 읽기에 실패했습니다.")?;
    if bytes.len() as u64 > limit {
        return Err("설정 또는 인증 기록이 허용된 크기를 초과합니다.".into());
    }
    Ok(Some(bytes))
}

fn base64_value(raw: &str) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let data = STANDARD.decode(raw.trim()).map_err(|_| "이전 설정의 Base64 형식이 올바르지 않습니다.")?;
    if data.len() > 32 * 1024 {
        return Err("이전 설정값이 예상 크기를 초과합니다.".into());
    }
    String::from_utf8(data).map_err(|_| "이전 설정의 UTF-8 인코딩이 잘못됐습니다.".into())
}

fn parse_ini(text: &str) -> Result<BTreeMap<String, String>, String> {
    const ALLOWED: [&str; 10] = [
        "ProjectFolder", "Port", "PublicHostname", "EnablePublicTunnel",
        "LaunchAtStartup", "StartMcpOnOpen", "AutoCheckUpdates",
        "GitHubRepoUrl", "Language", "LastConnectorUrl",
    ];
    let mut result = BTreeMap::new();
    for line in text.trim_start_matches('\u{feff}').lines() {
        let Some((key, value)) = line.split_once('=') else { continue; };
        if !ALLOWED.contains(&key) { continue; }
        if result.contains_key(key) {
            return Err("중복된 이전 런처 설정 항목이 있습니다.".into());
        }
        result.insert(key.to_string(), base64_value(value)?);
    }
    Ok(result)
}

fn bool_option(values: &BTreeMap<String, String>, key: &str) -> Option<bool> {
    values.get(key).map(|v| ["1", "true", "yes"].contains(&v.trim().to_ascii_lowercase().as_str()))
}

fn legacy_state(user_profile: &Path, filename: &str) -> PathBuf {
    user_profile.join(".local").join("share").join("chatgpt2codex").join(filename)
}

fn owner_hash_record_valid(user_profile: &Path) -> Result<bool, String> {
    let Some(bytes) = read_limited(&legacy_state(user_profile, "owner-token.json"), MAX_SETTINGS_BYTES)? else {
        return Ok(false);
    };
    let Ok(data) = serde_json::from_slice::<serde_json::Value>(&bytes) else { return Ok(false); };
    let Some(hash) = data["tokenHash"].as_str() else { return Ok(false); };
    Ok(data["version"] == 1
        && data["createdAt"].as_u64().is_some()
        && hash.len() == 43
        && hash.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
}

fn oauth_summary(user_profile: &Path) -> Result<(bool, Option<usize>), String> {
    let Some(bytes) = read_limited(&legacy_state(user_profile, "oauth.json"), MAX_STATE_BYTES)? else {
        return Ok((false, None));
    };
    let Ok(data) = serde_json::from_slice::<serde_json::Value>(&bytes) else { return Ok((false, None)); };
    let (Some(clients), Some(access), Some(refresh)) = (
        data["clients"].as_array(),
        data["accessTokens"].as_array(),
        data["refreshTokens"].as_array()
    ) else { return Ok((false, None)); };
    if data["version"] != 1 { return Ok((false, None)); }
    // Never return, log, copy, or serialize OAuth client/token contents.
    if access.len() > 100_000 || refresh.len() > 100_000 {
        return Ok((false, None));
    }
    Ok((true, Some(clients.len())))
}

fn is_listening(port: u16) -> bool {
    TcpStream::connect_timeout(
        &SocketAddrV4::new(Ipv4Addr::LOCALHOST, port).into(),
        Duration::from_millis(280),
    ).is_ok()
}

fn inspect_paths(local: &Path, profile: &Path, preview: &Path) -> Result<LegacyMigrationReport, String> {
    let legacy_dir = local.join(LEGACY_APP_DIR);
    let settings_bytes = read_limited(&legacy_dir.join("settings.ini"), MAX_SETTINGS_BYTES)?;
    let settings_found = settings_bytes.is_some();
    let settings = match settings_bytes {
        Some(data) => parse_ini(&String::from_utf8(data).map_err(|_| "이전 settings.ini 인코딩이 잘못됐습니다.")?)?,
        None => BTreeMap::new(),
    };
    let project = settings.get("ProjectFolder").filter(|v| !v.trim().is_empty()).cloned()
        .or_else(|| read_limited(&legacy_dir.join("selected-project.txt"), MAX_SETTINGS_BYTES).ok().flatten()
            .and_then(|v| String::from_utf8(v).ok())
            .map(|s| s.trim_start_matches('\u{feff}').trim().to_string())
            .filter(|v| !v.is_empty()));
    let project_exists = project.as_ref().is_some_and(|s| Path::new(s).is_dir());
    let port = settings.get("Port").and_then(|s| s.parse::<u16>().ok()).filter(|p| *p > 0);
    let legacy_port = port.unwrap_or(7979);
    let owner_hash_valid = owner_hash_record_valid(profile)?;
    let (oauth_valid, oauth_client_count) = oauth_summary(profile)?;
    let runtime_record_found = legacy_state(profile, "runtime/default.json").is_file();
    let local_port_listening = is_listening(legacy_port);
    let mut warnings = Vec::new();
    if !settings_found { warnings.push("기존 WinForms settings.ini를 찾지 못했습니다.".to_string()); }
    if !owner_hash_valid { warnings.push("기존 Owner Token 해시가 없거나 유효성을 확인하지 못했습니다.".to_string()); }
    if !oauth_valid { warnings.push("이전 OAuth 상태가 없거나 유효성을 확인하지 못했습니다.".to_string()); }
    if local_port_listening { warnings.push("기존 MCP 포트가 사용 중입니다. 실행 중인 프로세스를 자동으로 종료하지 않습니다.".to_string()); }
    if !project_exists && project.is_some() {
        warnings.push("이전 설정에 기록된 프로젝트 경로가 현재 존재하지 않습니다.".into());
    }
    if runtime_record_found {
        warnings.push("기존 default 인스턴스 PID 기록은 Tauri 소유권의 증거로 사용할 수 없습니다.".into());
    }
    warnings.push("전환 사전 점검만 수행했습니다. Owner Token·OAuth·설정은 복사하거나 변경하지 않았습니다.".into());
    let snapshot = preview.join("migration").join("settings-snapshot.json");
    Ok(LegacyMigrationReport {
        source_found: legacy_dir.is_dir() || owner_hash_valid || oauth_valid,
        settings_found,
        selected_project: project,
        project_exists,
        port,
        tunnel_enabled: bool_option(&settings, "EnablePublicTunnel"),
        custom_hostname_configured: settings.get("PublicHostname").is_some_and(|s| !s.trim().is_empty()),
        launch_at_startup: bool_option(&settings, "LaunchAtStartup"),
        start_mcp_on_open: bool_option(&settings, "StartMcpOnOpen"),
        auto_check_updates: bool_option(&settings, "AutoCheckUpdates"),
        language: settings.get("Language").cloned(),
        owner_hash_valid,
        oauth_valid,
        oauth_client_count,
        runtime_record_found,
        local_port_listening,
        can_transition_now: false, // Explicitly not safe to switch during preflight.
        snapshot_saved: snapshot.is_file(),
        snapshot_path: if snapshot.is_file() { Some(snapshot.to_string_lossy().into_owned()) } else { None },
        warnings,
    })
}

fn os_paths() -> Result<(PathBuf, PathBuf, PathBuf), String> {
    if !cfg!(windows) { return Err("WinForms 마이그레이션은 Windows에서만 지원합니다.".into()); }
    let local = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA를 찾지 못했습니다.")?);
    let profile = PathBuf::from(std::env::var_os("USERPROFILE").ok_or("USERPROFILE을 찾지 못했습니다.")?);
    let preview = local.join(PREVIEW_APP_DIR);
    Ok((local, profile, preview))
}

#[tauri::command]
pub async fn inspect_legacy_migration() -> Result<LegacyMigrationReport, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (local, profile, preview) = os_paths()?;
        inspect_paths(&local, &profile, &preview)
    }).await.map_err(|_| "마이그레이션 사전 점검에 실패했습니다.".to_owned())?
}

/// An opt-in NON-SECRET settings snapshot, *not* an authentication backup.
/// No WinForms source file is modified, moved, or deleted by this action.
#[tauri::command]
pub async fn save_legacy_settings_snapshot() -> Result<LegacyMigrationReport, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (local, profile, preview) = os_paths()?;
        let report = inspect_paths(&local, &profile, &preview)?;
        if !report.source_found || !report.settings_found {
            return Err("원본 WinForms 설정을 찾지 못해 스냅샷을 만들 수 없습니다.".into());
        }
        let dest = preview.join("migration");
        fs::create_dir_all(&dest).map_err(|_| "스냅샷 폴더를 만들 수 없습니다.")?;
        let path = dest.join("settings-snapshot.json");
        if path.exists() {
            // Never overwrite any prior snapshot or its rollback reference.
            return Err("이미 설정 스냅샷이 있습니다. 기존 기록을 덮어쓰지 않습니다.".into());
        }
        let epoch = SystemTime::now().duration_since(UNIX_EPOCH)
            .map_err(|_| "시스템 시각 오류입니다.")?.as_secs();
        let content = serde_json::json!({
            "version": 1,
            "createdAtUnix": epoch,
            "kind": "non-secret-winforms-settings-snapshot",
            "project": report.selected_project,
            "port": report.port,
            "publicTunnelEnabled": report.tunnel_enabled,
            "customHostnameConfigured": report.custom_hostname_configured,
            "language": report.language,
            "launchAtStartup": report.launch_at_startup,
            "startMcpOnOpen": report.start_mcp_on_open,
            "autoCheckUpdates": report.auto_check_updates,
            "containsSecrets": false,
            "containsOAuth": false,
            "isRollbackBackup": false
        });
        let bytes = serde_json::to_vec_pretty(&content)
            .map_err(|_| "스냅샷 직렬화에 실패했습니다.")?;
        // create_new prevents accidental overwrite and avoids manipulating
        // any previous migration artifact; the source remains read-only.
        let mut file = fs::OpenOptions::new()
            .write(true).create_new(true).open(&path)
            .map_err(|_| "스냅샷을 안전하게 만들 수 없습니다.")?;
        file.write_all(&bytes).map_err(|_| "스냅샷을 기록할 수 없습니다.")?;
        inspect_paths(&local, &profile, &preview)
    }).await.map_err(|_| "마이그레이션 스냅샷 작업이 실패했습니다.".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_winforms_base64_settings_with_embedded_equals() {
        let port = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, "7979");
        let project = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, "C:\\project=one");
        let ini = format!("Port={port}\nProjectFolder={project}\n");
        let parsed = parse_ini(&ini).unwrap();
        assert_eq!(parsed["Port"], "7979");
        assert_eq!(parsed["ProjectFolder"], "C:\\project=one");
        assert!(parse_ini(&format!("{ini}Port={port}\n")).is_err());
        assert!(parse_ini("Port=%%%").is_err());
    }

    #[test]
    fn never_copies_oauth_or_claims_live_takeover() {
        let root = std::env::temp_dir().join(format!("c2c-migration-test-{}", std::process::id()));
        let local = root.join("local");
        let profile = root.join("profile");
        let preview = root.join("preview");
        let legacy = local.join(LEGACY_APP_DIR);
        let state = legacy_state(&profile, "owner-token.json");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(state.parent().unwrap()).unwrap();
        fs::write(legacy.join("settings.ini"), "Port=Nzk3OQ==\nEnablePublicTunnel=dHJ1ZQ==\n").unwrap();
        fs::write(&state, "{\"version\":1,\"createdAt\":123,\"tokenHash\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}").unwrap();
        let oauth = legacy_state(&profile, "oauth.json");
        fs::write(oauth, "{\"version\":1,\"clients\":[{\"secret\":\"must-not-leak\"}],\"accessTokens\":[],\"refreshTokens\":[]}").unwrap();
        let report = inspect_paths(&local, &profile, &preview).unwrap();
        assert_eq!(report.port, Some(7979));
        assert_eq!(report.tunnel_enabled, Some(true));
        assert!(report.owner_hash_valid && report.oauth_valid);
        assert_eq!(report.oauth_client_count, Some(1));
        assert!(!report.can_transition_now);
        let exposed = serde_json::to_string(&report).unwrap();
        assert!(!exposed.contains("must-not-leak"));
        assert!(!exposed.contains("AAAAAAAA"));
        fs::remove_dir_all(root).unwrap();
    }
}
