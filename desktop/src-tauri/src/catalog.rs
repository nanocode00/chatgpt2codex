//! F5-A: bounded, read-only catalog inspection for the isolated preview.
 //! No project selection, runtime reload, legacy mutation, or secret retrieval.
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::{managed_cli, migration};

const MAX_ENTRIES: usize = 128;
const MAX_LABEL: usize = 160;

#[derive(Deserialize)]
struct RepositoryList { repositories: Vec<RepositoryEntry> }
#[derive(Deserialize)]
struct RepositoryEntry { id: String, name: String, available: bool }
#[derive(Deserialize)]
struct ProfileList { profiles: Vec<ProfileEntry> }
#[derive(Deserialize)]
struct ProfileEntry { alias: String, python: bool, docker: bool }

#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRepository {
    id: String,
    name: String,
    available: bool,
}
#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CatalogProfile {
    alias: String,
    python: bool,
    docker: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogInspection {
    pub available: bool,
    pub projects: Vec<CatalogRepository>,
    pub profiles: Vec<CatalogProfile>,
    pub selected_repository: Option<String>,
    pub legacy_project: Option<String>,
    pub legacy_project_exists: bool,
    pub details: String,
}

fn valid_label(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= MAX_LABEL &&
        !value.chars().any(char::is_control)
}
fn valid_identifier(value: &str) -> bool {
    valid_label(value) && value.bytes().all(|b|
        b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

fn repositories(json: serde_json::Value) -> Result<Vec<CatalogRepository>, String> {
    let list: RepositoryList = serde_json::from_value(json)
        .map_err(|_| "프로젝트 목록 JSON 형식이 올바르지 않습니다.")?;
    if list.repositories.len() > MAX_ENTRIES {
        return Err("프로젝트 목록이 허용된 범위를 초과합니다.".into());
    }
    list.repositories.into_iter().map(|entry| {
        if !valid_identifier(&entry.id) || !valid_label(&entry.name) {
            return Err("검증되지 않은 프로젝트 이름 또는 ID입니다.".into());
        }
        Ok(CatalogRepository {
            id: entry.id, name: entry.name, available: entry.available,
        })
    }).collect()
}

fn profiles(json: serde_json::Value) -> Result<Vec<CatalogProfile>, String> {
    let list: ProfileList = serde_json::from_value(json)
        .map_err(|_| "프로필 목록 JSON 형식이 올바르지 않습니다.")?;
    if list.profiles.len() > MAX_ENTRIES {
        return Err("프로필 목록이 허용된 범위를 초과합니다.".into());
    }
    list.profiles.into_iter().map(|entry| {
        if !valid_identifier(&entry.alias) || !(entry.python || entry.docker) {
            return Err("검증되지 않은 프로필 정보입니다.".into());
        }
        Ok(CatalogProfile {
            alias: entry.alias, python: entry.python, docker: entry.docker,
        })
    }).collect()
}

fn legacy_selected_project(local: &Path) -> Result<Option<String>, String> {
    let dir = local.join(migration::LEGACY_APP_DIR);
    let settings = migration::read_limited(
        &dir.join("settings.ini"), migration::MAX_SETTINGS_BYTES,
    )?;
    let configured = if let Some(bytes) = settings {
        let text = String::from_utf8(bytes)
            .map_err(|_| "WinForms 설정 문자의 인코딩을 읽을 수 없습니다.")?;
        migration::parse_ini(&text)?.get("ProjectFolder").cloned()
    } else { None };
    let project = if configured.as_ref().is_some_and(|p| !p.trim().is_empty()) {
        configured
    } else {
        migration::read_limited(
            &dir.join("selected-project.txt"), migration::MAX_SETTINGS_BYTES,
        )?.map(|bytes| {
            String::from_utf8(bytes)
                .map(|s| s.trim_start_matches('\u{feff}').trim().to_string())
                .map_err(|_| "WinForms 프로젝트 선택 파일 인코딩을 읽을 수 없습니다.".to_string())
        }).transpose()?
    };
    let project = project.filter(|value| !value.trim().is_empty());
    if project.as_ref().is_some_and(|value| value.len() > 4096 || value.chars().any(char::is_control)) {
        return Err("WinForms 프로젝트 경로의 길이 또는 형식이 유효하지 않습니다.".into());
    }
    Ok(project)
}

fn inspect_catalog() -> Result<CatalogInspection, String> {
    let (local, _profile, _preview) = migration::os_paths()?;
    let legacy_project = legacy_selected_project(&local)?;
    let legacy_project_exists = legacy_project.as_ref().is_some_and(|p| Path::new(p).is_dir());

    // This uses an exact manifest/hash-verified bundled Node+CLI and the
    // isolated HOME/XDG_CONFIG_HOME. It NEVER reads the legacy CLI catalogs.
    // If no owned catalog exists yet, the CLI returns empty lists; no init.
    let catalog = (|| {
        let projects = repositories(managed_cli::read_catalog_command("repository")?)?;
        let profiles = profiles(managed_cli::read_catalog_command("profile")?)?;
        let selected = managed_cli::inspect_selected_repository()?;
        if selected.as_ref().is_some_and(|id| !projects.iter().any(|entry| &entry.id == id)) {
            return Err("선택된 프로젝트가 Tauri 전용 목록에 없습니다.".into());
        }
        Ok::<_, String>((projects, profiles, selected))
    })();
    let (available, projects, profiles, selected_repository, details) = match catalog {
        Ok((projects, profiles, selected)) => (
            true, projects, profiles, selected,
            "Tauri 전용 CLI 카탈로그입니다. 등록된 프로젝트만 선택할 수 있으며, 프로필은 조회 전용입니다.".into(),
        ),
        Err(reason) => (
            false, vec![], vec![], None,
            format!("격리된 CLI 목록을 조회하지 못했습니다: {reason}"),
        ),
    };
    Ok(CatalogInspection {
        available, projects, profiles, selected_repository, legacy_project, legacy_project_exists, details,
    })
}

#[tauri::command]
pub async fn inspect_owned_catalog() -> Result<CatalogInspection, String> {
    tauri::async_runtime::spawn_blocking(inspect_catalog)
        .await.map_err(|_| "프로젝트/프로필 목록 조회에 실패했습니다.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn list_parses_and_does_not_expose_repository_roots() {
        let list = repositories(serde_json::json!({"repositories": [
            {"id":"proj-a","name":"Project A","root":"C:\\private\\secret","available":true}
        ]})).unwrap();
        assert_eq!(list.len(), 1);
        let json = serde_json::to_string(&list).unwrap();
        assert!(!json.contains("private"));
        assert!(!json.contains("root"));
        assert_eq!(list[0].id, "proj-a");
    }
    #[test]
    fn rejects_malformed_or_unbounded_project_and_profile_catalogs() {
        assert!(repositories(serde_json::json!({"profiles":[]})).is_err());
        assert!(repositories(serde_json::json!({"repositories":[{"id":"bad\nname","name":"x","available":true}]})).is_err());
        assert!(repositories(serde_json::json!({"repositories": vec![serde_json::json!({"id":"ok","name":"Ok","available":true}); 129]})).is_err());
        assert!(profiles(serde_json::json!({"profiles":[{"alias":"py","python":true,"docker":false}]})).is_ok());
        assert!(profiles(serde_json::json!({"profiles":[{"alias":"broken","python":false,"docker":false}]})).is_err());
    }
    #[test]
    fn legacy_project_is_read_only_and_prioritizes_settings_value() {
        let base = std::env::temp_dir().join(format!("c2c-f5a-legacy-{}", std::process::id()));
        let dir = base.join(migration::LEGACY_APP_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        let p = base.join("owned-project");
        let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, p.to_string_lossy().as_bytes());
        std::fs::write(dir.join("settings.ini"), format!("ProjectFolder={encoded}\n")).unwrap();
        std::fs::write(dir.join("selected-project.txt"), "obsolete").unwrap();
        assert_eq!(legacy_selected_project(&base).unwrap(), Some(p.to_string_lossy().to_string()));
        std::fs::remove_dir_all(base).unwrap();
    }
}
