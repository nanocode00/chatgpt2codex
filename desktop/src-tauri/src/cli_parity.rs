//! F5-E: Explicit, bounded Tauri -> canonical CLI 1:1 operations.
//! No arbitrary command strings, PATH executables, shell, credential output,
//! user-selectable HOME/instance or access to the legacy WinForms/default.
//! Advanced destructive CLI commands deliberately remain CLI-only.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Component, Path};

use crate::managed_cli;

const INSTANCE: &str = "tauri-preview-v1";
const MAX_FIELD: usize = 512;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliParityRequest {
    operation: String,
    alias: Option<String>,
    target: Option<String>,
    value: Option<String>,
    key: Option<String>,
    compose_file: Option<String>,
    project_name: Option<String>,
    services: Option<String>,
    control_services: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliParityResponse {
    operation: String,
    command: String,
    json: Option<Value>,
    text: Option<String>,
    note: String,
}

struct CommandPlan {
    args: Vec<String>,
    mutating: bool,
    require_record: bool,
    text: bool,
    allow_nonzero: bool,
}

fn field<'a>(value: &'a Option<String>, name: &str) -> Result<&'a str, String> {
    let v = value.as_deref().ok_or_else(|| format!("{name}을(를) 입력하세요."))?;
    if v.is_empty() || v.len() > MAX_FIELD || v.chars().any(char::is_control) {
        return Err(format!("{name}의 길이 또는 문자 형식이 올바르지 않습니다."));
    }
    Ok(v)
}

fn alias(value: &Option<String>) -> Result<&str, String> {
    let v = field(value, "프로필 별칭")?;
    if v.len() > 64 || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        || v.starts_with('-') || v.contains("..") {
        return Err("프로필 별칭은 영문·숫자·._-만 허용합니다 (1~64자).".into());
    }
    Ok(v)
}

fn simple_identifier<'a>(value: &'a Option<String>, name: &str) -> Result<&'a str, String> {
    let v = field(value, name)?;
    if v.len() > 80 || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        || v.starts_with('-') || v.contains("..") {
        return Err(format!("{name}은 영문·숫자·._-만 허용합니다."));
    }
    Ok(v)
}

fn compose_file(value: &Option<String>) -> Result<&str, String> {
    let v = field(value, "Compose 파일")?;
    let p = Path::new(v);
    if p.is_absolute() || v.contains(':') || !p.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
        || !(v.ends_with(".yaml") || v.ends_with(".yml")) {
        return Err("Compose 파일은 상위 경로(..) 없이 .yml/.yaml로 끝나는 상대 경로여야 합니다.".into());
    }
    Ok(v)
}

fn csv_identifiers(value: &Option<String>, name: &str, optional: bool) -> Result<String, String> {
    if optional && value.as_deref().unwrap_or("").trim().is_empty() {
        return Ok(String::new());
    }
    let v = field(value, name)?;
    let parts = v.split(',').map(str::trim).collect::<Vec<_>>();
    if parts.is_empty() || parts.len() > 16 || parts.iter().any(|s|
        s.is_empty() || s.len() > 80 || !s.bytes().all(|b|
            b.is_ascii_alphanumeric() || b'_' == b || b'-' == b
        )
    ) {
        return Err(format!("{name}은 쉼표로 구분한 서비스 이름 1~16개여야 합니다."));
    }
    Ok(parts.join(","))
}

fn target<'a>(value: &'a Option<String>) -> Result<&'a str, String> {
    let v = field(value, "조회 대상 ID")?;
    if v.len() > 128 || !v.bytes().all(|b|
        b.is_ascii_alphanumeric() || b"._:-".contains(&b)
    ) || v.starts_with('-') || v.contains("..") {
        return Err("조회 대상 ID에는 영문·숫자·._:-만 허용합니다 (1~128자).".into());
    }
    Ok(v)
}

fn plan(r: &CliParityRequest) -> Result<CommandPlan, String> {
    let mut args: Vec<String> = vec![];
    let mut mutating = false;
    let mut require_record = false;
    let mut text = false;
    let mut allow_nonzero = false;
    match r.operation.as_str() {
        "profile-list" => args.extend(["profile", "list"].map(str::to_string)),
        "profile-show" | "profile-test" => {
            args.push("profile".into());
            args.push(if r.operation == "profile-show" { "show" } else { "test" }.into());
            args.push(alias(&r.alias)?.into());
        }
        "profile-add-python" => {
            let executable = field(&r.value, "Python 실행 파일 경로")?;
            let path = Path::new(executable);
            if !path.is_absolute() || !path.is_file()
                || !path.file_name().is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case("python.exe")) {
                return Err("실제로 존재하는 절대 경로의 python.exe 파일만 등록할 수 있습니다.".into());
            }
            args.extend(["profile".into(), "add".into(), alias(&r.alias)?.into(),
                "--python".into(), executable.into()]);
            mutating = true;
        }
        "profile-add-docker" => {
            let services = csv_identifiers(&r.services, "서비스", false)?;
            let control = csv_identifiers(&r.control_services, "제어 서비스", true)?;
            args.extend(["profile".into(), "add".into(), alias(&r.alias)?.into(),
                "--compose-file".into(), compose_file(&r.compose_file)?.into(),
                "--project-name".into(), simple_identifier(&r.project_name, "프로젝트 이름")?.into(),
                "--services".into(), services]);
            if !control.is_empty() { args.extend(["--control-services".into(), control]); }
            mutating = true;
        }
        "profile-remove-python" | "profile-remove-docker" | "profile-remove-all" => {
            args.extend(["profile".into(), "remove".into(), alias(&r.alias)?.into()]);
            match r.operation.as_str() {
                "profile-remove-python" => args.push("--python".into()),
                "profile-remove-docker" => args.push("--docker".into()),
                _ => (),
            }
            mutating = true;
        }
        "config-show" | "config-export" => {
            args.push("config".into());
            args.push(if r.operation == "config-show" { "show" } else { "export" }.into());
            if r.operation == "config-show" {
                args.extend(["--instance".into(), INSTANCE.into()]);
            }
        }
        "config-set" | "config-unset" => {
            // The preview's host/port/tunnel/workspace are pinned by its
            // audited launcher. Do not offer a generic config editor that can
            // move this server or activate a named/tunnel-token mode.
            let key = field(&r.key, "설정 키")?;
            if !matches!(key, "host" | "port" | "tunnel") {
                return Err("고정 프리뷰에서 변경할 수 있는 키는 host, port, tunnel뿐입니다. 나머지는 전용 CLI에서 관리하세요.".into());
            }
            args.extend(["config".into(), if r.operation == "config-set" { "set" } else { "unset" }.into(), key.into()]);
            if r.operation == "config-set" {
                let v = field(&r.value, "설정 값")?;
                let valid = matches!((key, v),
                    ("host", "127.0.0.1") | ("port", "18797") |
                    ("tunnel", "none") | ("tunnel", "cloudflare"));
                if !valid {
                    return Err("고정 Tauri 인스턴스의 호스트/포트는 변경할 수 없고, 터널은 none/cloudflare만 가능합니다.".into());
                }
                args.push(v.into());
            }
            args.extend(["--instance".into(), INSTANCE.into()]);
            mutating = true;
        }
        "reload" => {
            args.extend(["reload".into(), "--instance".into(), INSTANCE.into()]);
            require_record = true;
            mutating = true;
        }
        "status" | "health" => {
            args.extend([r.operation.clone(), "--instance".into(), INSTANCE.into()]);
            allow_nonzero = r.operation == "health"; // CLI returns JSON + exit 1 when offline
        }
        "repository-show" => {
            args.extend(["repository".into(), "show".into(), target(&r.target)?.into()]);
        }
        "secret-list" => {
            // Names only. No secret fetch/read command exists in the CLI.
            args.extend(["secret".into(), "list".into()]);
        }
        "lock-list" => args.extend(["lock".into(), "list".into()]),
        "job-list" => args.extend(["job".into(), "list".into()]),
        "job-status" | "job-logs" => {
            args.extend(["job".into(),
                if r.operation == "job-status" { "status" } else { "logs" }.into(),
                target(&r.target)?.into()]);
            if r.operation == "job-logs" {
                args.extend(["--limit".into(), "10".into()]);
            }
        }
        "control-list" => args.extend(["control".into(), "list".into()]),
        "control-auto-status" => args.extend(["control".into(), "auto".into(), "status".into()]),
        "doctor" => {
            args.extend(["doctor".into(), "--workspace".into(), ".".into()]);
            text = true;
        }
        "logs-server" | "logs-tunnel" => {
            args.extend(["logs".into(), "--instance".into(), INSTANCE.into(), "--component".into(),
                if r.operation == "logs-server" { "server" } else { "tunnel" }.into(),
                "--lines".into(), "80".into()]);
            text = true;
        }
        _ => return Err("허용되지 않은 CLI 명령입니다. secret/job/lock/control 변경 명령은 여기서 실행하지 않습니다.".into()),
    }
    Ok(CommandPlan { args, mutating, require_record, text, allow_nonzero })
}

fn redacted_text(raw: &str) -> String {
    const SENSITIVE: [&str; 13] = [
        "owner token", "owner_token", "authorization", "bearer ",
        "password", "secret", "api_key", "apikey", "cookie:",
        "tunnel_token", "access_token", "client_secret", "private_key",
    ];
    let tail = raw.lines().rev().take(80).collect::<Vec<_>>();
    let clean = tail.into_iter().rev().map(|line| {
        let lowered = line.to_ascii_lowercase();
        if SENSITIVE.iter().any(|needle| lowered.contains(needle)) {
            "[민감 정보가 포함될 수 있는 행 숨김]".to_string()
        } else {
            line.chars().take(512).collect::<String>()
        }
    }).collect::<Vec<_>>().join("\n");
    clean.chars().rev().take(16_384).collect::<String>().chars().rev().collect()
}

// Keep structured CLI metadata bounded when showing it in the local WebView.
// Some job/control records may carry user-provided text in nested fields.
fn redact_json(value: Value, depth: usize) -> Value {
    if depth > 12 { return Value::String("[중첩 깊이 제한]".into()); }
    match value {
        Value::Object(map) => Value::Object(map.into_iter().map(|(key, child)| {
            let lowered = key.to_ascii_lowercase();
            let redact = ["authorization", "password", "bearer", "api_key",
                "client_secret", "private_key", "accesstoken", "access_token",
                "ownertoken", "owner_token", "tunnel_token"]
                .iter().any(|part| lowered.contains(part));
            (key, if redact { Value::String("[민감 값 숨김]".into()) }
                else { redact_json(child, depth + 1) })
        }).collect()),
        Value::Array(values) => Value::Array(values.into_iter().take(128)
            .map(|v| redact_json(v, depth + 1)).collect()),
        Value::String(text) => {
            let lowered = text.to_ascii_lowercase();
            if ["bearer ", "owner_token=", "authorization:", "client_secret="]
                .iter().any(|needle| lowered.contains(needle)) {
                Value::String("[민감 값 숨김]".into())
            } else {
                Value::String(text.chars().take(2048).collect())
            }
        }
        other => other,
    }
}

fn execute(request: CliParityRequest) -> Result<CliParityResponse, String> {
    let p = plan(&request)?;
    let raw = managed_cli::parity_cli(&p.args, p.mutating, p.require_record, p.text, p.allow_nonzero)?;
    let (json, text) = if p.text {
        (None, Some(redacted_text(&raw)))
    } else {
        let value: Value = serde_json::from_str(&raw)
            .map_err(|_| "전용 CLI가 유효한 JSON을 반환하지 않았습니다.".to_string())?;
        (Some(redact_json(value, 0)), None)
    };
    let args_preview = p.args.iter().map(|a| {
        if a.contains('\\') || a.contains('/') || a.len() > 80 { "[경로/긴 값]".to_string() }
        else { a.clone() }
    }).collect::<Vec<_>>().join(" ");
    Ok(CliParityResponse {
        operation: request.operation, command: format!("c2c {args_preview}"), json, text,
        note: "SHA 검증된 번들 CLI · tauri-preview-v1 · 격리 HOME (기존 WinForms와 분리)".into(),
    })
}

#[tauri::command]
pub async fn run_owned_cli_parity(request: CliParityRequest) -> Result<CliParityResponse, String> {
    tauri::async_runtime::spawn_blocking(move || execute(request))
        .await.map_err(|_| "Tauri CLI 작업이 실패했습니다.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(operation: &str) -> CliParityRequest {
        CliParityRequest {
            operation: operation.into(), alias: None, target: None, value: None, key: None,
            compose_file: None, project_name: None, services: None, control_services: None,
        }
    }

    #[test]
    fn command_catalog_has_fixed_instance_and_no_arbitrary_commands() {
        for command in ["profile-list", "config-show", "config-export", "doctor", "status",
                        "health", "logs-server", "logs-tunnel"] {
            let p = plan(&request(command)).unwrap();
            assert!(!p.mutating);
        }
        assert!(plan(&request("secret-set")).is_err());
        assert!(plan(&request("serve")).is_err());
        assert!(plan(&request("profile-import-env")).is_err());
        for operation in ["secret-list", "lock-list", "job-list",
                          "control-list", "control-auto-status"] {
            let p = plan(&request(operation)).unwrap();
            assert!(!p.mutating && !p.require_record);
        }
        for operation in ["secret-set", "job-cancel", "lock-release",
                          "control-approve", "control-kill"] {
            assert!(plan(&request(operation)).is_err());
        }
        let mut job = request("job-status");
        assert!(plan(&job).is_err());
        job.target = Some("job-abc_123".into());
        assert_eq!(plan(&job).unwrap().args[2], "job-abc_123");
        job.target = Some("../path".into());
        assert!(plan(&job).is_err());
        assert!(plan(&request("config-import")).is_err());
        let p = plan(&request("reload")).unwrap();
        assert!(p.mutating && p.require_record && p.args.contains(&INSTANCE.to_string()));
        assert!(plan(&request("profile-show")).is_err());
    }

    #[test]
    fn preview_config_cannot_override_security_boundary() {
        let mut r = request("config-set");
        for key in ["workspace", "repository", "public-hostname", "tunnel-name"] {
            r.key = Some(key.into());
            r.value = Some("x".into());
            assert!(plan(&r).is_err());
        }
        r.key = Some("port".into());
        r.value = Some("7979".into());
        assert!(plan(&r).is_err());
        r.value = Some("18797".into());
        assert!(plan(&r).is_ok());
        r.key = Some("tunnel".into());
        r.value = Some("evil".into());
        assert!(plan(&r).is_err());
    }

    #[test]
    fn docker_profile_arguments_are_validated() {
        let mut r = request("profile-add-docker");
        r.alias = Some("my-app".into());
        r.compose_file = Some("docker-compose.yaml".into());
        r.project_name = Some("dev".into());
        r.services = Some("api,db".into());
        assert!(plan(&r).is_ok());
        r.compose_file = Some("../compose.yaml".into());
        assert!(plan(&r).is_err());
        r.compose_file = Some("docker-compose.yaml".into());
        r.services = Some("api;bad".into());
        assert!(plan(&r).is_err());
        r.services = Some("api".into());
        r.alias = Some("--help".into());
        assert!(plan(&r).is_err());
    }

    #[test]
    fn read_only_json_hides_secret_bearing_metadata() {
        let parsed = serde_json::json!({
            "name": "task",
            "access_token": "private",
            "metadata": { "ownerToken": "really-private" },
            "records": [{"message":"Bearer secret-value"}]
        });
        let output = redact_json(parsed, 0).to_string();
        assert!(!output.contains("really-private"));
        assert!(!output.contains("secret-value"));
        assert!(!output.contains("private"));
        assert!(output.contains("task"));
    }

    #[test]
    fn log_text_redacts_sensitive_lines() {
        let sample = "ready\nAuthorization: Bearer token\nowner_token=token\nlistening\n";
        let rendered = redacted_text(sample);
        assert!(rendered.contains("ready"));
        assert!(rendered.contains("listening"));
        assert!(!rendered.contains("Bearer token"));
        assert!(!rendered.contains("owner_token=token"));
    }
}
