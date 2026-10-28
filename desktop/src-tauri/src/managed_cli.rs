use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const INSTANCE: &str = "tauri-preview-v1";
const PORT: u16 = 18797;
const MANIFEST_KIND: &str = "c2c-tauri-isolated-owned-cli-v1";
const MAX_OUTPUT: usize = 128 * 1024;
static MUTATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u8,
    kind: String,
    cli_sha256: String,
    node_sha256: String,
    instance: String,
    tunnel: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedResult {
    pub available: bool,
    pub ready: bool,
    pub running: bool,
    pub instance: &'static str,
    pub port: u16,
    pub details: String,
    // Only populated when the user explicitly chooses "Prepare". Never
    // logged, persisted in the frontend, or returned by any other action.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub one_time_owner_token: Option<String>,
}

struct Payload {
    node: PathBuf,
    cli: PathBuf,
    home: PathBuf,
    workspace: PathBuf,
}

fn response(available: bool, ready: bool, running: bool, details: impl Into<String>) -> ManagedResult {
    ManagedResult {
        available, ready, running, instance: INSTANCE, port: PORT,
        details: details.into(), one_time_owner_token: None,
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|_| "런타임 실행 파일을 열 수 없습니다.")?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let len = file.read(&mut buffer).map_err(|_| "런타임 체크섬 검사에 실패했습니다.")?;
        if len == 0 { break; }
        digest.update(&buffer[..len]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn verify_manifest(root: &Path) -> Result<(PathBuf, PathBuf), String> {
    let payload = root.join("c2c-runtime");
    let manifest_text = fs::read_to_string(payload.join("manifest.json"))
        .map_err(|_| "번들 CLI가 없습니다. 배포된 프리뷰 ZIP 전체를 압축 해제하세요.")?;
    let manifest: Manifest = serde_json::from_str(manifest_text.trim_start_matches('\u{feff}'))
        .map_err(|_| "번들 CLI 매니페스트를 읽을 수 없습니다.")?;
    if manifest.version != 1 || manifest.kind != MANIFEST_KIND ||
        manifest.instance != INSTANCE || manifest.tunnel != "none" {
        return Err("검증되지 않은 번들 CLI 매니페스트입니다.".into());
    }
    let node = payload.join("bin").join("node.exe");
    let cli = payload.join("dist").join("cli.js");
    let payload_real = fs::canonicalize(&payload)
        .map_err(|_| "런타임 디렉터리가 유효하지 않습니다.")?;
    let node_real = fs::canonicalize(&node).map_err(|_| "번들 Node 실행 파일이 없습니다.")?;
    let cli_real = fs::canonicalize(&cli).map_err(|_| "번들 C2C CLI가 없습니다.")?;
    if !node_real.starts_with(&payload_real) || !cli_real.starts_with(&payload_real) {
        return Err("번들 런타임 파일이 프리뷰 디렉터리를 벗어납니다.".into());
    }
    if sha256_file(&node_real)? != manifest.node_sha256 ||
       sha256_file(&cli_real)? != manifest.cli_sha256 {
        return Err("번들 CLI 체크섬이 일치하지 않습니다. 프리뷰 ZIP을 다시 압축 해제하세요.".into());
    }
    Ok((node_real, cli_real))
}

fn payload_for(executable_dir: &Path, local_appdata: &Path) -> Result<Payload, String> {
    // Portable ZIP has <exe>/c2c-runtime; NSIS may place bundle resources
    // under <exe>/resources/c2c-runtime. Both paths are verified against
    // the same fixed no-tunnel manifest and immutable hash allowlist.
    let resource_root = if executable_dir.join("c2c-runtime").join("manifest.json").is_file() {
        executable_dir.to_path_buf()
    } else {
        executable_dir.join("resources")
    };
    let (node, cli) = verify_manifest(&resource_root)?;
    let base = local_appdata.join("ChatGPTToCodex-Tauri-Preview");
    let home = base.join("isolated-home");
    let workspace = base.join("workspace");
    Ok(Payload { node, cli, home, workspace })
}

fn payload() -> Result<Payload, String> {
    if !cfg!(target_os = "windows") {
        return Err("Tauri CLI 관리는 현재 Windows 전용입니다.".into());
    }
    let exe = std::env::current_exe().map_err(|_| "Tauri 실행 위치를 찾지 못했습니다.")?;
    let directory = exe.parent().ok_or("프리뷰 EXE 경로가 유효하지 않습니다.")?;
    let local = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA를 확인할 수 없습니다.")?;
    payload_for(directory, &PathBuf::from(local))
}

fn state_record(root: &Payload) -> PathBuf {
    root.home.join(".local").join("share").join("chatgpt2codex")
        .join("runtime").join(format!("{INSTANCE}.json"))
}

fn expected_record(root: &Payload, record: &serde_json::Value) -> bool {
    // Never permit the preview to stop an instance which wasn't created
    // by this explicitly scoped, no-tunnel CLI bundle.
    let expected_cli = fs::canonicalize(&root.cli).ok();
    let observed_cli = record["entrypoint"].as_str()
        .and_then(|s| fs::canonicalize(s).ok());
    // An explicitly chosen, registered preview project may become the workspace.
    // Resolve it from the isolated bundled CLI, NEVER from WebView paths.
    let expected_workspace = match selected_workspace(root) {
        Ok(Some((_, path))) => fs::canonicalize(path).ok(),
        Ok(None) => fs::canonicalize(&root.workspace).ok(),
        Err(_) => None, // Corrupt config/registry must never pass ownership verification.
    };
    let observed_workspace = record["workspace"].as_str()
        .and_then(|s| fs::canonicalize(s).ok());
    expected_cli.is_some() && expected_cli == observed_cli &&
        expected_workspace.is_some() && expected_workspace == observed_workspace &&
        record["name"] == INSTANCE && record["port"] == PORT &&
        record["host"] == "127.0.0.1" &&
        record["tunnelMode"] == "none" &&
        record["tunnelPid"].is_null() &&
        record["publicUrl"] == format!("http://127.0.0.1:{PORT}")
}

fn record_if_any(root: &Payload) -> Result<Option<serde_json::Value>, String> {
    match fs::read(state_record(root)) {
        Ok(bytes) => {
            let v: serde_json::Value = serde_json::from_slice(&bytes)
                .map_err(|_| "인스턴스 기록이 유효하지 않아 서버를 조작하지 않습니다.")?;
            if !expected_record(root, &v) {
                return Err("인스턴스 기록이 Tauri 소유로 확인되지 않아 조작을 거부했습니다.".into());
            }
            Ok(Some(v))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("인스턴스 기록을 읽지 못했습니다.".into()),
    }
}

fn cli_command(root: &Payload, args: &[&str], timeout: Duration) -> Result<serde_json::Value, String> {
    let config = root.home.join(".config");
    // Read-only list commands must work even before the preview workspace
    // has been initialized. Mutating operations always call ensure_workspace.
    let workdir = if root.workspace.is_dir() {
        root.workspace.as_path()
    } else {
        root.cli.parent().ok_or("검증된 CLI 작업 디렉터리를 찾지 못했습니다.")?
    };
    let mut command = Command::new(&root.node);
    command.arg(&root.cli).args(args)
        .current_dir(workdir)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    // A strict inherited-env allowlist prevents legacy C2C credentials,
    // Cloudflare tunnel tokens and host config from leaking into a child.
    command.env_clear();
    for name in ["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA"] {
        if let Some(value) = std::env::var_os(name) { command.env(name, value); }
    }
    command.env("USERPROFILE", &root.home)
        .env("HOME", &root.home)
        .env("XDG_CONFIG_HOME", &config);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().map_err(|_| "번들 CLI를 실행할 수 없습니다.")?;
    let stdout = child.stdout.take();
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(pipe) = stdout {
            let _ = pipe.take((MAX_OUTPUT + 1) as u64).read_to_end(&mut bytes);
        }
        bytes
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(80)),
            _ => break None,
        }
    };
    if status.is_none() {
        // Kill only the specific short-lived CLI command we started. The
        // detached managed MCP process, if spawned, is never force-killed.
        let _ = child.kill();
        let _ = child.wait();
    }
    let bytes = reader.join().unwrap_or_default();
    if status.is_none() {
        return Err("CLI 작업 시간이 초과됐습니다. 관리 상태를 새로 확인하세요.".into());
    }
    if !status.is_some_and(|s| s.success()) {
        return Err("CLI가 요청을 거부했습니다. 기존 인스턴스와 충돌하거나 소유권을 확인하지 못했을 수 있습니다.".into());
    }
    if bytes.len() > MAX_OUTPUT {
        return Err("CLI 응답이 예상 범위를 초과했습니다.".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "CLI가 유효한 상태 JSON을 반환하지 않았습니다.".into())
}

/// Only these two fixed list verbs can be invoked by the catalog UI.
 /// Resolves a hash-verified bundle and a separate preview HOME; no init,
 /// selection, token read, legacy CLI execution, tunnel or process control.
pub(crate) fn read_catalog_command(catalog: &str) -> Result<serde_json::Value, String> {
    let args: &[&str] = match catalog {
        "repository" => &["repository", "list"],
        "profile" => &["profile", "list"],
        _ => return Err("읽기 전용 카탈로그 명령이 아닙니다.".into()),
    };
    let root = payload()?;
    cli_command(&root, args, Duration::from_secs(12))
}

// The CLI does not expose a global mutable "profile use" command.
 // Only the canonical, instance-scoped repository selection is writable.
 fn valid_repository_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=64).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(b))
        && !value.contains("..")
 }

fn selected_repository(root: &Payload) -> Result<Option<String>, String> {
    let config = cli_command(root, &["config", "show", "--instance", INSTANCE], Duration::from_secs(12))?;
    let selected = config["persisted"]["repository"].as_str().map(str::to_owned);
    if selected.as_ref().is_some_and(|id| !valid_repository_id(id)) {
        return Err("Tauri 전용 프로젝트 선택 정보가 유효하지 않습니다.".into());
    }
    Ok(selected)
}

fn registered_repository_path(root: &Payload, id: &str) -> Result<PathBuf, String> {
    if !valid_repository_id(id) {
        return Err("프로젝트 ID 형식이 유효하지 않습니다.".into());
    }
    let catalog = cli_command(root, &["repository", "list"], Duration::from_secs(12))?;
    let repositories = catalog["repositories"].as_array()
        .filter(|items| items.len() <= 128)
        .ok_or("Tauri 프로젝트 목록의 형식 또는 크기가 올바르지 않습니다.")?;
    let entry = repositories.iter().find(|item| item["id"] == id)
        .ok_or("선택한 프로젝트가 Tauri 전용 목록에 없습니다.")?;
    if entry["available"] != true {
        return Err("선택한 프로젝트의 디렉터리를 찾을 수 없습니다.".into());
    }
    let path = entry["root"].as_str().ok_or("프로젝트 경로를 읽을 수 없습니다.")?;
    let root = PathBuf::from(path);
    if !root.is_absolute() || !root.is_dir() {
        return Err("등록된 프로젝트 디렉터리가 유효하지 않습니다.".into());
    }
    fs::canonicalize(root).map_err(|_| "프로젝트 경로를 확인하지 못했습니다.".into())
}

fn selected_workspace(root: &Payload) -> Result<Option<(String, PathBuf)>, String> {
    selected_repository(root)?
        .map(|id| registered_repository_path(root, &id).map(|path| (id, path)))
        .transpose()
}

/// Only writes instance-scoped repository preference when no preview
/// runtime record exists. Never starts/stops/restarts any process.
fn select_repository(root: &Payload, id: &str) -> Result<Option<String>, String> {
    if !id.is_empty() && !valid_repository_id(id) {
        return Err("프로젝트 ID 형식이 유효하지 않습니다.".into());
    }
    let lock = MUTATION_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().map_err(|_| "프로젝트 선택 잠금을 얻지 못했습니다.")?;
    ensure_workspace(root)?;
    if record_if_any(root)?.is_some() || port_occupied() {
        return Err("전용 인스턴스 기록 또는 실행 중인 포트가 있습니다. 선택을 변경하려면 전용 서버를 정상 중지하고 기록을 확인하세요.".into());
    }
    if !id.is_empty() {
        let _checked_root = registered_repository_path(root, id)?;
    }
    let previous = selected_repository(root)?;
    if previous.as_deref().unwrap_or("") == id { return Ok(previous); }

    let result = if id.is_empty() {
        cli_command(root, &["config", "unset", "repository", "--instance", INSTANCE], Duration::from_secs(12))
    } else {
        cli_command(root, &["repository", "use", id, "--instance", INSTANCE], Duration::from_secs(12))
    };
    let observed = selected_repository(root);
    let command_ok = if id.is_empty() {
        result.as_ref().is_ok_and(|v| v["updated"] == true && v["unset"] == true && v["instance"] == INSTANCE)
    } else {
        result.as_ref().is_ok_and(|v| v["selected"] == true && v["repository"] == id && v["instance"] == INSTANCE)
    };
    if command_ok && observed.as_ref().is_ok_and(|value| value.as_deref().unwrap_or("") == id) {
        return Ok(if id.is_empty() { None } else { Some(id.to_string()) });
    }
    // Best-effort rollback of the *same owned instance's* preference only.
    // No process stop/restart and no other instance/default mutation.
    let rollback = match previous {
        Some(old) => cli_command(root, &["repository", "use", &old, "--instance", INSTANCE], Duration::from_secs(12)),
        None => cli_command(root, &["config", "unset", "repository", "--instance", INSTANCE], Duration::from_secs(12)),
    };
    if rollback.is_err() {
        return Err("프로젝트 선택 검증에 실패했고 설정 복구도 확인되지 않았습니다. CLI 설정을 점검하세요.".into());
    }
    Err("프로젝트 선택 검증에 실패하여 이전 선택으로 복구했습니다.".into())
}

#[tauri::command]
pub async fn select_owned_repository(id: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = payload()?;
        select_repository(&root, &id)
    }).await.map_err(|_| "프로젝트 선택 처리에 실패했습니다.".to_string())?
}

pub(crate) fn inspect_selected_repository() -> Result<Option<String>, String> {
    selected_repository(&payload()?)
}

fn ensure_workspace(root: &Payload) -> Result<(), String> {
    fs::create_dir_all(&root.home).map_err(|_| "격리된 CLI 저장 공간을 만들지 못했습니다.")?;
    fs::create_dir_all(root.home.join(".config")).map_err(|_| "격리 설정 디렉터리를 만들지 못했습니다.")?;
    fs::create_dir_all(&root.workspace).map_err(|_| "격리 작업 공간을 만들지 못했습니다.")?;
    let marker = root.workspace.join("package.json");
    if !marker.exists() {
        fs::write(marker, "{\"name\":\"c2c-tauri-preview\",\"private\":true}\n")
            .map_err(|_| "격리 작업 공간을 초기화하지 못했습니다.")?;
    }
    Ok(())
}

fn owner_configured(root: &Payload) -> Result<bool, String> {
    let value = cli_command(root, &["owner-token", "--status"], Duration::from_secs(10))?;
    value["configured"].as_bool().ok_or("토큰 설정 상태를 읽지 못했습니다.".into())
}

fn port_occupied() -> bool {
    TcpStream::connect_timeout(
        &SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), PORT),
        Duration::from_millis(250),
    ).is_ok()
}

fn status(root: &Payload) -> Result<ManagedResult, String> {
    ensure_workspace(root)?;
    let ready = owner_configured(root)?;
    let record = record_if_any(root)?;
    let running = if record.is_some() {
        let state = cli_command(root, &["status", "--instance", INSTANCE], Duration::from_secs(10))?;
        state["alive"] == true && state["healthy"] == true
    } else { false };
    Ok(response(true, ready, running, if running {
        "Tauri 전용 CLI 인스턴스가 정상 동작하고 있습니다."
    } else if !ready {
        "독립된 Tauri 인스턴스를 사용하려면 먼저 준비 버튼을 눌러 토큰을 생성하세요."
    } else {
        "전용 인스턴스가 중지돼 있습니다. WinForms 서버는 별도로 유지됩니다."
    }))
}

fn operate(root: Payload, action: &str) -> Result<ManagedResult, String> {
    ensure_workspace(&root)?;
    let lock = MUTATION_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().map_err(|_| "CLI 제어 잠금에 실패했습니다.")?;
    match action {
        "status" => status(&root),
        "prepare" => {
            if owner_configured(&root)? {
                return Err("전용 Owner Token이 이미 설정됐습니다. 토큰을 임의로 재발급하지 않습니다.".into());
            }
            let result = cli_command(&root, &["owner-token", "--generate"], Duration::from_secs(10))?;
            let token = result["ownerToken"].as_str()
                .ok_or("CLI가 새 토큰을 반환하지 않았습니다.")?;
            let mut value = response(true, true, false,
                "전용 Owner Token을 생성했습니다. 한 번만 보여주므로 안전하게 보관하세요.");
            value.one_time_owner_token = Some(token.to_string());
            Ok(value)
        }
        "start" | "stop" | "restart" => {
            let ready = owner_configured(&root)?;
            if !ready { return Err("먼저 전용 인스턴스 준비를 완료하세요.".into()); }
            let record = record_if_any(&root)?;
            if action == "start" && record.is_some() {
                let value = status(&root)?;
                if value.running { return Ok(value); }
                return Err("기존 인스턴스 기록이 있습니다. 수동으로 상태를 확인하세요.".into());
            }
            if action != "start" && record.is_none() {
                return if action == "stop" {
                    Ok(response(true, ready, false, "중지할 Tauri 전용 인스턴스가 없습니다."))
                } else {
                    Err("재시작할 전용 인스턴스가 없습니다.".into())
                };
            }
            if action == "stop" || action == "restart" {
                // Actual PID is independently verified by the audited CLI
                // Windows CIM commandline+creation-time ownership guard.
                let stopped = cli_command(
                    &root, &["stop", "--instance", INSTANCE], Duration::from_secs(30)
                )?;
                if stopped["stopped"] != true {
                    return Err("CLI가 인스턴스 중지를 확인하지 못했습니다.".into());
                }
            }
            if action == "start" || action == "restart" {
                if port_occupied() {
                    return Err("Tauri 전용 포트 18797이 사용 중입니다. 다른 프로세스는 종료하지 않습니다.".into());
                }
                let selection = selected_workspace(&root)?;
                let workspace = selection.as_ref().map(|(_, path)| path)
                    .unwrap_or(&root.workspace);
                let args = ["start", "--instance", INSTANCE,
                    "--workspace", workspace.to_str().ok_or("유효하지 않은 경로입니다.")?,
                    "--host", "127.0.0.1", "--port", "18797", "--tunnel", "none"];
                let started = cli_command(&root, &args, Duration::from_secs(35))?;
                if started["started"] != true || started["healthy"] != true {
                    return Err("CLI의 시작 및 Health 확인에 실패했습니다.".into());
                }
                if record_if_any(&root)?.is_none() {
                    return Err("시작됐지만 인스턴스 소유권 기록을 확인하지 못했습니다.".into());
                }
            }
            status(&root)
        }
        _ => Err("허용되지 않은 CLI 명령입니다.".into()),
    }
}

#[tauri::command]
pub async fn manage_owned_cli(action: String) -> Result<ManagedResult, String> {
    if !matches!(action.as_str(), "status" | "prepare" | "start" | "stop" | "restart") {
        return Err("허용되지 않은 CLI 작업입니다.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root = payload()?;
        operate(root, &action)
    })
    .await
    .map_err(|_| "CLI 수명주기 작업이 실패했습니다.".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_claim_foreign_pid_record_belongs_to_tauri() {
        let root = Payload {
            node: PathBuf::from(r"C:\preview\c2c-runtime\bin\node.exe"),
            cli: PathBuf::from(r"C:\preview\c2c-runtime\dist\cli.js"),
            home: PathBuf::from(r"C:\Users\test\AppData\Local\ChatGPTToCodex-Tauri-Preview\isolated-home"),
            workspace: PathBuf::from(r"C:\Users\test\AppData\Local\ChatGPTToCodex-Tauri-Preview\workspace"),
        };
        let other = serde_json::json!({
            "name":"default","port":7979,"host":"127.0.0.1",
            "entrypoint": r"C:\legacy\dist\cli.js","workspace":r"C:\Users\test\c2c-win-smoke",
            "tunnelMode":"cloudflare","tunnelPid":123,"publicUrl":"https://old.trycloudflare.com"
        });
        assert!(!expected_record(&root, &other));
    }

    #[test]
    fn preview_uses_a_port_separate_from_winforms() {
        assert_ne!(PORT, 7979);
        assert_eq!(INSTANCE, "tauri-preview-v1");
    }

    #[test]
    fn strict_repository_ids_reject_paths_and_option_injection() {
        assert!(valid_repository_id("project-a"));
        for id in ["", "../legacy", "..", "--instance", "Project", "a b", "한글", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] {
            assert!(!valid_repository_id(id), "{id}");
        }
    }

    #[test]
    fn missing_bundled_runtime_is_fail_closed() {
        let root = std::env::temp_dir().join("c2c-no-such-bundle-directory");
        assert!(verify_manifest(&root).is_err());
    }
}
