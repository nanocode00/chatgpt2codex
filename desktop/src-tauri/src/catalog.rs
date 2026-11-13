//! F5-A: bounded, read-only catalog inspection for the isolated preview.
 //! No project selection, runtime reload, or secret retrieval.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

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
    valid_label(value) && value.len() <= 64 && value.bytes().all(|b|
        b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        && value.bytes().next().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && !value.contains("..")
}

fn valid_docker_config(value: &Value) -> bool {
    let Some(object) = value.as_object() else { return false };
    if object.keys().any(|key| !matches!(key.as_str(),
        "composeFile" | "projectName" | "services" | "controlServices")) { return false; }
    let Some(compose) = value["composeFile"].as_str() else { return false };
    let path = Path::new(compose);
    if compose.is_empty() || path.is_absolute() ||
        path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return false;
    }
    let Some(project) = value["projectName"].as_str() else { return false };
    if project.is_empty() || project.len() > 63 ||
        !project.bytes().next().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) ||
        !project.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(&b)) {
        return false;
    }
    let Some(services) = value["services"].as_array().filter(|v| !v.is_empty() && v.len() <= 100)
        else { return false };
    let mut seen = HashSet::new();
    for service in services {
        let Some(name) = service.as_str() else { return false };
        if name.is_empty() || name.len() > 128 ||
            !name.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric()) ||
            !name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) ||
            !seen.insert(name) {
            return false;
        }
    }
    if let Some(controls) = value.get("controlServices") {
        let Some(items) = controls.as_array().filter(|v| v.len() <= 100) else { return false };
        let mut control_seen = HashSet::new();
        for item in items {
            let Some(name) = item.as_str() else { return false };
            if !seen.contains(name) || !control_seen.insert(name) { return false; }
        }
    }
    true
}

/// Read the two versioned catalog files from the *isolated* Tauri config
/// directory. This read-only path never executes or trusts a Node binary.
fn isolated_config_dir() -> Result<PathBuf, String> {
    let local = std::env::var_os("LOCALAPPDATA")
        .ok_or("Windows 로컬 데이터 경로를 찾지 못했습니다.")?;
    Ok(PathBuf::from(local)
        .join("ChatGPTToCodex-Tauri-Preview").join("isolated-home")
        .join(".config").join("chatgpt2codex"))
}

fn bounded_catalog_json(dir: &Path, filename: &str) -> Result<Option<Value>, String> {
    if !matches!(filename, "repositories.json" | "profiles.json") {
        return Err("허용되지 않은 목록 파일입니다.".into());
    }
    let path = dir.join(filename);
    let meta = match fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("설정 파일 접근에 실패했습니다.".into()),
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 512 * 1024 {
        return Err("목록 파일 형식 또는 크기가 올바르지 않습니다.".into());
    }
    let bytes = fs::read(path).map_err(|_| "목록 파일을 읽지 못했습니다.")?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "목록 파일 JSON이 유효하지 않습니다.")?;
    if value["version"] != 1 {
        return Err("지원되지 않는 목록 파일 버전입니다.".into());
    }
    Ok(Some(value))
}

fn native_repositories(dir: &Path) -> Result<Value, String> {
    let value = bounded_catalog_json(dir, "repositories.json")?;
    let Some(value) = value else { return Ok(json!({"repositories": []})); };
    let entries = value["repositories"].as_array()
        .filter(|entries| entries.len() <= MAX_ENTRIES)
        .ok_or("프로젝트 목록 형식 또는 개수가 올바르지 않습니다.")?;
    let mut ids = HashSet::new();
    let mut result = Vec::with_capacity(entries.len());
    for row in entries {
        let id = row["id"].as_str().ok_or("프로젝트 ID가 유효하지 않습니다.")?;
        let name = row["name"].as_str().ok_or("프로젝트 이름이 유효하지 않습니다.")?;
        let root = row["root"].as_str().ok_or("프로젝트 경로가 유효하지 않습니다.")?;
        if !valid_identifier(id) || !valid_label(name) || !ids.insert(id.to_owned())
            || !Path::new(root).is_absolute() {
            return Err("프로젝트 목록 데이터가 유효하지 않습니다.".into());
        }
        result.push(json!({
            "id": id, "name": name.trim(), "available": Path::new(root).is_dir()
        }));
    }
    Ok(json!({"repositories": result}))
}

fn native_profiles(dir: &Path) -> Result<Value, String> {
    let value = bounded_catalog_json(dir, "profiles.json")?;
    let Some(value) = value else { return Ok(json!({"profiles": []})); };
    let empty = serde_json::Map::new();
    let py = match value.get("python") {
        Some(v) => v.as_object().ok_or("Python 프로필 형식이 유효하지 않습니다.")?,
        None => &empty,
    };
    let dk = match value.get("docker") {
        Some(v) => v.as_object().ok_or("Docker 프로필 형식이 유효하지 않습니다.")?,
        None => &empty,
    };
    if py.len() + dk.len() > MAX_ENTRIES * 2 {
        return Err("프로필 개수가 너무 많습니다.".into());
    }
    let mut aliases = HashSet::new();
    for (alias, path) in py {
        if alias == "auto" || !valid_identifier(alias)
            || !path.as_str().is_some_and(|p| Path::new(p).is_absolute()) {
            return Err("Python 프로필 별칭 또는 경로가 올바르지 않습니다.".into());
        }
        aliases.insert(alias.clone());
    }
    for (alias, value) in dk {
        if alias == "auto" || !valid_identifier(alias) || !valid_docker_config(value) {
            return Err("Docker 프로필 별칭 또는 형식이 올바르지 않습니다.".into());
        }
        aliases.insert(alias.clone());
    }
    if aliases.len() > MAX_ENTRIES {
        return Err("프로필 목록이 너무 많습니다.".into());
    }
    let mut names: Vec<_> = aliases.into_iter().collect();
    names.sort();
    let rows: Vec<_> = names.iter().map(|alias| json!({
        "alias": alias, "python": py.contains_key(alias), "docker": dk.contains_key(alias)
    })).collect();
    Ok(json!({"profiles": rows}))
}

pub(crate) fn native_catalog_command(command: &str) -> Result<Value, String> {
    let config = isolated_config_dir()?;
    match command {
        "repository" => native_repositories(&config),
        "profile" => native_profiles(&config),
        _ => Err("지원되지 않는 읽기 전용 목록입니다.".into()),
    }
}

pub(crate) fn native_profile_detail(alias: &str) -> Result<Value, String> {
    native_profile_detail_from(&isolated_config_dir()?, alias)
}

fn native_profile_detail_from(dir: &Path, alias: &str) -> Result<Value, String> {
    if !valid_identifier(alias) || alias == "auto" {
        return Err("프로필 별칭 형식이 올바르지 않습니다.".into());
    }
    let value = bounded_catalog_json(dir, "profiles.json")?
        .ok_or("프로필을 찾지 못했습니다.")?;
    let python = value.get("python").and_then(Value::as_object)
        .and_then(|profiles| profiles.get(alias));
    let docker = value.get("docker").and_then(Value::as_object)
        .and_then(|profiles| profiles.get(alias));
    if python.is_none() && docker.is_none() {
        return Err("등록된 프로필이 없습니다.".into());
    }
    if python.is_some_and(|value| !value.as_str().is_some_and(|path| Path::new(path).is_absolute())) {
        return Err("Python 경로 형식이 올바르지 않습니다.".into());
    }
    if docker.is_some_and(|config| !valid_docker_config(config)) {
        return Err("Docker 프로필 형식이 올바르지 않습니다.".into());
    }
    Ok(json!({
        "alias": alias,
        "python": python.cloned().unwrap_or(Value::Null),
        "docker": docker.cloned().unwrap_or(Value::Null)
    }))
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
    // Native read-only snapshot: no child Node process or repeated manifest
    // SHA-256 checks to enumerate two small, versioned JSON catalogs.
    let catalog = (|| {
        let dir = isolated_config_dir()?;
        let projects = repositories(native_repositories(&dir)?)?;
        let profiles = profiles(native_profiles(&dir)?)?;
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
    fn native_catalog_reads_bounded_isolated_fixtures_without_starting_node() {
        let timer = std::time::Instant::now();
        let base = std::env::temp_dir().join(format!("c2c-native-catalog-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let config = base.join("config");
        let project = base.join("repository");
        fs::create_dir_all(&config).unwrap();
        fs::create_dir_all(&project).unwrap();
        fs::write(config.join("repositories.json"), serde_json::to_vec(&json!({
            "version":1, "repositories":[{"id":"test-one", "name":"Test One",
                "root":project.to_string_lossy()}]
        })).unwrap()).unwrap();
        fs::write(config.join("profiles.json"), serde_json::to_vec(&json!({
            "version":1, "python":{"py": project.join("python.exe").to_string_lossy()},
            "docker":{"dock":{"composeFile":"compose.yaml","projectName":"my-project",
                "services":["api"],"controlServices":["api"]}}
        })).unwrap()).unwrap();
        let repositories = native_repositories(&config).unwrap();
        assert_eq!(repositories["repositories"][0]["available"], true);
        assert_eq!(repositories["repositories"][0]["id"], "test-one");
        assert!(!repositories.to_string().contains(project.to_string_lossy().as_ref()));
        let profiles = native_profiles(&config).unwrap();
        assert_eq!(profiles["profiles"].as_array().unwrap().len(), 2);
        assert_eq!(profiles["profiles"][0]["alias"], "dock");
        let detail = native_profile_detail_from(&config, "dock").unwrap();
        assert_eq!(detail["docker"]["projectName"], "my-project");
        assert_eq!(detail["python"], Value::Null);
        assert!(native_profile_detail_from(&config, "../bad").is_err());
        assert!(native_profile_detail_from(&config, "missing").is_err());
        println!("native catalog + profile fixture: {}ms (no Node)",
            timer.elapsed().as_millis());
        fs::write(config.join("repositories.json"), b"{\"version\":2}").unwrap();
        assert!(native_repositories(&config).is_err());
        fs::write(config.join("repositories.json"), vec![b'X'; 512 * 1024 + 1]).unwrap();
        assert!(native_repositories(&config).is_err());
        fs::remove_dir_all(&base).unwrap();
    }
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
