# Tauri CLI 단일 실행 경로 — 통합 검수 및 성능 측정

> 2026-11-13 · 적용 기준: [CLI/UI 공통 정책](./TAURI_CLI_UI_ARCHITECTURE_POLICY.md)
> 범위: `feat/cli-owned-execution-refresh-integration`; 기존 기능 검수·보안 규칙 유지, 병합 전 Windows 실측 필요.

## 1. 구현 변경 요약

- **CLI 자체 최적화:** `status/profile/repository/catalog` 실행에서 MCP HTTP·서버 도구·OAuth·이미지 처리 모듈은 필요할 때만 지연 로드. `repository list`의 디렉터리 존재 검사는 병렬화.
- **CLI 단일 카탈로그 명령:** `c2c catalog list`가 `readManagedRepositories` / `readManagedProfiles`를 **같은 CLI 프로세스**에서 읽고 검증해 `{repositories,profiles}`로 반환한다. UI Projects/Profiles는 CLI 결과의 민감한 경로를 화면 밖에 유지하고 목록 표시에 필요한 필드만 받는다.
- **CLI 종료:** 서버/터널 초기 프로세스 소유권 검사를 병렬화. SIGTERM 직전 서버 PID 재검증, 터널 종료 직전 재검증 및 기존 실패 닫힘 규칙은 유지. `C2C_CLI_PERF=1`에서 CLI 내부 단계별 경과시간을 stderr로 출력 (JSON stdout 불변).
- **Tauri 브리지:** 읽기 명령에 별도 `ensure_workspace`, `record_if_any`, UI 소유권/포트 조회 및 잠금을 수행하지 않는다. CLI를 한 번 실행하고 구조화된 결과를 표시한다. 상태·Health·로그 Rust 직접 판정/파일 조회 우회 경로는 삭제. 앱 자체의 트레이/자동 시작 기능은 Tauri에 남김.
- **완전 종료:** CLI `stop` 결과 하나로 성공/미실행/실패를 구분. Rust에서 같은 포트/기록을 최대 5초 더 폴링하지 않음. CLI가 승인한 정상 종료가 확인된 후에만 앱/트레이를 닫는다.
- **화면 새로고침:** 상단바 단일 버튼. 현재 화면 데이터만 갱신하며, 중복 목록/상태 호출은 single-flight로 합침. 기존 작업 목록 45초 주기·포커스 갱신, 터널 30초 주기·포커스 갱신, 설정 상태 갱신을 유지. CLI 콘솔에서는 마지막 **읽기 전용** 명령만 재실행.
- **자동 상태 확인:** 사용하지 않던 별도의 Tauri Health IPC 요청을 제거하고 기존 10초 주기 설정을 공통 CLI `status` 요청에 연결. 화면 진입 조회와 single-flight로 합치고, 늦게 도착한 예전 상태 응답은 서버 변경 결과를 덮어쓰지 않게 generation으로 무효화. 자동 조회 실패는 기존 상태 오류에 반영하되 토스트를 10초마다 반복하지 않음.
- 화면 개별 일반 새로고침 버튼 제거. Doctor/잠금 조회/로그 조회/서버 시작·재시작은 별도 기능 버튼으로 유지.

## 2. 측정 지침 — 동일 CLI 환경에서 비교

터미널에서 `c2c`를 실행할 때는 Preview 번들의 **같은** `node.exe`/`dist/cli.js`, `tauri-preview-v1` 인스턴스, 동일한 HOME·USERPROFILE·XDG_CONFIG_HOME 및 작업 디렉터리를 사용해야 한다. 로컬에 별도 설치된 기본 CLI `default`와 비교하지 않는다.

Windows PowerShell에서 아래 실행은 예시다. 실제 설치·압축 해제 경로는 현재 Preview 위치에 맞춘다. stdout에는 작업 데이터가 있을 수 있으므로 측정 결과만 공유한다.

```powershell
# 본인이 압축 해제한 최신 Preview 앱 폴더
$root = 'C:\Path\To\C2C-Tauri-Preview'
$node = Join-Path $root 'c2c-runtime\bin\node.exe'
$cli = Join-Path $root 'c2c-runtime\dist\cli.js'
$home = Join-Path $env:LOCALAPPDATA 'ChatGPTToCodex-Tauri-Preview\isolated-home'
$env:HOME = $home
$env:USERPROFILE = $home
$env:XDG_CONFIG_HOME = Join-Path $home '.config'
$env:C2C_CLI_PERF = '1'

foreach ($args_ in @(
  @('status','--instance','tauri-preview-v1'),
  @('repository','list'),
  @('profile','list'),
  @('catalog','list')
)) {
  $command = $args_ -join ' '
  for ($i=1; $i -le 5; $i++) {
    $ms = (Measure-Command { & $node $cli @args_ *> $null }).TotalMilliseconds
    Write-Host "$command run $i : $([math]::Round($ms)) ms"
  }
}
```

위 스크립트는 **조회만** 한다. 종료는 실제 사용 중인 서버에 영향을 주므로, 검수용 Preview에서 사용자 확인 후 별도로 한 번만 측정한다. CLI `stop`은 연결 중인 ChatGPT 세션을 끊을 수 있다.

GUI에서는 같은 명령을 CLI 콘솔에서 5회 실행하고 표시된 ms를 비교한다. 첫 실행과 반복을 나눠 기록한다. 의미 있는 UI 추가 지연이 남으면 번들 해시/CLI 기동/IPC/화면 갱신 구간 중 어디에 걸렸는지 조사하고, 보안 검사를 생략하지 않은 상태에서 줄인다.

## 3. 수동 Windows 검수

1. 상단바 새로고침: 각 화면에서 한 번씩 누르고 해당 화면 데이터만 갱신되는지 확인. 연속 클릭은 중복 실행하지 않음.
2. 프로젝트와 실행 환경: 등록된 목록을 확인하고 `c2c catalog list`와 동일한 항목/상태인지 비교. 폴더 경로가 UI로 새어 나오지 않는지 확인.
3. 진단·작업: 화면 진입 시 기존 조회, 45초 작업 자동 갱신, 터널 주기/포커스 자동 갱신 유지. Doctor/잠금/로그는 개별 기능으로 정상 작동.
4. CLI 콘솔: `c2c status`, `c2c profile list`, `c2c repository list`, `c2c logs --component server` 결과가 CLI 직접 실행과 일치하는지 확인. 상단 새로고침으로 `stop`/`restart`/`config set`이 재실행되지 않음을 확인.
5. 종료: X·트레이 숨김은 서버 유지, 설정/트레이 종료는 CLI 정상 stop 후 앱 완전 종료. **CLI가 중지에 실패하면 Tauri는 종료되지 않아야 한다.**
6. 서버 중지 상태와 실행 상태, 로컬/Quick Tunnel 각각에서 정상 Health/시간/오류 비교.
7. CLI 안전성: 다른 인스턴스, PID 소유권 불일치, 포트 충돌, 불완전 기록이 있는 경우 강제 종료하지 않음.

## 4. 게이트

- UI TypeScript/Vite build.
- Root TypeScript/Vitest 테스트와 Windows Rust unit tests, **Tauri Desktop Smoke**.
- 실제 CLI 직접 실행과 GUI 실행의 수행시간 5회 비교, 오버헤드 구간 기록.
- Preview 수동 검수 승인 전에는 Draft PR을 병합하지 않는다. 성능 배수/절대시간은 실측 전 주장하지 않는다.

