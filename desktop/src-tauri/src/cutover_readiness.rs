//! F4-B: read-only, fail-closed preflight. This module MUST NOT start, stop,
//! restore or migrate any runtime; never send credential bytes or hashes to UI.
use crate::migration::{inspect_paths, os_paths};
use crate::migration_backup::inspect_backup_readiness;
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CutoverCheck {
    pub id: &'static str,
    pub label: &'static str,
    pub status: &'static str, // passed | blocked | unverified
    pub details: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CutoverReadiness {
    pub can_transition_now: bool,
    pub dry_run_only: bool,
    pub checks: Vec<CutoverCheck>,
}

fn check(
    id: &'static str,
    label: &'static str,
    status: &'static str,
    details: &'static str,
) -> CutoverCheck {
    CutoverCheck { id, label, status, details }
}

fn inspect_readiness(local: &Path, profile: &Path, preview: &Path) -> Result<CutoverReadiness, String> {
    let legacy = inspect_paths(local, profile, preview)?;
    let mut checks = Vec::new();
    checks.push(check("settings", "WinForms 설정 파일",
        if legacy.settings_found { "passed" } else { "blocked" },
        if legacy.settings_found { "기존 설정을 읽었습니다." } else { "기존 설정이 없어 전환할 수 없습니다." }));
    checks.push(check("project", "선택 프로젝트",
        if legacy.project_exists { "passed" } else { "blocked" },
        if legacy.project_exists { "설정된 프로젝트 디렉터리가 존재합니다." } else { "선택 프로젝트의 존재 여부를 확인해야 합니다." }));
    checks.push(check("owner", "Owner Token 해시 형식",
        if legacy.owner_hash_valid { "passed" } else { "blocked" },
        if legacy.owner_hash_valid { "Owner Token 검증 레코드 형식이 유효합니다. 토큰 원문은 확인하지 않았습니다." }
        else { "Owner Token 해시가 없거나 형식이 맞지 않습니다." }));
    checks.push(check("oauth", "OAuth 기록 형식",
        if legacy.oauth_valid { "passed" } else { "blocked" },
        if legacy.oauth_valid { "OAuth 구조를 확인했습니다. 실제 토큰 유효성과 인증 지속성은 미검증입니다." }
        else { "OAuth 인증 기록을 확인할 수 없습니다." }));
    let (exists, verified, current) = inspect_backup_readiness(local, profile, preview);
    checks.push(check("backup", "DPAPI 백업 무결성",
        if verified { "passed" } else { "blocked" },
        if verified { "현재 Windows 사용자로 백업 복호화 및 무결성 검사를 통과했습니다." }
        else if exists { "백업이 있지만 이 Windows 사용자로 무결성을 검증하지 못했습니다." }
        else { "암호화 백업이 없습니다." }));
    checks.push(check("snapshot", "원본과 백업 일치",
        if current { "passed" } else { "blocked" },
        if current { "백업 내 파일과 현재 원본이 반복 검사 시 일치했습니다. 원자적 백업은 아닙니다." }
        else { "원본이 변경되었거나 일치 여부를 검증하지 못했습니다. 기존 백업을 덮어쓰지 않습니다." }));
    let port = legacy.port.unwrap_or(7979);
    // The HTTP health identity check is read-only; TCP listening by itself
    // is NEVER interpreted as proof of C2C process ownership.
    let health = if legacy.local_port_listening {
        Some(crate::probe_local_runtime(port).online)
    } else { None };
    checks.push(check("local-health", "기존 로컬 MCP 응답",
        match health { Some(true) => "passed", Some(false) => "blocked", None => "unverified" },
        match health {
            Some(true) => "해당 localhost 포트의 C2C Health 응답을 확인했습니다. PID 소유권 증거는 아닙니다.",
            Some(false) => "포트를 점유한 서비스의 C2C Health 식별에 실패했습니다.",
            None => "기존 MCP 서버가 응답 중이 아니거나 포트가 비어 있습니다.",
        }));
    checks.push(check("pid-owner", "기존 서버·터널 PID 소유권", "unverified",
        "PID 기록과 Health만으로 소유권을 증명할 수 없습니다. 실행 파일·명령행·시작 시간과 포트 주인을 별도 확인해야 합니다."));
    checks.push(check("public-issuer", "공개 OAuth 주소 지속성", "unverified",
        "실제 ChatGPT 연결의 OAuth issuer, 토큰 만료·scope 및 터널 주소 유지 여부는 아직 검증되지 않았습니다."));
    checks.push(check("rollback", "독립 롤백·복구 보증", "blocked",
        "운영 서버에 대한 원자적 전환 저널, 독립 백업과 안전한 롤백 엔진이 아직 없습니다."));
    checks.push(check("feature-parity", "설치·트레이·자동 시작 호환", "unverified",
        "Windows 실제 운영 설치의 기능 동등성과 사용 승인 검증이 필요합니다."));
    Ok(CutoverReadiness { can_transition_now: false, dry_run_only: true, checks })
}

#[tauri::command]
pub async fn inspect_cutover_readiness() -> Result<CutoverReadiness, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (local, profile, preview) = os_paths()?;
        inspect_readiness(&local, &profile, &preview)
    }).await.map_err(|_| "읽기 전용 전환 점검이 실패했습니다.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn preflight_is_always_no_go_and_discloses_no_credentials() {
        let root = std::env::temp_dir().join(format!("c2c-f4b-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let local = root.join("local");
        let profile = root.join("profile");
        let preview = root.join("preview");
        fs::create_dir_all(&local).unwrap();
        let result = inspect_readiness(&local, &profile, &preview).unwrap();
        assert!(!result.can_transition_now && result.dry_run_only);
        assert!(result.checks.iter().any(|c| c.id == "rollback" && c.status == "blocked"));
        assert!(result.checks.iter().any(|c| c.id == "pid-owner" && c.status == "unverified"));
        assert!(!preview.exists(), "read-only check must not create preview files");
        let json = serde_json::to_string(&result).unwrap();
        assert!(!json.contains("tokenHash"));
        assert!(!json.contains("oauth.json"));
        fs::remove_dir_all(&root).unwrap();
    }
}
