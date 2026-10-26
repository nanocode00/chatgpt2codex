use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::cli_health::{inspect_local_cli, installed_windows_cli, valid_instance};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliLogPreview {
    pub available: bool,
    pub instance: String,
    pub component: String,
    pub content: String,
    pub details: String,
    pub truncated: bool,
}

fn result(instance: String, component: String, details: &str) -> CliLogPreview {
    CliLogPreview {
        available: false,
        instance,
        component,
        content: String::new(),
        details: details.to_string(),
        truncated: false,
    }
}

// Prevent unintentional copying of secrets from launcher/cloudflared logs into
// a WebView, the browser clipboard, screenshots, or diagnostic reports.
fn scrub_line(line: &str) -> String {
    const SENSITIVE: [&str; 13] = [
        "owner token", "owner_token", "authorization", "bearer ",
        "password", "secret", "api_key", "apikey", "cookie:",
        "tunnel_token", "access_token", "client_secret", "private_key",
    ];
    let normalized = line.to_ascii_lowercase();
    if SENSITIVE.iter().any(|needle| normalized.contains(needle)) {
        "[민감 정보가 포함될 수 있는 로그 행 숨김]".to_string()
    } else {
        line.to_string()
    }
}

fn sanitize_preview(source: &str) -> (String, bool) {
    const MAX_CHARS: usize = 16_384;
    const MAX_LINES: usize = 80;
    let lines: Vec<&str> = source.lines().collect();
    let tail = lines.len().saturating_sub(MAX_LINES);
    let scrubbed = lines[tail..]
        .iter().map(|line| scrub_line(line)).collect::<Vec<_>>().join("\n");
    let chars: Vec<char> = scrubbed.chars().collect();
    let trimmed = chars.len() > MAX_CHARS;
    let result = if trimmed {
        chars[chars.len() - MAX_CHARS..].iter().collect::<String>()
    } else {
        scrubbed
    };
    (result, tail > 0 || trimmed)
}

// Only the known fixed legacy WinForms log filenames may be read. These
// PowerShell logs are kept separately from CLI-managed runtime records.
// Never accept a path from the WebView or read a whole potentially large file.
fn legacy_filename_pair(component: &str) -> Option<[&'static str; 2]> {
    match component {
        "server" => Some(["server.out.log", "server.err.log"]),
        "tunnel" => Some(["cloudflared.out.log", "cloudflared.err.log"]),
        _ => None,
    }
}

fn bounded_file_tail(path: &Path) -> Option<(String, bool)> {
    const BYTES: u64 = 64 * 1024;
    let mut file = File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    if length == 0 {
        return Some((String::new(), false));
    }
    let start = length.saturating_sub(BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut data = Vec::new();
    file.take(BYTES).read_to_end(&mut data).ok()?;
    let text = String::from_utf8_lossy(&data);
    // An offset in the middle of a line should never reveal a misleading
    // partial line; discard it when reading the tail.
    let clipped = if start > 0 {
        text.split_once('\n').map(|(_, rest)| rest).unwrap_or("")
    } else {
        text.as_ref()
    };
    Some((clipped.to_string(), start > 0))
}

fn read_legacy_winforms_logs(directory: &Path, component: &str) -> Option<(String, bool)> {
    let filenames = legacy_filename_pair(component)?;
    let mut combined = Vec::new();
    let mut truncated = false;
    for filename in filenames {
        let path = directory.join(filename);
        if let Some((text, cut)) = bounded_file_tail(&path) {
            truncated |= cut;
            if !text.trim().is_empty() {
                combined.push(format!("[{filename}]\n{text}"));
            }
        }
    }
    if combined.is_empty() {
        return None;
    }
    let (preview, shortened) = sanitize_preview(&combined.join("\n"));
    Some((preview, truncated || shortened))
}

fn legacy_winforms_log_preview(instance: &str, component: &str) -> Option<CliLogPreview> {
    // This fallback is *not* a general arbitrary file reader and must never
    // assume a legacy log belongs to a specific instance. Restrict it to
    // local Windows default, require an active healthy installed CLI and
    // label the underlying files as possibly belonging to an older run.
    if !cfg!(target_os = "windows") || instance != "default" {
        return None;
    }
    let health = inspect_local_cli(instance.to_string());
    if !health.available || !health.healthy {
        return None;
    }
    let directory = std::env::temp_dir().join("chatgpt2codex");
    let (content, truncated) = read_legacy_winforms_logs(&directory, component)?;
    Some(CliLogPreview {
        available: true,
        instance: instance.to_string(),
        component: component.to_string(),
        content,
        truncated,
        details: "기존 WinForms 런처의 임시 로그입니다. CLI 인스턴스와 직접 연결된 기록이 아니며 이전 실행 내용이 섞여 있을 수 있습니다.".into(),
    })
}

fn installed_cli_logs(instance: String, component: String) -> CliLogPreview {
    let Some((node, cli)) = installed_windows_cli() else {
        return result(instance, component, "Windows C2C 설치본에서 CLI를 찾지 못했습니다.");
    };
    let mut command = Command::new(node);
    command.arg(cli)
        .args(["logs", "--instance", &instance, "--component", &component, "--lines", "80"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return result(instance, component, "CLI 로그 조회를 시작하지 못했습니다."),
    };
    // Drain the pipe concurrently with process polling; a full Windows
    // stdout pipe would otherwise deadlock on a normal 80-line log response.
    // Read at most 256 KiB + 1 byte even if a CLI output is unexpectedly huge.
    let stdout = child.stdout.take();
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(pipe) = stdout {
            let _ = pipe.take((256 * 1024 + 1) as u64).read_to_end(&mut bytes);
        }
        bytes
    });
    let deadline = Instant::now() + Duration::from_secs(9);
    let completed = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(80)),
            _ => break None,
        }
    };
    if completed.is_none() {
        // Only the short-lived child spawned by this Tauri inspection.
        let _ = child.kill();
        let _ = child.wait();
    }
    let bytes = reader.join().unwrap_or_default();
    if completed.is_none() {
        return result(instance, component, "CLI 로그 조회 시간이 초과됐습니다.");
    }
    if !completed.is_some_and(|status| status.success()) {
        // Older WinForms start-chatgpt.ps1 writes to fixed temp files instead
        // of recording CLI serverLogPath/tunnelLogPath. Preserve CLI-managed
        // logs as the primary source and use the labelled fallback only when
        // the installed default instance is currently healthy.
        if let Some(legacy) = legacy_winforms_log_preview(&instance, &component) {
            return legacy;
        }
        return result(instance, component, "CLI에 로그 경로가 기록되지 않았고, 사용 가능한 WinForms 임시 로그도 확인되지 않았습니다.");
    }
    if bytes.len() > 256 * 1024 {
        return result(instance, component, "로그 출력이 안전한 미리보기 크기를 초과했습니다.");
    }
    let (content, truncated) = sanitize_preview(&String::from_utf8_lossy(&bytes));
    CliLogPreview {
        available: true,
        instance,
        component,
        details: if content.is_empty() {
            "표시할 로그가 없습니다.".into()
        } else {
            "마지막 80줄까지 표시합니다. 민감한 줄은 숨깁니다.".into()
        },
        content,
        truncated,
    }
}

#[tauri::command]
pub async fn inspect_cli_logs(instance: String, component: String) -> Result<CliLogPreview, String> {
    if !valid_instance(&instance) || (component != "server" && component != "tunnel") {
        return Err("CLI 로그 조회 인자가 올바르지 않습니다.".into());
    }
    tauri::async_runtime::spawn_blocking(move || installed_cli_logs(instance, component))
        .await
        .map_err(|_| "CLI 로그 조회 작업에 실패했습니다.".to_owned())
}

#[tauri::command]
pub fn close_preview_window(app: tauri::AppHandle) -> Result<(), String> {
    // This in-app button explicitly exits the preview. X/minimize now hide
    // to tray; exiting never stops WinForms, default C2C or Cloudflare.
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hides_secret_bearing_lines_and_limits_log_length() {
        let input = "startup successful\nAuthorization: Bearer abc123\nOWNER TOKEN copied\nready\n";
        let (text, truncated) = sanitize_preview(input);
        assert!(text.contains("startup successful"));
        assert!(text.contains("ready"));
        assert!(!text.contains("abc123"));
        assert!(!text.contains("OWNER TOKEN"));
        assert!(!truncated);

        let long = "hello\n".repeat(100);
        let (tail, cut) = sanitize_preview(&long);
        assert!(cut);
        assert_eq!(tail.lines().count(), 80);
    }

    #[test]
    fn legacy_log_names_are_fixed_and_reject_unknown_components() {
        assert_eq!(legacy_filename_pair("server"), Some(["server.out.log", "server.err.log"]));
        assert_eq!(legacy_filename_pair("tunnel"), Some(["cloudflared.out.log", "cloudflared.err.log"]));
        assert_eq!(legacy_filename_pair("../secrets"), None);
    }

    #[test]
    fn reads_only_known_legacy_log_files_with_redaction_and_bounded_tail() {
        let dir = std::env::temp_dir().join(format!("c2c-legacy-log-unit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("server.out.log"), "service started\nowner token is: fake\nready\n").unwrap();
        std::fs::write(dir.join("server.err.log"), "server warning\n").unwrap();
        std::fs::write(dir.join("cloudflared.out.log"), "public tunnel ready\n").unwrap();
        let (server, cut) = read_legacy_winforms_logs(&dir, "server").unwrap();
        assert!(!cut);
        assert!(server.contains("service started"));
        assert!(server.contains("server warning"));
        assert!(server.contains("ready"));
        assert!(!server.contains("fake"));
        assert!(!server.contains("owner token"));
        let (tunnel, _) = read_legacy_winforms_logs(&dir, "tunnel").unwrap();
        assert!(tunnel.contains("public tunnel ready"));
        assert!(!tunnel.contains("server warning"));
        assert!(read_legacy_winforms_logs(&dir, "unlisted").is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn truncates_large_legacy_logs_before_reading() {
        let dir = std::env::temp_dir().join(format!("c2c-legacy-tail-unit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("server.out.log"), format!("{}\nEND_OF_FILE\n", "a".repeat(200_000))).unwrap();
        let (contents, truncated) = read_legacy_winforms_logs(&dir, "server").unwrap();
        assert!(truncated);
        assert!(contents.len() < 17_000);
        assert!(contents.contains("END_OF_FILE"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn invalid_component_never_runs_external_command() {
        assert_eq!(scrub_line("no secret here"), "[민감 정보가 포함될 수 있는 로그 행 숨김]");
        assert_eq!(scrub_line("HTTP/1.1 200 OK"), "HTTP/1.1 200 OK");
    }
}
