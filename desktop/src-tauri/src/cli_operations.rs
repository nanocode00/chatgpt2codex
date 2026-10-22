use serde::Serialize;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::cli_health::{installed_windows_cli, valid_instance};

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
    let deadline = Instant::now() + Duration::from_secs(9);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(80)),
            _ => {
                // Only the child spawned for this one read-only CLI invocation.
                let _ = child.kill();
                let _ = child.wait();
                return result(instance, component, "CLI 로그 조회 시간이 초과됐습니다.");
            }
        }
    }
    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(_) => return result(instance, component, "CLI 로그를 읽지 못했습니다."),
    };
    if !output.status.success() {
        return result(instance, component, "이 인스턴스의 로그를 찾지 못했거나 설치된 CLI가 로그 조회를 지원하지 않습니다.");
    }
    // The CLI itself tails the last 80 lines; reject excessive output rather
    // than collecting huge amounts of arbitrary content in the WebView.
    if output.stdout.len() > 256 * 1024 {
        return result(instance, component, "로그 출력이 안전한 미리보기 크기를 초과했습니다.");
    }
    let (content, truncated) = sanitize_preview(&String::from_utf8_lossy(&output.stdout));
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
pub fn close_preview_window(window: tauri::Window) -> Result<(), String> {
    // Closing the Tauri preview never stops the separate Windows WinForms
    // process, its existing MCP server, or the Cloudflare tunnel.
    window.close().map_err(|_| "Tauri 창을 닫지 못했습니다.".to_owned())
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
    fn invalid_component_never_runs_external_command() {
        assert_eq!(scrub_line("no secret here"), "[민감 정보가 포함될 수 있는 로그 행 숨김]");
        assert_eq!(scrub_line("HTTP/1.1 200 OK"), "HTTP/1.1 200 OK");
    }
}
