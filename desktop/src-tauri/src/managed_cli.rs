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
const DEFAULT_PORT: u16 = 7979;
// An earlier Tauri-owned process can still have this port until restarted.
const PREVIOUS_PORT: u16 = 18797;
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
    cloudflared_sha256: Option<String>,
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
    pub tunnel_capable: bool,
    pub tunnel_running: bool,
    pub token_copy_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_connector: Option<String>,
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
    // A future F5-D operation will consume the *verified* owned executable,
    // never a cloudflared found on PATH or inside the legacy installation.
    cloudflared: Option<PathBuf>,
}

fn port_file(root: &Payload) -> PathBuf {
    root.home.join(".config").join("desktop-port.txt")
}

fn configured_port(root: &Payload) -> Result<u16, String> {
    let file = port_file(root);
    match fs::symlink_metadata(&file) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(DEFAULT_PORT),
        Err(_) => return Err("서버 포트 설정을 확인할 수 없습니다.".into()),
        Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 5 => {
            return Err("저장된 서버 포트 설정이 유효하지 않습니다.".into());
        }
        Ok(_) => {}
    }
    let raw = fs::read_to_string(file).map_err(|_| "서버 포트 설정을 읽지 못했습니다.")?;
    if raw.is_empty() || raw.starts_with('0') || !raw.bytes().all(|c| c.is_ascii_digit()) {
        return Err("저장된 서버 포트는 1~65535 범위여야 합니다.".into());
    }
    let port = raw.parse::<u16>().map_err(|_| "저장된 서버 포트가 범위를 벗어납니다.")?;
    if port == 0 { return Err("서버 포트는 1~65535 범위여야 합니다.".into()); }
    Ok(port)
}

fn persist_port(root: &Payload, port: u16) -> Result<(), String> {
    if port == 0 { return Err("서버 포트는 1~65535 범위여야 합니다.".into()); }
    let file = port_file(root);
    if fs::symlink_metadata(&file).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err("서버 포트 설정 경로가 심볼릭 링크여서 저장하지 않습니다.".into());
    }
    fs::write(file, port.to_string())
        .map_err(|_| "서버 포트 설정을 저장하지 못했습니다.".into())
}

fn response(available: bool, ready: bool, running: bool, details: impl Into<String>) -> ManagedResult {
    ManagedResult {
        available, ready, running, instance: INSTANCE, port: DEFAULT_PORT,
        details: details.into(), one_time_owner_token: None,
        tunnel_capable: false, tunnel_running: false, token_copy_available: false, public_connector: None,
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|_| "런타임 실행 파일을 열 수 없습니다.")?;
    let mut digest = Sha256::new();
    // Large verified binaries benefit from fewer read syscalls, especially
    // on Windows; the SHA-256 integrity check remains identical.
    let mut buffer = [0; 256 * 1024];
    loop {
        let len = file.read(&mut buffer).map_err(|_| "런타임 체크섬 검사에 실패했습니다.")?;
        if len == 0 { break; }
        digest.update(&buffer[..len]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn verify_manifest(root: &Path) -> Result<(PathBuf, PathBuf, Option<PathBuf>), String> {
    let payload = root.join("c2c-runtime");
    let manifest_text = fs::read_to_string(payload.join("manifest.json"))
        .map_err(|_| "번들 CLI가 없습니다. 배포된 프리뷰 ZIP 전체를 압축 해제하세요.")?;
    let manifest: Manifest = serde_json::from_str(manifest_text.trim_start_matches('\u{feff}'))
        .map_err(|_| "번들 CLI 매니페스트를 읽을 수 없습니다.")?;
    let quick_ready = manifest.tunnel == "quick-ready";
    if manifest.version != 1 || manifest.kind != MANIFEST_KIND ||
        manifest.instance != INSTANCE ||
        (manifest.tunnel != "none" && !quick_ready) ||
        (!quick_ready && manifest.cloudflared_sha256.is_some()) {
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
    let cloudflared = if quick_ready {
        let declared = manifest.cloudflared_sha256.as_deref()
            .ok_or("Cloudflare 번들 해시가 누락됐습니다.")?;
        if declared.len() != 64 || !declared.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Cloudflare 번들 해시가 유효하지 않습니다.".into());
        }
        let binary = fs::canonicalize(payload.join("bin").join("cloudflared.exe"))
            .map_err(|_| "Cloudflare 번들 실행 파일이 없습니다.")?;
        if !binary.starts_with(&payload_real) || sha256_file(&binary)? != declared {
            return Err("Cloudflare 번들 파일 경로나 SHA-256이 일치하지 않습니다.".into());
        }
        Some(binary)
    } else {
        None // F5-C1/C2/C3 local-only artifacts remain readable.
    };
    Ok((node_real, cli_real, cloudflared))
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
    let (node, cli, cloudflared) = verify_manifest(&resource_root)?;
    let base = local_appdata.join("ChatGPTToCodex-Tauri-Preview");
    let home = base.join("isolated-home");
    let workspace = base.join("workspace");
    Ok(Payload { node, cli, home, workspace, cloudflared })
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

/// The console status/health fast path *never executes a binary or mutates
/// server state*. Resolve only fixed bundle paths without hashing large
/// executables. Every operation which can execute a CLI still uses payload()
/// and verifies all SHA-256 manifest hashes.
fn read_only_payload() -> Result<Payload, String> {
    if !cfg!(target_os = "windows") {
        return Err("빠른 상태 조회는 현재 Windows 전용입니다.".into());
    }
    let exe = std::env::current_exe().map_err(|_| "Tauri 실행 위치를 확인하지 못했습니다.")?;
    let directory = exe.parent().ok_or("Tauri 실행 위치가 올바르지 않습니다.")?;
    let resource_root = if directory.join("c2c-runtime").join("manifest.json").is_file() {
        directory.to_path_buf()
    } else {
        directory.join("resources")
    };
    let bundle = resource_root.join("c2c-runtime");
    if !bundle.join("manifest.json").is_file() {
        return Err("번들 CLI 매니페스트를 찾지 못했습니다.".into());
    }
    let node = bundle.join("bin").join("node.exe");
    let cli = bundle.join("dist").join("cli.js");
    if !node.is_file() || !cli.is_file() {
        return Err("번들 CLI 실행 파일이 없습니다.".into());
    }
    let local = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA를 확인할 수 없습니다.")?;
    let base = PathBuf::from(local).join("ChatGPTToCodex-Tauri-Preview");
    let cloudflared = bundle.join("bin").join("cloudflared.exe");
    Ok(Payload {
        node, cli, home: base.join("isolated-home"),
        workspace: base.join("workspace"),
        cloudflared: cloudflared.is_file().then_some(cloudflared),
    })
}

#[cfg(target_os = "windows")]
fn native_pid_alive(pid: u32) -> Option<bool> {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid == 0 { return Some(false); }
    // WaitForSingleObject requires SYNCHRONIZE (0x0010_0000) in addition
    // to query access. These are read-only rights; never request terminate.
    const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE_ACCESS, 0, pid) };
    if handle.is_null() {
        // Access denied or a recycled PID: let the canonical CLI determine
        // the state instead of guessing or probing a foreign process.
        return None;
    }
    let result = unsafe { WaitForSingleObject(handle, 0) };
    unsafe { CloseHandle(handle) };
    match result {
        WAIT_TIMEOUT => Some(true),
        0 => Some(false), // WAIT_OBJECT_0
        _ => None,
    }
}

#[cfg(not(target_os = "windows"))]
fn native_pid_alive(_pid: u32) -> Option<bool> {
    None
}

/// Returns None when a legacy/stale/ambiguous record needs the canonical CLI
/// fallback. Fast path never starts Node, relies on unverified binaries, or
/// modifies a stale runtime record.
pub(crate) fn native_console_status(operation: &str) -> Result<Option<serde_json::Value>, String> {
    let root = read_only_payload()?;
    native_console_status_for(&root, operation)
}

fn native_console_status_for(root: &Payload, operation: &str)
    -> Result<Option<serde_json::Value>, String> {
    if !matches!(operation, "status" | "health") {
        return Err("빠른 상태 조회는 status/health만 지원합니다.".into());
    }
    let path = state_record(root);
    let bytes = match fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() &&
            meta.len() <= 128 * 1024 => Some(
            fs::read(&path).map_err(|_| "인스턴스 상태 기록을 읽지 못했습니다.")?),
        Ok(_) => return Err("인스턴스 상태 기록이 올바른 파일이 아닙니다.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err("인스턴스 상태 기록을 확인하지 못했습니다.".into()),
    };
    let record: Option<serde_json::Value> = bytes.as_ref()
        .map(|bytes| serde_json::from_slice(bytes)
            .map_err(|_| "인스턴스 상태 기록을 해석하지 못했습니다.".to_string()))
        .transpose()?;
    let Some(mut record) = record else {
        return Ok(Some(if operation == "status" {
            serde_json::json!({"name": INSTANCE, "alive": false, "healthy": false})
        } else {
            serde_json::json!({
                "instance": INSTANCE, "alive": false, "healthy": false,
                "tunnelAlive": null, "publicHealthy": null, "endpoint": null
            })
        }));
    };
    // Normal current Tauri records match the fixed workspace. Only those
    // can avoid the old CLI-powered repository lookup; compatibility cases
    // fall back to the original, fully hash-verified CLI code path.
    let expected_workspace = fs::canonicalize(&root.workspace).ok();
    let recorded_workspace = record["workspace"].as_str()
        .and_then(|s| fs::canonicalize(s).ok());
    if expected_workspace.is_none() || expected_workspace != recorded_workspace {
        return Ok(None);
    }
    if !expected_record(root, &record) {
        return Err("인스턴스 기록이 앱 소유로 검증되지 않아 상태 조회를 중단했습니다.".into());
    }
    // Public health intentionally retains the canonical CLI's remote
    // HTTPS probe. The local-only fast path performs no external network I/O.
    if operation == "health" && record["tunnelMode"] == "cloudflare" {
        return Ok(None);
    }
    let pid = record["pid"].as_u64().and_then(|v| u32::try_from(v).ok());
    let Some(alive) = pid.and_then(native_pid_alive) else { return Ok(None); };
    if !alive {
        // The Node CLI may safely clean up a genuinely stale record. A
        // native read-only observation must not silently change that rule.
        return Ok(None);
    }
    let port = record["port"].as_u64().and_then(|v| u16::try_from(v).ok())
        .ok_or("인스턴스 포트가 올바르지 않습니다.")?;
    let healthy = crate::native_local_c2c_health(port);
    let tunnel_alive = if record["tunnelPid"].is_null() {
        None
    } else {
        let Some(pid) = record["tunnelPid"].as_u64().and_then(|v| u32::try_from(v).ok())
            else { return Ok(None); };
        let Some(running) = native_pid_alive(pid) else { return Ok(None); };
        Some(running)
    };
    if operation == "health" {
        return Ok(Some(serde_json::json!({
            "instance": INSTANCE, "alive": alive, "healthy": healthy,
            "tunnelAlive": tunnel_alive, "publicHealthy": null,
            "endpoint": record["publicUrl"].as_str().map(|url| format!("{url}/healthz"))
        })));
    }
    let map = record.as_object_mut().ok_or("인스턴스 기록의 필드 형식이 올바르지 않습니다.")?;
    map.insert("alive".into(), alive.into());
    map.insert("healthy".into(), healthy.into());
    map.insert("tunnelAlive".into(),
        tunnel_alive.map(serde_json::Value::Bool).unwrap_or(serde_json::Value::Null));
    Ok(Some(record))
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
    // A pre-F5-C3 owned runtime may still be running in a user-selected
    // project. Accept that *existing* exact root for a guarded stop, while
    // all newly started preview servers use only the fixed owned workspace.
    // Both candidates are resolved by Rust/isolated CLI, never from WebView.
    let owned_workspace = fs::canonicalize(&root.workspace).ok();
    let observed_workspace = record["workspace"].as_str()
        .and_then(|s| fs::canonicalize(s).ok());
    // Fast path for every current Tauri-managed runtime: avoid querying the
    // Node CLI's selected repository on every status/health/ownership read.
    // The historical workspace compatibility check is only necessary for
    // records that do not point at the fixed, app-owned workspace.
    let workspace_owned = observed_workspace.as_ref().is_some_and(|observed| {
        owned_workspace.as_ref() == Some(observed) ||
            selected_workspace(root).ok().flatten()
                .and_then(|(_, path)| fs::canonicalize(path).ok()).as_ref() == Some(observed)
    });
    let active_port = record["port"].as_u64().and_then(|n| u16::try_from(n).ok()).unwrap_or(0);
    let expected_port = configured_port(root).ok();
    let port_owned = active_port != 0 && (Some(active_port) == expected_port || active_port == PREVIOUS_PORT);
    let no_tunnel = record["tunnelMode"] == "none" &&
        record["tunnelPid"].is_null() &&
        record["publicUrl"] == format!("http://127.0.0.1:{active_port}");
    let quick_tunnel = root.cloudflared.is_some() && record["tunnelMode"] == "cloudflare" &&
        record["tunnelPid"].as_u64().is_some_and(|pid| pid > 0) &&
        record["publicUrl"].as_str().is_some_and(|origin| {
            crate::public_health::quick_tunnel_health_url(&format!("{origin}/mcp")).is_some()
        }) &&
        record["tunnelLogPath"].as_str().is_some_and(|log| {
            let expected = root.home.join(".local").join("share").join("chatgpt2codex")
                .join("logs").join(format!("{INSTANCE}.cloudflared.log"));
            fs::canonicalize(log).ok().is_some_and(|observed|
                fs::canonicalize(expected).ok().as_ref() == Some(&observed))
        });
    expected_cli.is_some() && expected_cli == observed_cli &&
        workspace_owned &&
        record["name"] == INSTANCE && port_owned &&
        record["host"] == "127.0.0.1" && (no_tunnel || quick_tunnel)
}

fn record_if_any(root: &Payload) -> Result<Option<serde_json::Value>, String> {
    match fs::read(state_record(root)) {
        Ok(bytes) => {
            let v: serde_json::Value = serde_json::from_slice(&bytes)
                .map_err(|_| "인스턴스 기록이 유효하지 않아 서버를 조작하지 않습니다.")?;
            if !expected_record(root, &v) {
                // A detached serve --http process can write a provisional
                // record before 'c2c start' merges tunnel ownership metadata.
                // Never accept that partial record as authority to stop, rotate
                // or control a process: merely provide actionable diagnostics.
                if v["name"] == INSTANCE &&
                    (v["port"].as_u64() == Some(u64::from(configured_port(root)?)) ||
                     v["port"].as_u64() == Some(u64::from(PREVIOUS_PORT))) &&
                    v.get("tunnelMode").is_none() {
                    return Err("전용 MCP 시작 기록이 미완성입니다(tunnelMode 누락). 인스턴스 PID, 로컬 Health, Cloudflare 프로세스를 확인하세요. 안전한 소유권 확인 전 기록을 수정·삭제하거나 프로세스를 종료하지 않습니다.".into());
                }
                return Err("인스턴스 기록이 Tauri 소유로 확인되지 않아 조작을 거부했습니다.".into());
            }
            Ok(Some(v))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("인스턴스 기록을 읽지 못했습니다.".into()),
    }
}

fn cli_output(root: &Payload, args: &[&str], timeout: Duration, allow_nonzero: bool) -> Result<String, String> {
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
    // The canonical CLI performs its own audited tunnel process ownership
    // checks. Supply an exact SHA-verified executable path, never PATH lookup.
    if let Some(binary) = &root.cloudflared {
        command.env("CHATGPT2CODEX_MANAGED_CLOUDFLARED", binary);
    }
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
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
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
    if !allow_nonzero && !status.is_some_and(|s| s.success()) {
        return Err("CLI가 요청을 거부했습니다. 기존 인스턴스와 충돌하거나 소유권을 확인하지 못했을 수 있습니다.".into());
    }
    if bytes.len() > MAX_OUTPUT {
        return Err("CLI 응답이 예상 범위를 초과했습니다.".into());
    }
    String::from_utf8(bytes).map_err(|_| "CLI 응답이 UTF-8이 아닙니다.".into())
}

fn cli_command(root: &Payload, args: &[&str], timeout: Duration) -> Result<serde_json::Value, String> {
    let output = cli_output(root, args, timeout, false)?;
    serde_json::from_str(&output)
        .map_err(|_| "CLI가 유효한 상태 JSON을 반환하지 않았습니다.".into())
}

/// Only callers with a fixed native command whitelist may invoke this bridge.
/// Uses the same verified bundle, isolated HOME and serialized mutation lock.
/// The caller must never pass untrusted argv without validation.
pub(crate) fn parity_cli(args: &[String], mutating: bool, needs_owned_runtime: bool,
                         output_is_text: bool, allow_nonzero: bool) -> Result<String, String> {
    let root = payload()?;
    ensure_workspace(&root)?;
    let lock = MUTATION_LOCK.get_or_init(|| Mutex::new(()));
    // Lock even reads, so a list/show cannot race with rotation or stopping.
    let _guard = lock.lock().map_err(|_| "CLI 제어 잠금에 실패했습니다.")?;
    // All commands, including status/health, must reject foreign/stale
    // runtime records before a CLI status probe could mutate their state.
    let owned_record = record_if_any(&root)?;
    if needs_owned_runtime && owned_record.is_none() {
        return Err("Tauri 전용 MCP가 실행 중이 아닙니다. 재로드는 실행 중인 전용 서버에만 허용됩니다.".into());
    }
    if mutating && port_occupied(configured_port(&root)?) && owned_record.is_none() {
        return Err("전용 포트를 외부 프로세스가 사용 중입니다. CLI 설정 변경을 거부합니다.".into());
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    // Windows project scans may take longer than a basic status/list
    // request. Give acknowledged reload (and profile/repository mutations
    // which auto-reload) enough time without relaxing process ownership.
    let timeout = if args.first().is_some_and(|verb|
        verb == "reload" || verb == "profile" || verb == "repository")
        { 65 } else if output_is_text { 35 } else { 25 };
    let text = cli_output(&root, &refs, Duration::from_secs(timeout), allow_nonzero)?;
    if output_is_text {
        Ok(text)
    } else {
        let _: serde_json::Value = serde_json::from_str(&text)
            .map_err(|_| "CLI가 유효한 JSON 응답을 반환하지 않았습니다.".to_string())?;
        Ok(text)
    }
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

// F5-C3: a former GUI "default project" is a startup preference, not a
// required catalog selection. Clear only this preview instance's setting
// during an explicit stopped-instance mutation or start. Never touch legacy.
fn clear_startup_repository_preference(root: &Payload) -> Result<(), String> {
    if selected_repository(root)?.is_none() { return Ok(()); }
    let result = cli_command(
        root, &["config", "unset", "repository", "--instance", INSTANCE],
        Duration::from_secs(12)
    )?;
    if result["updated"] != true || result["unset"] != true ||
       result["instance"] != INSTANCE || selected_repository(root)?.is_some() {
        return Err("Tauri 전용 기본 프로젝트 설정을 해제하지 못했습니다. 목록과 CLI 설정을 확인하세요.".into());
    }
    Ok(())
}

/// F5-C2 only: the native picker holds the folder; the WebView can supply
/// a bounded project id/name but NEVER a path or a CLI command.
pub(crate) fn verify_preview_bundle() -> Result<(), String> {
    payload().map(|_| ())
}

pub(crate) fn register_picked_repository(folder: &Path, id: &str, name: &str) -> Result<(), String> {
    if !valid_repository_id(id) {
        return Err("프로젝트 ID는 영문 소문자·숫자로 시작하며 64자 이하여야 합니다.".into());
    }
    if name.is_empty() || name.len() > 160 || name.starts_with('-')
        || name.chars().any(char::is_control) {
        return Err("프로젝트 표시 이름의 형식이 올바르지 않습니다.".into());
    }

    let root = payload()?;
    let lock = MUTATION_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().map_err(|_| "프로젝트 등록 잠금을 얻지 못했습니다.")?;
    ensure_workspace(&root)?;
    // The canonical CLI 'repository add' can live-reload its own catalogs;
    // forbid running/stale owned runtime records so registration is inert.
    if record_if_any(&root)?.is_some() || port_occupied(configured_port(&root)?) {
        return Err("전용 서버가 실행 중이거나 인스턴스 기록이 있습니다. 정상 종료 후 다시 시도하세요.".into());
    }

    let canonical = fs::canonicalize(folder)
        .map_err(|_| "선택한 프로젝트 폴더를 확인할 수 없습니다.".to_string())?;
    if !canonical.is_dir() {
        return Err("선택한 경로가 디렉터리가 아닙니다.".into());
    }
    // Match the canonical Node CLI's inspectProjectRoot project-marker policy.
    // A random document/download directory is not a runnable C2C project.
    const PROJECT_MARKERS: &[&str] = &[
        ".git", "package.json", "pubspec.yaml", "go.mod",
        "Cargo.toml", "requirements.txt", ".chatgpt2codex",
    ];
    if !PROJECT_MARKERS.iter().any(|marker| canonical.join(marker).exists()) {
        return Err("개발 프로젝트로 인식되지 않는 폴더입니다. .git, package.json, requirements.txt 등 프로젝트 식별 파일이 있는 폴더를 선택하세요.".into());
    }
    let full_path = canonical.to_str().ok_or("프로젝트 경로의 문자를 인식하지 못했습니다.")?;

    let existing = cli_command(&root, &["repository", "list"], Duration::from_secs(12))?;
    let items = existing["repositories"].as_array()
        .filter(|items| items.len() < 128)
        .ok_or("Tauri 전용 프로젝트 목록이 유효하지 않거나 가득 찼습니다.")?;
    for item in items {
        if item["id"] == id {
            return Err("같은 ID의 Tauri 전용 프로젝트가 이미 등록돼 있습니다.".into());
        }
        if let Some(path) = item["root"].as_str() {
            if fs::canonicalize(path).ok().as_ref() == Some(&canonical) {
                return Err("해당 폴더는 Tauri 전용 프로젝트로 이미 등록돼 있습니다.".into());
            }
        }
    }

    // No shell, no legacy executable, no default/home namespace, no tunnel.
    let registered = cli_command(
        &root, &["repository", "add", full_path, "--id", id, "--name", name],
        Duration::from_secs(20)
    )?;
    if registered["added"] != true || registered["id"] != id
        || registered["name"] != name {
        return Err("CLI가 프로젝트 등록을 확인하지 못했습니다. 목록을 새로 확인하세요.".into());
    }
    let after = cli_command(&root, &["repository", "list"], Duration::from_secs(12))?;
    let confirmed = after["repositories"].as_array()
        .and_then(|items| items.iter().find(|item| item["id"] == id));
    let Some(confirmed) = confirmed else {
        return Err("등록 후 목록에서 프로젝트를 확인하지 못했습니다.".into());
    };
    let observed = confirmed["root"].as_str()
        .and_then(|value| fs::canonicalize(value).ok());
    if observed.as_ref() != Some(&canonical) || confirmed["available"] != true {
        return Err("등록 경로 또는 디렉터리 상태가 일치하지 않습니다.".into());
    }
    Ok(())
}

// F5-C3: removing a repository means only unregistering its ID from the
// isolated Tauri CLI catalog. It must never touch the physical project folder.
fn validate_unregistration(
    id: &str,
    repositories: &[serde_json::Value],
) -> Result<(), String> {
    if !valid_repository_id(id) {
        return Err("프로젝트 ID가 올바르지 않습니다.".into());
    }
    if repositories.len() > 128 {
        return Err("프로젝트 목록이 허용 범위를 초과해 제거하지 않습니다.".into());
    }
    if repositories.iter().filter(|item| item["id"] == id).count() != 1 {
        return Err("제거하려는 프로젝트가 목록에 정확히 한 번 등록된 상태가 아닙니다. 목록을 새로 확인하세요.".into());
    }
    Ok(())
}

fn unregister_repository(root: &Payload, id: &str) -> Result<(), String> {
    if !valid_repository_id(id) {
        return Err("프로젝트 ID가 올바르지 않습니다.".into());
    }
    let lock = MUTATION_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().map_err(|_| "프로젝트 제거 잠금을 얻지 못했습니다.")?;
    ensure_workspace(root)?;
    // Even a stale runtime record must block deletion. We never stop or
    // restart a process, and never touch default:7979 or its config files.
    if record_if_any(root)?.is_some() || port_occupied(configured_port(root)?) {
        return Err("서버 포트가 사용 중이거나 인스턴스 기록이 남아 있습니다. 정상 종료한 뒤 목록 제거를 진행하세요.".into());
    }
    let catalog = cli_command(root, &["repository", "list"], Duration::from_secs(12))?;
    let repositories = catalog["repositories"].as_array()
        .ok_or("Tauri 전용 프로젝트 목록을 읽지 못했습니다.")?;
    validate_unregistration(id, repositories)?;
    // A legacy Tauri startup preference may point to the project about to
    // be unregistered. Clearing it before removal avoids a dangling ID.
    // This action is only reachable when no owned runtime record/port exists.
    clear_startup_repository_preference(root)?;

    // Only the fixed CLI 'repository remove <id>' verb is allowed. No shell,
    // filesystem deletion, arbitrary path, credential, or tunnel operation.
    let result = cli_command(root, &["repository", "remove", id], Duration::from_secs(20))?;
    if result["removed"] != true || result["id"] != id {
        return Err("CLI가 프로젝트 등록 해제를 확인하지 못했습니다. 목록을 다시 확인하세요.".into());
    }
    let afterward = cli_command(root, &["repository", "list"], Duration::from_secs(12))?;
    let remaining = afterward["repositories"].as_array()
        .ok_or("제거 후 프로젝트 목록 형식을 확인하지 못했습니다.")?;
    if remaining.iter().any(|item| item["id"] == id) {
        return Err("등록 해제 후에도 프로젝트가 목록에 남아 있습니다. 목록을 새로 확인하세요.".into());
    }
    if selected_repository(root)?.is_some() {
        return Err("등록 해제 뒤 전용 기본 프로젝트 설정이 남아 있습니다. CLI 설정을 확인하세요.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn unregister_owned_repository(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = payload()?;
        unregister_repository(&root, &id)
    }).await.map_err(|_| "프로젝트 등록 해제 작업이 중단됐습니다.".to_string())?
}

#[cfg(test)]
mod f5c3_unregistration_tests {
    use super::*;
    #[test]
    fn rejects_invalid_missing_and_ambiguous_project_ids() {
        let entries = vec![serde_json::json!({"id":"first","available":true}),
                           serde_json::json!({"id":"gone","available":false})];
        assert!(validate_unregistration("first", &entries).is_ok());
        assert!(validate_unregistration("../other", &entries).is_err());
        assert!(validate_unregistration("not-here", &entries).is_err());
        assert!(validate_unregistration("first", &[entries[0].clone(), entries[0].clone()]).is_err());
        assert!(validate_unregistration("gone", &entries).is_ok());
        assert!(validate_unregistration("first", &vec![entries[0].clone(); 129]).is_err());
    }
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

fn port_occupied(port: u16) -> bool {
    TcpStream::connect_timeout(
        &SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
        Duration::from_millis(250),
    ).is_ok()
}


// The credential store retains only a hash; the old token cannot be copied.
// Rotation is allowed only with no Tauri-owned runtime record or live port,
// because the CLI also clears previously issued OAuth clients/tokens.
fn rotation_preflight(record_exists: bool, port_busy: bool) -> Result<(), &'static str> {
    if record_exists || port_busy {
        Err("Owner Token 재발급 전 Tauri 전용 MCP를 정상 중지하세요. 실행 중이거나 인스턴스 기록이 남아 있습니다.")
    } else {
        Ok(())
    }
}

fn status(root: &Payload) -> Result<ManagedResult, String> {
    ensure_workspace(root)?;
    let ready = owner_configured(root)?;
    let record = record_if_any(root)?;
    let state = if record.is_some() {
        Some(cli_command(root, &["status", "--instance", INSTANCE], Duration::from_secs(10))?)
    } else { None };
    let running = state.as_ref().is_some_and(|v| v["alive"] == true && v["healthy"] == true);
    let tunnel_running = running && state.as_ref().is_some_and(|v| v["tunnelAlive"] == true)
        && record.as_ref().is_some_and(|v| v["tunnelMode"] == "cloudflare");
    let connector = if tunnel_running {
        record.as_ref().and_then(|v| v["publicUrl"].as_str())
            .map(|origin| format!("{origin}/mcp"))
            .filter(|url| crate::public_health::quick_tunnel_health_url(url).is_some())
    } else { None };
    let mut result = response(true, ready, running, if tunnel_running {
        "Tauri 전용 MCP 및 Quick Tunnel이 실행 중입니다. 공개 HTTPS Health는 별도로 확인해야 합니다."
    } else if running {
        "Tauri 전용 로컬 MCP 인스턴스가 정상 동작하고 있습니다."
    } else if !ready {
        "독립된 Tauri 인스턴스를 사용하려면 먼저 준비 버튼을 눌러 토큰을 생성하세요."
    } else {
        "MCP 서버가 중지돼 있습니다."
    });
    result.port = record.as_ref().and_then(|r| r["port"].as_u64())
        .and_then(|n| u16::try_from(n).ok()).unwrap_or(configured_port(root)?);
    result.tunnel_capable = root.cloudflared.is_some();
    result.token_copy_available = ready && crate::owner_token_vault::available(&root.home);
    result.tunnel_running = tunnel_running;
    result.public_connector = connector;
    Ok(result)
}

/// Read-only and instance-owned: never use the installed WinForms health
/// probe for the Tauri public Quick Tunnel. No arbitrary WebView URL accepted.
pub(crate) fn owned_public_connector() -> Result<Option<String>, String> {
    let root = payload()?;
    let result = status(&root)?;
    if result.running && result.tunnel_running {
        Ok(result.public_connector)
    } else {
        Ok(None)
    }
}

fn start_owned_at_port(root: &Payload, port: u16, public_start: bool) -> Result<(), String> {
    if port_occupied(port) {
        return Err(format!("포트 {port}이(가) 이미 사용 중입니다. 다른 프로세스는 종료하지 않습니다."));
    }
    if public_start && root.cloudflared.is_none() {
        return Err("검증된 Cloudflare Quick Tunnel 번들이 없습니다.".into());
    }
    clear_startup_repository_preference(root)?;
    let tunnel_mode = if public_start { "cloudflare" } else { "none" };
    let port_text = port.to_string();
    let args = ["start", "--instance", INSTANCE,
        "--workspace", root.workspace.to_str().ok_or("유효하지 않은 경로입니다.")?,
        "--host", "127.0.0.1", "--port", port_text.as_str(), "--tunnel", tunnel_mode];
    let started = cli_command(root, &args,
        Duration::from_secs(if public_start { 100 } else { 35 }))?;
    if started["started"] != true || started["healthy"] != true ||
        started["port"].as_u64() != Some(u64::from(port)) {
        return Err("CLI의 시작 및 Health 확인에 실패했습니다.".into());
    }
    if record_if_any(root)?.as_ref()
        .and_then(|r| r["port"].as_u64()) != Some(u64::from(port)) {
        return Err("시작됐지만 요청한 포트의 인스턴스 소유권 기록을 확인하지 못했습니다.".into());
    }
    Ok(())
}

fn configure_owned_port(next: u16) -> Result<ManagedResult, String> {
    if next == 0 { return Err("포트는 1~65535 사이의 정수여야 합니다.".into()); }
    let root = payload()?;
    ensure_workspace(&root)?;
    let lock = MUTATION_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().map_err(|_| "서버 포트 변경 잠금을 획득하지 못했습니다.")?;
    let previous_setting = configured_port(&root)?;
    let record = record_if_any(&root)?;
    let previous_runtime_port = record.as_ref()
        .and_then(|r| r["port"].as_u64()).and_then(|n| u16::try_from(n).ok())
        .unwrap_or(previous_setting);
    if previous_setting == next && previous_runtime_port == next { return status(&root); }
    if port_occupied(next) && next != previous_runtime_port {
        return Err(format!("포트 {next}이(가) 이미 사용 중입니다. 다른 서비스는 종료하지 않습니다."));
    }
    let public_start = record.as_ref().is_some_and(|r| r["tunnelMode"] == "cloudflare");
    if record.is_some() {
        let current = cli_command(&root, &["status", "--instance", INSTANCE], Duration::from_secs(10))?;
        if current["alive"] != true || current["healthy"] != true {
            return Err("서버 기록이 있지만 정상 실행 중으로 확인되지 않아 포트를 변경하지 않습니다.".into());
        }
        let stopped = cli_command(&root, &["stop", "--instance", INSTANCE], Duration::from_secs(30))?;
        if stopped["stopped"] != true || stopped["instance"] != INSTANCE {
            return Err("기존 서버의 정상 중지를 확인하지 못해 포트를 변경하지 않았습니다.".into());
        }
        if record_if_any(&root)?.is_some() {
            return Err("이전 서버의 인스턴스 기록이 남아 있어 포트를 변경하지 않았습니다.".into());
        }
    }
    if let Err(error) = persist_port(&root, next) {
        if record.is_some() {
            let _ = start_owned_at_port(&root, previous_runtime_port, public_start);
        }
        return Err(error);
    }
    if record.is_some() {
        if let Err(error) = start_owned_at_port(&root, next, public_start) {
            // The CLI may have started a process before reporting an error.
            // Never attempt to launch the old port while a new listener or
            // even a partial ownership record could remain alive.
            let residual = match record_if_any(&root) {
                Ok(Some(_)) => true,
                Ok(None) => port_occupied(next),
                Err(_) => true,
            };
            if residual {
                return Err(format!(
                    "새 포트 {next}의 시작 확인에 실패했고 실행 기록이나 포트 점유가 남아 있습니다: {error}. +                     안전을 위해 설정을 유지했으니 서버 상태를 점검하세요."
                ));
            }
            let rollback_config = persist_port(&root, previous_setting);
            let rollback_start = if rollback_config.is_ok() {
                start_owned_at_port(&root, previous_runtime_port, public_start)
            } else {
                Err("이전 포트 설정을 복원하지 못했습니다.".into())
            };
            return match rollback_start {
                Ok(()) => Err(format!("포트 변경에 실패하여 이전 서버를 복구했습니다: {error}")),
                Err(recovery) => Err(format!("포트 변경 실패: {error}; 이전 서버 복구에도 실패했습니다: {recovery}")),
            };
        }
    }
    status(&root)
}

#[tauri::command]
pub async fn set_owned_port(port: u16) -> Result<ManagedResult, String> {
    tauri::async_runtime::spawn_blocking(move || configure_owned_port(port))
        .await.map_err(|_| "포트 변경 작업을 완료하지 못했습니다.".to_string())?
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
            value.port = configured_port(&root)?;
            // The canonical CLI persists only SHA-256; the optional DPAPI vault
            // allows safe later copying without reissuing a token.
            value.token_copy_available = crate::owner_token_vault::store(&root.home, token).is_ok();
            if !value.token_copy_available {
                value.details.push_str(" Windows 암호화 보관에 실패했으므로 이번 일회성 토큰을 반드시 복사해 보관하세요.");
            }
            value.one_time_owner_token = Some(token.to_string());
            value.tunnel_capable = root.cloudflared.is_some();
            Ok(value)
        }
        "rotate-token" => {
            if !owner_configured(&root)? {
                return Err("기존 Owner Token이 없습니다. 전용 인스턴스 준비를 사용하세요.".into());
            }
            rotation_preflight(record_if_any(&root)?.is_some(), port_occupied(configured_port(&root)?))?;
            // Only the isolated preview HOME. The CLI never returns the
            // previous token; --rotate stores the new hash and invalidates
            // previously approved OAuth clients. No process is restarted.
            let result = cli_command(&root, &["owner-token", "--rotate"], Duration::from_secs(15))?;
            let token = result["ownerToken"].as_str()
                .filter(|token| token.len() >= 20 && token.bytes().all(|b|
                    b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
                .ok_or("재발급 응답에 새 토큰이 없어 복구할 수 없습니다. 재발급 상태를 확인하세요.")?;
            if result["configured"] != true || result["rotated"] != true || !owner_configured(&root)? {
                return Err("새 Owner Token 설정을 검증하지 못했습니다. 연결을 재설정하기 전에 상태를 확인하세요.".into());
            }
            let mut value = response(true, true, false,
                "Tauri 전용 Owner Token을 재발급했습니다. 기존 OAuth 승인은 무효화됐으며 ChatGPT를 다시 연결해야 합니다.");
            value.port = configured_port(&root)?;
            // The canonical CLI persists only SHA-256; the optional DPAPI vault
            // allows safe later copying without reissuing a token.
            value.token_copy_available = crate::owner_token_vault::store(&root.home, token).is_ok();
            if !value.token_copy_available {
                value.details.push_str(" Windows 암호화 보관에 실패했으므로 이번 일회성 토큰을 반드시 복사해 보관하세요.");
            }
            value.one_time_owner_token = Some(token.to_string());
            value.tunnel_capable = root.cloudflared.is_some();
            Ok(value)
        }
        "start" | "start-public" | "stop" | "restart" => {
            let ready = owner_configured(&root)?;
            if !ready { return Err("먼저 전용 인스턴스 준비를 완료하세요.".into()); }
            let record = record_if_any(&root)?;
            if action == "start-public" && root.cloudflared.is_none() {
                return Err("검증된 Cloudflare Quick Tunnel 번들이 없습니다.".into());
            }
            if (action == "start" || action == "start-public") && record.is_some() {
                let value = status(&root)?;
                if value.running && action == "start-public" && !value.tunnel_running {
                    return Err("로컬 전용 MCP가 이미 실행 중입니다. 안전하게 중지한 후 공개 연결을 시작하세요.".into());
                }
                if value.running { return Ok(value); }
                return Err("기존 인스턴스 기록이 있습니다. 수동으로 상태를 확인하세요.".into());
            }
            if action != "start" && action != "start-public" && record.is_none() {
                return if action == "stop" {
                    status(&root)
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
            if action == "start" || action == "start-public" || action == "restart" {
                let was_public = action == "restart" && record.as_ref().is_some_and(|v|
                    v["tunnelMode"] == "cloudflare");
                start_owned_at_port(&root, configured_port(&root)?,
                    action == "start-public" || was_public)?;
            }
            status(&root)
        }
        _ => Err("허용되지 않은 CLI 명령입니다.".into()),
    }
}

/// Read-only preflight: without an owned record we must not conclude that a
/// process listening on the preview port belongs to this application.
fn exit_without_record_preflight(port_busy: bool) -> Result<(), &'static str> {
    if port_busy {
        Err("서버 포트에 다른 프로세스가 남아 있습니다. 소유권 기록이 없어 자동 종료하지 않습니다.")
    } else {
        Ok(())
    }
}

/// Opt-in update/complete-exit action. Does not exit the UI on failure.
/// Always uses the existing audited CLI stop/PID ownership checks, and only
/// the isolated preview instance. No taskkill or process-by-name termination.
pub(crate) fn stop_owned_for_complete_exit() -> Result<(), String> {
    let root = payload()?;
    ensure_workspace(&root)?;
    let lock = MUTATION_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().map_err(|_| "CLI 제어 잠금에 실패했습니다.")?;
    let record = record_if_any(&root)?;
    let active_port = record.as_ref().and_then(|r| r["port"].as_u64())
        .and_then(|n| u16::try_from(n).ok()).unwrap_or(configured_port(&root)?);
    if record.is_none() {
        return exit_without_record_preflight(port_occupied(active_port)).map_err(str::to_owned);
    }
    let result = cli_command(
        &root, &["stop", "--instance", INSTANCE], Duration::from_secs(30)
    )?;
    if result["stopped"] != true || result["instance"] != INSTANCE {
        return Err("전용 MCP 중지가 확인되지 않았습니다. 앱은 종료하지 않습니다.".into());
    }
    // Wait for the owned record to disappear and the port to be released.
    // If the CLI could not safely release the runtime, keep the UI available
    // for diagnosis and do not claim the installation can be removed.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let record_exists = record_if_any(&root)?.is_some();
        let busy = port_occupied(active_port);
        if !record_exists && !busy { return Ok(()); }
        if Instant::now() >= deadline {
            return Err(format!("MCP 종료 후에도 포트 {active_port} 또는 인스턴스 기록이 남았습니다. 앱을 유지하고 상태를 확인하세요."));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[tauri::command]
pub async fn manage_owned_cli(action: String) -> Result<ManagedResult, String> {
    if !matches!(action.as_str(), "status" | "prepare" | "rotate-token" | "start" | "start-public" | "stop" | "restart") {
        return Err("허용되지 않은 CLI 작업입니다.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root = payload()?;
        operate(root, &action)
    })
    .await
    .map_err(|_| "CLI 수명주기 작업이 실패했습니다.".to_owned())?
}

/// Native clipboard copy; the DPAPI-protected token never reaches the WebView.
#[tauri::command]
pub async fn copy_owned_owner_token(window: tauri::WebviewWindow) -> Result<(), String> {
    // OpenClipboard(NULL) followed by EmptyClipboard breaks SetClipboardData.
    // Use this authenticated Tauri window as the native clipboard owner.
    #[cfg(windows)]
    let owner_window = window.hwnd()
        .map_err(|_| "Tauri 창 핸들을 확인하지 못했습니다.".to_string())?.0 as usize;
    #[cfg(not(windows))]
    let owner_window = { let _ = window; 0usize };
    tauri::async_runtime::spawn_blocking(move || {
        let root = payload()?;
        let lock = MUTATION_LOCK.get_or_init(|| Mutex::new(()));
        let _guard = lock.lock().map_err(|_| "Owner Token 제어 잠금을 획득하지 못했습니다.")?;
        crate::owner_token_vault::copy_to_clipboard(&root.home, owner_window)
    }).await.map_err(|_| "토큰 복사 작업이 실패했습니다.".to_owned())?
}

/// Import requires an exact candidate matching this Tauri-only owner's hash.
#[tauri::command]
pub async fn register_owned_owner_token(candidate: String) -> Result<bool, String> {
    if candidate.len() > 160 { return Err("Owner Token 길이가 올바르지 않습니다.".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let root = payload()?;
        let lock = MUTATION_LOCK.get_or_init(|| Mutex::new(()));
        let _guard = lock.lock().map_err(|_| "Owner Token 제어 잠금을 획득하지 못했습니다.")?;
        crate::owner_token_vault::store(&root.home, &candidate)?;
        Ok(true)
    }).await.map_err(|_| "토큰 암호화 등록 작업이 실패했습니다.".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn native_status_uses_owned_record_without_running_node_or_modifying_files() {
        let base = std::env::temp_dir().join(format!(
            "c2c-native-status-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let root = Payload {
            node: base.join("not-a-runnable-node.exe"),
            cli: base.join("dist").join("cli.js"),
            home: base.join("home"),
            workspace: base.join("workspace"),
            cloudflared: None,
        };
        fs::create_dir_all(root.cli.parent().unwrap()).unwrap();
        fs::create_dir_all(&root.workspace).unwrap();
        fs::create_dir_all(state_record(&root).parent().unwrap()).unwrap();
        fs::write(&root.cli, b"this is deliberately not a Node script").unwrap();
        assert_eq!(native_pid_alive(std::process::id()), Some(true));
        let offline = native_console_status_for(&root, "status").unwrap().unwrap();
        assert_eq!(offline["alive"], false);
        assert_eq!(offline["healthy"], false);
        let record = serde_json::json!({
            "name": INSTANCE, "pid": std::process::id(),
            "entrypoint": root.cli.to_string_lossy(),
            "workspace": root.workspace.to_string_lossy(),
            "port": 7979, "host": "127.0.0.1", "tunnelMode": "none",
            "tunnelPid": null, "publicUrl": "http://127.0.0.1:7979"
        });
        let original = serde_json::to_vec(&record).unwrap();
        fs::write(state_record(&root), &original).unwrap();
        let start = Instant::now();
        let result = native_console_status_for(&root, "status").unwrap().unwrap();
        let elapsed = start.elapsed();
        assert_eq!(result["name"], INSTANCE);
        assert_eq!(result["alive"], true);
        assert!(result["healthy"].is_boolean());
        assert_eq!(result["tunnelAlive"], serde_json::Value::Null);
        assert_eq!(fs::read(state_record(&root)).unwrap(), original);
        let health = native_console_status_for(&root, "health").unwrap().unwrap();
        assert_eq!(health["instance"], INSTANCE);
        assert_eq!(health["alive"], true);
        assert_eq!(health["publicHealthy"], serde_json::Value::Null);
        println!("native read-only status fixture: {elapsed:?} (no Node executable)");
        // A foreign workspace cannot use the native fast path; ownership
        // remains subject to the old, hash-verified CLI fallback.
        let mut foreign = record;
        foreign["workspace"] = serde_json::json!(base.join("other").to_string_lossy());
        fs::write(state_record(&root), serde_json::to_vec(&foreign).unwrap()).unwrap();
        assert!(native_console_status_for(&root, "status").unwrap().is_none());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn saved_port_defaults_to_7979_and_rejects_invalid_config() {
        let base = std::env::temp_dir().join(format!(
            "c2c-owned-port-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let root = Payload {
            node: base.join("node.exe"), cli: base.join("cli.js"),
            home: base.join("home"), workspace: base.join("workspace"), cloudflared: None,
        };
        fs::create_dir_all(root.home.join(".config")).unwrap();
        assert_eq!(configured_port(&root).unwrap(), 7979);
        persist_port(&root, 18181).unwrap();
        assert_eq!(configured_port(&root).unwrap(), 18181);
        assert!(persist_port(&root, 0).is_err());
        fs::write(port_file(&root), "65536").unwrap();
        assert!(configured_port(&root).is_err());
        fs::write(port_file(&root), "abc").unwrap();
        assert!(configured_port(&root).is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn complete_exit_never_claims_unknown_process_on_preview_port() {
        assert!(exit_without_record_preflight(false).is_ok());
        assert!(exit_without_record_preflight(true).is_err());
    }

    #[test]
    fn token_rotation_requires_a_fully_stopped_owned_instance() {
        assert!(rotation_preflight(false, false).is_ok());
        assert!(rotation_preflight(true, false).is_err());
        assert!(rotation_preflight(false, true).is_err());
        assert!(rotation_preflight(true, true).is_err());
    }

    #[test]
    fn owned_quick_tunnel_requires_exact_origin_log_path_and_binary() {
        let temp = std::env::temp_dir().join(format!("c2c-owned-quick-fixture-{}", std::process::id()));
        let workspace = temp.join("workspace");
        let cli = temp.join("c2c-runtime").join("dist").join("cli.js");
        let node = temp.join("c2c-runtime").join("bin").join("node.exe");
        let cloudflared = temp.join("c2c-runtime").join("bin").join("cloudflared.exe");
        let logs = temp.join("isolated-home").join(".local").join("share")
            .join("chatgpt2codex").join("logs");
        let tunnel_log = logs.join(format!("{INSTANCE}.cloudflared.log"));
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(cli.parent().unwrap()).unwrap();
        fs::create_dir_all(node.parent().unwrap()).unwrap();
        fs::create_dir_all(&logs).unwrap();
        for file in [&cli, &node, &cloudflared, &tunnel_log] {
            fs::write(file, b"fixture").unwrap();
        }
        let root = Payload {
            node, cli: cli.clone(), home: temp.join("isolated-home"),
            workspace: workspace.clone(), cloudflared: Some(cloudflared),
        };
        let mut record = serde_json::json!({
            "entrypoint": cli.to_string_lossy().to_string(),
            "workspace": workspace.to_string_lossy().to_string(),
            "name": INSTANCE, "port": DEFAULT_PORT, "host": "127.0.0.1",
            "tunnelMode": "cloudflare", "tunnelPid": 123456,
            "publicUrl": "https://safety-test.trycloudflare.com",
            "tunnelLogPath": tunnel_log.to_string_lossy().to_string()
        });
        assert!(expected_record(&root, &record));
        record["publicUrl"] = serde_json::json!("https://localhost");
        assert!(!expected_record(&root, &record));
        record["publicUrl"] = serde_json::json!("https://safety-test.trycloudflare.com");
        record["tunnelLogPath"] = serde_json::json!("C:\\Users\\other\\cloudflared.log");
        assert!(!expected_record(&root, &record));
        record["tunnelLogPath"] = serde_json::json!(tunnel_log.to_string_lossy().to_string());
        let mut unsigned = root;
        unsigned.cloudflared = None;
        assert!(!expected_record(&unsigned, &record));
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn never_claim_foreign_pid_record_belongs_to_tauri() {
        let root = Payload {
            node: PathBuf::from(r"C:\preview\c2c-runtime\bin\node.exe"),
            cli: PathBuf::from(r"C:\preview\c2c-runtime\dist\cli.js"),
            home: PathBuf::from(r"C:\Users\test\AppData\Local\ChatGPTToCodex-Tauri-Preview\isolated-home"),
            workspace: PathBuf::from(r"C:\Users\test\AppData\Local\ChatGPTToCodex-Tauri-Preview\workspace"),
            cloudflared: None,
        };
        let other = serde_json::json!({
            "name":"default","port":7979,"host":"127.0.0.1",
            "entrypoint": r"C:\legacy\dist\cli.js","workspace":r"C:\Users\test\c2c-win-smoke",
            "tunnelMode":"cloudflare","tunnelPid":123,"publicUrl":"https://old.trycloudflare.com"
        });
        assert!(!expected_record(&root, &other));
    }

    #[test]
    fn default_port_is_7979_without_claiming_unknown_processes() {
        assert_eq!(DEFAULT_PORT, 7979);
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
    fn verified_quick_tunnel_manifest_rejects_tamper_and_accepts_old_no_tunnel() {
        let dir = std::env::temp_dir().join(format!("c2c-f5d1-manifest-{}", std::process::id()));
        let bundle = dir.join("c2c-runtime");
        let bin = bundle.join("bin");
        let dist = bundle.join("dist");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&dist).unwrap();
        let node = bin.join("node.exe");
        let cli = dist.join("cli.js");
        let tunnel = bin.join("cloudflared.exe");
        fs::write(&node, b"test-node").unwrap();
        fs::write(&cli, b"test-cli").unwrap();
        fs::write(&tunnel, b"test-tunnel").unwrap();
        let manifest_path = bundle.join("manifest.json");
        let base = serde_json::json!({
            "version": 1, "kind": MANIFEST_KIND,
            "instance": INSTANCE, "tunnel": "quick-ready",
            "nodeSha256": sha256_file(&node).unwrap(),
            "cliSha256": sha256_file(&cli).unwrap(),
            "cloudflaredSha256": sha256_file(&tunnel).unwrap()
        });
        fs::write(&manifest_path, base.to_string()).unwrap();
        assert!(verify_manifest(&dir).unwrap().2.is_some());
        fs::write(&tunnel, b"tampered").unwrap();
        assert!(verify_manifest(&dir).is_err());
        let mut broken = base.clone();
        broken.as_object_mut().unwrap().remove("cloudflaredSha256");
        fs::write(&manifest_path, broken.to_string()).unwrap();
        assert!(verify_manifest(&dir).is_err());
        let mut legacy = broken;
        legacy["tunnel"] = serde_json::json!("none");
        fs::write(&manifest_path, legacy.to_string()).unwrap();
        assert!(verify_manifest(&dir).unwrap().2.is_none());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_bundled_runtime_is_fail_closed() {
        let root = std::env::temp_dir().join("c2c-no-such-bundle-directory");
        assert!(verify_manifest(&root).is_err());
    }
}
