# C2C Tauri — 실행·종료 지연 계측과 트레이 진행 표시

2026-11-13 · 기준: [CLI/UI 책임 정책](./TAURI_CLI_UI_ARCHITECTURE_POLICY.md)

## 변경 목적

조회 명령은 이전 최적화로 Windows CI 반복 호출 중앙값 약 128ms까지 줄었지만, 서버 시작·중지·재시작은 프로세스 소유권 확인, Health 요청, 서버 종료 대기 등이 있어 훨씬 오래 걸릴 수 있다. 특히 **트레이에서 '종료'를 선택했을 때 앱이 숨어 있으면 결과가 나올 때까지 아무 반응도 보이지 않는 문제**가 있다.

## 트레이 종료 피드백

- 트레이 우클릭 메뉴는 **창 열기 / 종료**를 그대로 유지.
- **종료**를 누르면 창을 복원하고 'MCP 서버와 터널을 종료하는 중...' 진행 표시를 바로 보여준다.
- 진행 중 트레이 메뉴 항목을 '종료 중...'으로 바꾸고 비활성화하며 중복 종료 요청을 차단한다.
- 종료 명령은 기존과 동일하게 CLI의 안전한 `stop --instance tauri-preview-v1`만 사용한다. CLI가 성공 또는 이미 중지됨을 확인한 경우에만 앱이 닫힌다.
- 실패하면 앱을 닫지 않고, 트레이 종료 메뉴를 복원하고 진행 표시를 없앤 뒤 오류를 보여준다.
- 설정 화면의 **종료**도 같은 진행 표시를 사용한다. X/최소화/트레이로 숨기기는 기존 정책 그대로다.

## Windows CI 수명주기 계측

기존 **Windows 격리 CLI E2E**에만 선택적 계측을 활성화한다. 시스템 기본 인스턴스·사용자 설정·실행 프로세스를 변경하지 않는다.

- 번들 Node/CLI, 고정 CI 격리 인스턴스, 임의 루프백 포트만 사용.
- `start`, `reload`, `repository` 변경에 따른 자동 갱신, `stop`, `restart`에 대해 **CLI 호출 전체 시간(프로세스 기동·종료 포함)**을 기록한다.
- 같은 실행의 `C2C_CLI_PERF=1` stderr에 **명령별 내부 단계 시간**을 출력한다. 이 기록은 테스트 과정에서 분리하고 숫자·고정 단계명만 JSON에 포함한다.
- `stop`은 Health/터널 소유권 사전 확인, 신호 직전 서버 PID 확인, 서버 종료 대기, 터널 종료 대기, 기록 정리를 개별 계측한다.
- 소유권 위조 PID를 대상으로 시도한 중지는 **rejected**로 기록하고 성공 시간에 합산하지 않는다.
- 결과는 GitHub Actions **Step Summary**와 artifact `c2c-cli-lifecycle-latency-results`에 기록. 전체 런타임 stdout/stderr, 토큰·프로젝트 경로·PID는 기록하지 않는다.
- 일반 Tauri 앱과 일반 CLI 사용에는 테스트 출력이 활성화되지 않는다. 측정은 Windows Actions runner의 격리 환경에서만 실행한다.

## 결과 해석 / 남은 확인

### 1차 실측 및 검증 경로 개선

- Windows CI의 번들 CLI 로컬-only 격리 테스트: `start` 420.9~436.8ms, `stop` 639.6~663.0ms, `restart` 983.8ms, `reload` 342.6ms. 이 값은 CLI 직접 실행의 전체 벽시계 시간이다.
- 성공한 첫 `stop`에서 CLI 내부 575ms 중 서버 소유권 **최초 확인 270ms + 최종 확인 278ms**, Health 23ms, 서버 종료 대기 0ms였다. 실제 SIGTERM 전 두 번 수행하던 Windows CIM 검사가 병목이었다.
- 후속 수정은 **서버 CIM 검증을 신호 직전 단 한 번** 수행한다. Health는 읽기 전용이고, 터널 PID 검증은 항상 서버 정지 전에 완료한다. 최종 PID 검증이 실패하면 SIGTERM을 전혀 보내지 않는다. 터널 실제 종료 직전의 두 번째 검증도 유지한다.
- 이는 확인 항목을 단순 무시하는 것이 아니라 **안전한 신호 전제조건을 마지막 순간 한 번 판정**하도록 순서를 조정한 것이다. 타임아웃·강제 종료 조건은 그대로다. 초기 실측 대비 개선 폭과 위조 PID 차단 유지는 후속 Windows CI에서 다시 확인한다.

- 일회성 `start`/`restart`와 여러 단계의 `stop`은 동일한 명령 5회 통계가 아니다. CI에 포함된 실제 성공 호출 횟수·시간을 먼저 보고, 반복 성능 검증이 필요하면 별도 실행을 늘린다.
- **Quick Tunnel** 종료는 외부 네트워크/Cloudflare 환경에 영향을 받는다. 이번 재현은 로컬-only 프로세스 위주이므로 사용자 PC의 Quick Tunnel 종료 시간이라고 단정하지 않는다.
- 트레이 진짜 우클릭·창 복원·진행 표시 UX는 Windows Preview 수동 검수가 필요하며 CI의 CLI 수명주기 시간만으로 UI 전체 종료 시간을 대체하지 않는다.
- 종료 지연의 근거가 확보되기 전에는 CLI의 PID 보호 규칙, Health 검사, 종료 타임아웃, 강제 종료 조건을 임의로 완화하지 않는다.

**병합 게이트:** Windows CI CLI 수명주기 통과, Rust·TypeScript 테스트 통과, 트레이 종료 성공·실패 수동 점검 이후에만 Draft 해제 검토.

## Quick Tunnel 시작 지연 최적화 (후속 Draft)

- 기존 CLI `start --tunnel cloudflare`는 Quick Tunnel URL 확보 및 로컬 MCP Health/소유 기록 검증을 마친 **뒤**, 별도 외부 HTTPS `/healthz`를 여러 차례 재시도한다. 네트워크 응답이 느리면 CLI가 이미 관리 가능한 로컬 MCP를 시작해 놓고도 시작 응답이 지연될 수 있다.
- Tauri 전용 `tauri-preview-v1` 공개 시작에서만 `--defer-public-health`를 CLI에 명시한다. URL 확보·로컬 MCP Health·소유권 기록 생성·검증은 **동일하게 필수**이고, 외부 HTTPS는 `publicHealthy: null`(아직 미검증)로 돌려준다. 성공 또는 실패로 가장하지 않는다.
- Tauri 화면의 **기존** `inspect_owned_public_tunnel_health()`가 고정된 Quick Tunnel 도메인의 HTTPS `/healthz`를 검사하며, 시작 직후와 30초 간격·창 포커스·네트워크 복구 시 재검사한다. SSH/WSL/default C2C에는 영향이 없다.
- 일반 CLI 및 다른 인스턴스의 외부 Health 검증은 **기존 동기 방식 유지**. 해당 옵션은 Tauri 지정 인스턴스+cloudflare에서만 허용한다. 실행 중 공개 전환 금지·PID/Cloudflare 바이너리 소유권 검사·정상 종료 규칙을 완화하지 않는다.
- CLI 선택적 `C2C_CLI_PERF=1` 계측은 `start tunnel ready`, `start local ready`, 기존 방식의 `start public health`, 전체 `start`를 숫자로만 구분한다. 터널 URL 발급 자체가 지연된다면 이 변경만으로 10초가 모두 없어지지는 않는다.
- Windows CI에서는 옵트인 정책/지연된 HTTPS 응답에 대한 단위 검사·실제 Tauri 빌드를 확인한다. **실제 외부 Cloudflare 지연, 최초 HTTPS 불안정, 사용자 PC 체감값은 별도로 검수**한다.
