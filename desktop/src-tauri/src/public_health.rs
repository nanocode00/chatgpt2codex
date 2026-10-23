use serde::Serialize;
use std::io::Read;
use std::time::Duration;

use crate::cli_health::{inspect_local_cli, valid_instance};

/// This stage is read-only and intentionally supports Cloudflare *Quick*
/// Tunnels only. Arbitrary URL probing or user-supplied hosts could turn a
/// desktop health check into SSRF against private devices. Named Tunnel
/// support requires its own explicit endpoint trust policy.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicTunnelHealth {
    pub state: &'static str,
    pub endpoint: Option<String>,
    pub details: String,
}

fn snapshot(state: &'static str, endpoint: Option<String>, details: &str) -> PublicTunnelHealth {
    PublicTunnelHealth {
        state,
        endpoint,
        details: details.into(),
    }
}

/// Accept only the exact Quick Tunnel origin recorded by our installed CLI.
/// Do not follow redirects, probe arbitrary addresses, or contact localhost.
fn quick_tunnel_health_url(mcp_url: &str) -> Option<String> {
    let hostname = mcp_url
        .strip_prefix("https://")?
        .strip_suffix("/mcp")?;
    if hostname.len() < ".trycloudflare.com".len() + 2
        || hostname.len() > 253
        || !hostname.ends_with(".trycloudflare.com")
        || hostname.starts_with('-')
        || hostname.contains("..")
        || !hostname
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'.' || c == b'-')
    {
        return None;
    }
    let subdomain = hostname.strip_suffix(".trycloudflare.com")?;
    if subdomain.is_empty() || subdomain.starts_with('.') || subdomain.ends_with('-') {
        return None;
    }
    Some(format!("https://{hostname}/healthz"))
}

fn valid_health_response(status: u16, content: &[u8]) -> bool {
    if status != 200 || content.len() > 8 * 1024 {
        return false;
    }
    match serde_json::from_slice::<serde_json::Value>(content) {
        Ok(value) => value["ok"] == true && value["name"] == "chatgpt2codex",
        Err(_) => false,
    }
}

fn inspect_public_tunnel(instance: String) -> PublicTunnelHealth {
    let cli = inspect_local_cli(instance);
    if !cli.available {
        return snapshot("unavailable", None, "Windows CLI 상태를 조회할 수 없습니다.");
    }
    if !cli.healthy {
        return snapshot("unavailable", None, "로컬 CLI 인스턴스가 응답하지 않습니다.");
    }
    let Some(connector) = cli.public_connector else {
        return snapshot("unavailable", None, "CLI에 공개 HTTPS 커넥터 주소가 기록되지 않았습니다.");
    };
    let Some(health_url) = quick_tunnel_health_url(&connector) else {
        return snapshot(
            "unsupported",
            Some(connector),
            "이 버전은 Quick Tunnel만 직접 검사합니다. 고정 도메인/기타 주소는 외부 검증 전까지 미확인으로 표시합니다.",
        );
    };

    // Native Rust HTTPS request. No Owner Token, no redirects, and no
    // arbitrary URL from JavaScript. A DNS failure after
    // laptop sleep is a real *public* failure even if localhost is healthy.
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout_connect(Duration::from_secs(4))
        .timeout_read(Duration::from_secs(4))
        .timeout_write(Duration::from_secs(4))
        .build();

    match agent.get(&health_url).set("Accept", "application/json").call() {
        Ok(response) => {
            let status = response.status();
            let mut bytes = Vec::new();
            let length_ok = response
                .into_reader()
                .take(8 * 1024 + 1)
                .read_to_end(&mut bytes)
                .is_ok();
            if length_ok && valid_health_response(status, &bytes) {
                snapshot("online", Some(connector), "외부 HTTPS Health가 C2C 서버임을 확인했습니다.")
            } else {
                snapshot("offline", Some(connector), "공개 주소가 올바른 C2C Health 응답을 반환하지 않습니다.")
            }
        }
        Err(ureq::Error::Status(_, _)) => snapshot(
            "offline",
            Some(connector),
            "공개 주소가 오류 HTTP 상태를 반환했습니다. Quick Tunnel 주소를 확인하세요.",
        ),
        Err(_) => snapshot(
            "offline",
            Some(connector),
            "공개 주소에 접근할 수 없습니다. 절전 복귀 후 터널 종료 또는 DNS 주소 만료 가능성이 있습니다.",
        ),
    }
}

#[tauri::command]
pub async fn inspect_public_tunnel_health(instance: String) -> Result<PublicTunnelHealth, String> {
    if !valid_instance(&instance) {
        return Err("허용되지 않은 CLI 인스턴스 이름입니다.".into());
    }
    tauri::async_runtime::spawn_blocking(move || inspect_public_tunnel(instance))
        .await
        .map_err(|_| "공개 상태 검사 작업이 실패했습니다.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_exact_cloudflare_quick_tunnel_hostname_is_allowed() {
        assert_eq!(
            quick_tunnel_health_url("https://summer-fill-openings-chemistry.trycloudflare.com/mcp"),
            Some("https://summer-fill-openings-chemistry.trycloudflare.com/healthz".into()),
        );
        for candidate in [
            "http://valid.trycloudflare.com/mcp",
            "https://valid.trycloudflare.com.evil.test/mcp",
            "https://localhost/mcp",
            "https://127.0.0.1/mcp",
            "https://valid.trycloudflare.com:443/mcp",
            "https://user@valid.trycloudflare.com/mcp",
            "https://valid.trycloudflare.com/mcp?secret=x",
            "https://valid.trycloudflare.com/anything/mcp",
            "https://OTHER.trycloudflare.com/mcp",
            "https://bad..trycloudflare.com/mcp",
            "https://c2c.example.com/mcp",
        ] {
            assert_eq!(quick_tunnel_health_url(candidate), None, "{candidate}");
        }
    }

    #[test]
    fn public_health_requires_both_http_success_and_c2c_identity() {
        assert!(valid_health_response(200, br#"{"ok":true,"name":"chatgpt2codex"}"#));
        assert!(!valid_health_response(200, br#"{"ok":true,"name":"other"}"#));
        assert!(!valid_health_response(404, br#"{"ok":true,"name":"chatgpt2codex"}"#));
        assert!(!valid_health_response(200, b"<html>login</html>"));
    }
}
