//! F5-A: bounded, read-only catalog inspection for the isolated preview.
 //! No project selection, runtime reload, or secret retrieval.
use serde::{Deserialize, Serialize};

use crate::managed_cli;

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

fn inspect_catalog() -> Result<CatalogInspection, String> {
    // One canonical CLI request owns catalog validation and directory checks;
    // the native layer only adapts the response to presentation-safe fields.
    let catalog = (|| {
        let snapshot = managed_cli::read_combined_catalog()?;
        let projects = repositories(snapshot.clone())?;
        let profiles = profiles(snapshot)?;
        Ok::<_, String>((projects, profiles))
    })();
    let (available, projects, profiles, details) = match catalog {
        Ok((projects, profiles)) => (
            true, projects, profiles,
            "Tauri 전용 CLI에 등록된 작업 디렉터리 목록입니다. 프로젝트 전환 없이 여러 항목에 접근할 수 있으며, 프로필은 현재 조회 전용입니다.".into(),
        ),
        Err(reason) => (
            false, vec![], vec![],
            format!("격리된 CLI 목록을 조회하지 못했습니다: {reason}"),
        ),
    };
    Ok(CatalogInspection {
        available, projects, profiles, details,
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
}
