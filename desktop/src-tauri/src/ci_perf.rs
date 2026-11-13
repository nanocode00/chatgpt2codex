//! Windows CI-only WebView timing report sink. Never accepts file paths from
//! the WebView; output path is provided by the trusted CI runner environment.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

// The GUI cannot supply or forge startup verification results. Native code
// records only success/failure and duration, never file paths or hashes.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CiPrewarmResult {
    succeeded: bool,
    elapsed_ms: f64,
}

static PREWARM_RESULT: OnceLock<Mutex<Option<CiPrewarmResult>>> = OnceLock::new();

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CiPerfSample {
    command: String,
    run: u8,
    gui_ms: f64,
    bridge_ms: f64,
    cli_ms: f64,
    bundle_verify_ms: f64,
    child_process_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CiPerfReport {
    schema_version: u8,
    note: &'static str,
    prewarm: Option<CiPrewarmResult>,
    samples: Vec<CiPerfSample>,
    error: Option<String>,
}

fn enabled() -> bool {
    cfg!(all(debug_assertions, target_os = "windows"))
        && std::env::var("C2C_CI_PERF_RUN").as_deref() == Ok("1")
        && std::env::var_os("C2C_CI_PERF_OUTPUT").is_some()
}

pub(crate) fn record_bundle_prewarm(elapsed_ms: f64, succeeded: bool) {
    if !enabled() { return; }
    let state = PREWARM_RESULT.get_or_init(|| Mutex::new(None));
    if let Ok(mut result) = state.lock() {
        *result = Some(CiPrewarmResult { succeeded, elapsed_ms });
    }
}

#[tauri::command]
pub fn ci_perf_prewarm() -> Option<CiPrewarmResult> {
    if !enabled() { return None; }
    PREWARM_RESULT.get()?.lock().ok()?.clone()
}

#[tauri::command]
pub fn ci_perf_enabled() -> bool {
    enabled()
}

#[tauri::command]
pub fn ci_perf_submit(samples: Vec<CiPerfSample>, error: Option<String>) -> Result<(), String> {
    if !enabled() {
        return Err("CI 전용 성능 기록은 비활성화 상태입니다.".into());
    }
    let prewarm = ci_perf_prewarm();
    let commands = ["c2c status", "c2c repository list", "c2c profile list"];
    if error.is_none() {
        if !prewarm.as_ref().is_some_and(|p|
            p.succeeded && p.elapsed_ms.is_finite() && p.elapsed_ms >= 0.0 && p.elapsed_ms <= 120_000.0
        ) {
            return Err("시작 시 번들 검증이 완료되지 않았거나 실패했습니다.".into());
        }
        if samples.len() != 15 {
            return Err("성능 기록은 각 명령 5회씩 총 15건이어야 합니다.".into());
        }
        for command in commands {
            let mut runs = samples.iter().filter(|s| s.command == command).map(|s| s.run).collect::<Vec<_>>();
            runs.sort_unstable();
            if runs != [1, 2, 3, 4, 5] {
                return Err("성능 측정 횟수 또는 명령이 올바르지 않습니다.".into());
            }
        }
        if samples.iter().any(|s| {
            !s.gui_ms.is_finite() || !s.bridge_ms.is_finite() || !s.cli_ms.is_finite()
                || !s.bundle_verify_ms.is_finite() || !s.child_process_ms.is_finite()
                || s.gui_ms < 0.0 || s.bridge_ms < 0.0 || s.cli_ms < 0.0
                || s.bundle_verify_ms < 0.0 || s.child_process_ms < 0.0
                || s.gui_ms > 120_000.0 || s.bridge_ms > 120_000.0 || s.cli_ms > 120_000.0
                || s.bundle_verify_ms > 120_000.0 || s.child_process_ms > 120_000.0
        }) {
            return Err("성능 시간 값이 올바르지 않습니다.".into());
        }
        // An unexpected full-bundle rehash is thousands of milliseconds on
        // CI; this loose guard catches the structural regression without
        // treating noisy runner latency as a production performance SLO.
        if samples.iter().any(|s| s.bundle_verify_ms > 1_000.0) {
            return Err("사전 검증 이후 CLI 요청에서 번들 재검증 지연이 발생했습니다.".into());
        }
    } else if error.as_ref().is_some_and(|e| e.len() > 300) {
        return Err("성능 검사 오류 내용이 너무 깁니다.".into());
    }
    let destination = std::env::var_os("C2C_CI_PERF_OUTPUT")
        .map(PathBuf::from).ok_or("CI 결과 저장 위치가 없습니다.")?;
    if !destination.is_absolute() {
        return Err("CI 결과는 절대 경로에만 저장할 수 있습니다.".into());
    }
    let report = CiPerfReport {
        schema_version: 2,
        note: "prewarm=startup bundle SHA before GUI benchmark; GUI=WebView invoke round-trip; bridge=Rust total; bundleVerify=locked cache reuse; childProcess=Node spawn through exit; CLI=handler excluding Node startup",
        prewarm,
        samples,
        error,
    };
    let bytes = serde_json::to_vec_pretty(&report)
        .map_err(|_| "CI 결과를 직렬화하지 못했습니다.")?;
    fs::write(destination, bytes).map_err(|_| "CI 결과 파일을 저장하지 못했습니다.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ci_performance_sink_disabled_without_opt_in() {
        if std::env::var("C2C_CI_PERF_RUN").as_deref() != Ok("1") {
            assert!(!ci_perf_enabled());
            assert!(ci_perf_submit(vec![], None).is_err());
        }
    }
}
