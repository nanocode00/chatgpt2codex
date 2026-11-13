# CI: GUI / Tauri 브리지 / CLI 처리 시간 기록

## 목적과 범위

Windows Tauri Desktop Smoke에서 실제 `chatgpt2codex-desktop.exe` 및 WebView2를 실행하고, 사용자 콘솔과 동일한 Tauri `run_owned_cli_console` IPC 경로를 통해 읽기 전용 명령을 계측한다.

- `c2c status`
- `c2c repository list`
- `c2c profile list`

각 명령을 **5회** 실행한다. 측정 결과는 GitHub Actions의 **Step Summary**에 p50/p95 표로, **Artifacts → c2c-gui-cli-latency-results**에 개별 실행 JSON으로 저장한다.

## 계측 정의

| 값 | 시작 | 종료 | 포함 / 제외 |
|---|---|---|---|
| `guiMs` | Windows WebView의 `runOwnedCliConsole` 호출 직전 `performance.now()` | Promise에서 실제 응답을 받은 직후 | Tauri IPC 왕복 + 브리지 + CLI 실행. UI 렌더링·입력 문법 검사 시간은 제외 |
| `bridgeMs` | Rust `cli_parity::execute` 진입 | CLI stdout 수신, JSON/텍스트 검사, 민감값 마스킹 및 응답 객체 생성 직후 | CLI 실행 프로세스 시작·종료, 번들 해시 검증, 응답 파싱 등 포함 |
| `cliMs` | Node CLI의 해당 `cmdStatus` / `cmdRepository` / `cmdProfile` 핸들러 시작 | 핸들러 완료 | **CLI 명령 내부 처리 시간**. Node 프로세스 기동·모듈 초기 로딩은 포함하지 않음 |

따라서 `guiMs - bridgeMs`는 GUI/IPC·스케줄링 오버헤드를 근사하고, `bridgeMs - cliMs`는 Node 기동·모듈 로딩·해시 확인·브리지 처리 등이 **모두 섞인 값**이다. 두 차이를 엄밀하게 서로 다른 독립 처리 시간으로 간주하지 않는다.

## 수집 구조

1. CI의 Vite 번들에서만 `VITE_C2C_CI_PERF=1` 활성화.
2. Windows Runner에서 생성한 Tauri Preview 앱을 `C2C_CI_PERF_RUN=1` 환경으로 실행.
3. WebView가 네이티브 테스트 활성화 상태인지 확인 후, 수정 명령 없이 3 × 5번 CLI 호출.
4. 기존 CLI의 선택적 `C2C_CLI_PERF=1` stderr 숫자를 Rust가 정해진 형식으로 읽고, raw stderr/CLI 출력은 기록하지 않음.
5. GUI에서 `guiMs`, Rust에서 `bridgeMs`, CLI의 핸들러에서 `cliMs` 측정.
6. CI 전용 Rust 저장소가 고정 명령명·횟수·숫자 형식을 확인하고, Runner가 지정한 JSON 파일에 기록.
7. PowerShell 스크립트가 요약 표를 Actions Summary에 출력하고 JSON을 업로드. 결과 파일 미생성·부족·오류는 CI 실패로 처리.

**보안:** CI opt-in 없는 일반 앱에서는 벤치마크가 비활성이다. 인자·출력·토큰·프로젝트 경로는 성능 기록에 포함하지 않으며, 명령은 고정된 읽기 전용 3개다. 브리지 원래의 소유권 및 해시 검증을 우회하지 않는다.

## 해석 주의

GitHub-hosted Windows Runner의 처리 시간이다. 사용자의 PC에서 얻은 절대 지연 또는 실제 체감 속도는 아니다. 사용자 PC 시간 측정은 별도 Windows Preview 실측이 필요하다.

정확한 구간 정의와 명령 목록을 변경했다면 이전 실행 결과와 수치를 직접 비교하지 않는다. GUI 전체 시간에 클릭·React 화면 반영까지 포함하려면 별도의 UI 단계 계측이 필요하다.
