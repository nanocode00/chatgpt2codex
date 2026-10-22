use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInspection {
    pub available: bool,
    pub instance: String,
    pub alive: bool,
    pub healthy: bool,
    pub tunnel_alive: Option<bool>,
    pub public_healthy: Option<bool>,
    pub endpoint: Option<String>,
    pub public_connector: Option<String>,
    pub details: String,
}

fn unavailable(instance: String, details: &str) -> CliInspection {
    CliInspection {
        available: false,
        instance,
        alive: false,
        healthy: false,
        tunnel_alive: None,
        public_healthy: None,
        endpoint: None,
        public_connector: None,
        details: details.into(),
    }
}

pub(crate) fn valid_instance(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.bytes().all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
}

// The current preview *only* trusts the existing official Windows install.
// Do not resolve a CLI from PATH, accept an arbitrary executable from JS,
// run a shell or upgrade/rewrite any runtime files.
pub(crate) fn installed_windows_cli() -> Option<(PathBuf, PathBuf)> {
    if !cfg!(target_os = "windows") {
        return None;
    }
    let local_app_data = std::env::var_os("LOCALAPPDATA")?;
    let root = PathBuf::from(local_app_data)
        .join("Programs")
        .join("ChatGPT To Codex");
    let node = root.join("bin").join("node.exe");
    let cli = root.join("dist").join("cli.js");
    if !node.is_file() || !cli.is_file() {
        return None;
    }
    Some((node, cli))
}

/// Derive a copyable *public* MCP URL only from a successfully checked
/// HTTPS /healthz result. Refuse local, relative, credential, and malformed URLs.
fn public_connector_url(endpoint: &str) -> Option<String> {
    let rest = endpoint.strip_prefix("https://")?;
    let (host, suffix) = rest.split_once('/')?;
    if suffix != "healthz"
        || !host.contains('.')
        || host.starts_with('.')
        || host.ends_with('.')
        || host.len() > 253
        || !host.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
        || host.eq_ignore_ascii_case("localhost")
    {
        return None;
    }
    Some(format!("https://{host}/mcp"))
}

fn inspect_local_cli(instance: String) -> CliInspection {
    let Some((node, cli)) = installed_windows_cli() else {
        return unavailable(instance, "설치된 Windows C2C CLI를 찾지 못했습니다. 현재 Windows 공식 설치본에서만 지원합니다.");
    };
    let mut command = Command::new(&node);
    command.arg(&cli)
        .arg("health")
        .arg("--instance")
        .arg(&instance)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: inspecting the CLI must not flash a console.
        command.creation_flags(0x08000000);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return unavailable(instance, "설치된 C2C CLI 상태 조회를 실행하지 못했습니다."),
    };
    let deadline = Instant::now() + Duration::from_secs(9);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(80)),
            _ => {
                // Only terminate the inspection child *we* spawned, never the
                // running MCP server or cloudflared process.
                let _ = child.kill();
                let _ = child.wait();
                return unavailable(instance, "CLI 상태 조회가 제한 시간 내 완료되지 않았습니다.");
            }
        }
    }
    let output = match child.wait_with_output() {
        Ok(value) => value,
        Err(_) => return unavailable(instance, "CLI 응답을 읽지 못했습니다."),
    };
    if output.stdout.len() > 16_384 {
        return unavailable(instance, "CLI 상태 응답이 예상 크기를 초과했습니다.");
    }
    let payload: serde_json::Value = match serde_json::from_slice(&output.stdout) {
        Ok(value) => value,
        Err(_) => return unavailable(instance, "CLI에서 유효한 상태 JSON을 받지 못했습니다."),
    };
    if payload["instance"].as_str() != Some(instance.as_str()) {
        return unavailable(instance, "CLI 인스턴스 식별자가 예상과 다릅니다.");
    }
    let alive = payload["alive"].as_bool().unwrap_or(false);
    let healthy = payload["healthy"].as_bool().unwrap_or(false);
    CliInspection {
        available: true,
        instance,
        alive,
        healthy,
        tunnel_alive: payload["tunnelAlive"].as_bool(),
        public_healthy: payload["publicHealthy"].as_bool(),
        public_connector: if healthy
            && payload["tunnelAlive"] == true
            && payload["publicHealthy"] == true
        {
            payload["endpoint"].as_str().and_then(public_connector_url)
        } else {
            None
        },
        endpoint: payload["endpoint"].as_str().map(str::to_owned),
        details: if healthy {
            "설치된 C2C CLI 인스턴스가 정상 응답 중입니다.".into()
        } else {
            "설치된 C2C CLI에 기록된 인스턴스가 실행 중이 아니거나 응답하지 않습니다.".into()
        },
    }
}

#[tauri::command]
pub async fn inspect_cli_health(instance: String) -> Result<CliInspection, String> {
    if !valid_instance(&instance) {
        return Err("허용되지 않은 CLI 인스턴스 이름입니다.".into());
    }
    tauri::async_runtime::spawn_blocking(move || inspect_local_cli(instance))
        .await
        .map_err(|_| "CLI 상태 조회 작업이 실패했습니다.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_verified_https_health_endpoint_can_be_copied_as_public_mcp() {
        assert_eq!(
            public_connector_url("https://example.trycloudflare.com/healthz"),
            Some("https://example.trycloudflare.com/mcp".into())
        );
        assert_eq!(
            public_connector_url("https://c2c.example.org/healthz"),
            Some("https://c2c.example.org/mcp".into())
        );
        for candidate in [
            "http://127.0.0.1:7979/healthz",
            "https://example.org/mcp",
            "https://user@host.example/healthz",
            "https://host.example/healthz?x=1",
            "https://localhost/healthz",
            "https://host.example:8443/healthz",
            "https://.example.org/healthz",
        ] {
            assert_eq!(public_connector_url(candidate), None, "{candidate}");
        }
    }

    #[test]
    fn only_simple_instance_names_are_allowed() {
        assert!(valid_instance("default"));
        assert!(valid_instance("my_proj-2.1"));
        assert!(!valid_instance("../secret"));
        assert!(!valid_instance("has space"));
        assert!(!valid_instance(""));
        assert!(!valid_instance(&"a".repeat(65)));
    }
}
