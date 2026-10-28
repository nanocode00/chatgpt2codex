//! F5-B: narrow native actions for this Tauri preview UI.
//! No external URL or executable is accepted from the WebView.
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

fn fixed_url(kind: &str) -> Option<&'static str> {
    match kind {
        "github" => Some("https://github.com/nanocode00/chatgpt2codex"),
        "developer" => Some("https://github.com/nanocode00"),
        _ => None,
    }
}

fn local_health_url(port: u16) -> Result<String, String> {
    if port == 0 {
        return Err("로컬 Health 포트가 유효하지 않습니다.".into());
    }
    Ok(format!("http://127.0.0.1:{port}/healthz"))
}

#[tauri::command]
pub fn hide_preview_window(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        crate::tray_lifecycle::hide_main(&app)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("Windows Tauri 트레이에서만 지원합니다.".into())
    }
}

#[tauri::command]
pub async fn open_trusted_link(app: AppHandle, kind: String, port: Option<u16>) -> Result<(), String> {
    // These destinations are constructed natively. Never accept raw URLs
    // from JavaScript or hand user-controlled strings to the OS opener.
    let url = if let Some(url) = fixed_url(&kind) {
        url.to_string()
    } else {
        match kind.as_str() {
            "local_health" => {
                let port = port.ok_or("로컬 Health 포트가 필요합니다.")?;
                let status = crate::runtime_health(port).await?;
                if !status.online {
                    return Err("해당 포트에서 C2C 서버가 확인되지 않아 열지 않았습니다.".into());
                }
                local_health_url(port)?
            }
            "public_health" => {
                // Revalidate on click; a previously displayed Quick Tunnel
                // URL may be stale after sleep or a tunnel restart.
                let health = crate::public_health::inspect_public_tunnel_health(
                    "default".to_string()
                ).await?;
                if health.state != "online" {
                    return Err("검증된 공개 Quick Tunnel이 없어 열지 않았습니다.".into());
                }
                let connector = health.endpoint.ok_or("공개 커넥터 주소가 없습니다.")?;
                crate::public_health::quick_tunnel_health_url(&connector)
                    .ok_or("신뢰할 수 있는 Quick Tunnel 주소가 아닙니다.")?
            }
            _ => return Err("허용되지 않은 외부 링크 유형입니다.".into()),
        }
    };
    app.opener().open_url(url, None::<&str>)
        .map_err(|_| "기본 브라우저를 열지 못했습니다.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_fixed_external_links_are_allowed() {
        assert_eq!(fixed_url("github"), Some("https://github.com/nanocode00/chatgpt2codex"));
        assert_eq!(fixed_url("developer"), Some("https://github.com/nanocode00"));
        for kind in ["", "file://", "https://evil.example", "powershell", "update"] {
            assert!(fixed_url(kind).is_none());
        }
    }
    #[test]
    fn local_health_url_is_loopback_only() {
        assert!(local_health_url(0).is_err());
        assert_eq!(local_health_url(7979).unwrap(), "http://127.0.0.1:7979/healthz");
    }
}
