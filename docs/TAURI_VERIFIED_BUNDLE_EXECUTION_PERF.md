# C2C Tauri 실행 경로 성능 개선 — 검증된 번들 재사용

> 2026-11-13 · 기준: [CLI/UI 실행 책임 정책](./TAURI_CLI_UI_ARCHITECTURE_POLICY.md), [Windows GUI/CLI CI 측정](./TAURI_GUI_CLI_CI_BENCHMARK.md)

## 이전 실측

2026-11-13 Windows Actions CI의 실제 WebView2에서 각 5회 실행한 p50:

| 명령 | GUI 전체 | Rust 브리지 | CLI 명령 핸들러 |
|---|---:|---:|---:|
| `c2c status` | 3,379.0ms | 3,374.3ms | 2ms |
| `c2c repository list` | 3,187.3ms | 3,183.9ms | 2ms |
| `c2c profile list` | 3,313.9ms | 3,309.7ms | 2ms |

이 차이는 CLI가 실제로 실행되기 전에 Tauri의 `payload() → verify_manifest()`가 **매 요청마다 번들 Node/CLI/cloudflared의 전체 SHA-256**을 계산한 구조와 일치한다. 기존 구간 값만으로 SHA 비용을 분리한 것은 아니므로 이번 변경에서 단계별 계측을 추가한다.

## 개선 구조

1. **첫 호출:** 현재 실행 앱의 고정 리소스 경로에서 매니페스트, Node, CLI, 선택적 cloudflared를 Windows `FILE_SHARE_READ` 전용으로 연다. 이 핸들은 다른 프로세스가 파일 내용을 변경·잘라내기·교체하지 못하도록 쓰기/삭제 공유를 허용하지 않는다.
2. 열린 파일이 보호된 상태에서 기존 `verify_manifest()` 전체 SHA-256을 실행한다. 매니페스트 버전·종류·인스턴스·경로·노드/CLI/터널 해시 검사와 실패 시 거부 정책은 모두 유지한다.
3. **이후 호출:** Tauri 프로세스가 살아 있는 동안 검증 결과와 보호용 파일 핸들을 유지한다. 경로 재해석이 기존 검증 경로와 달라지면 거부한다. 파일 크기/수정 시각만으로 안전성을 추정하지 않는다.
4. **앱 완전 종료 시:** 파일 핸들이 닫힌다. 다음 실행에서는 새로 SHA-256 검증한다. 실행 중 수동 업데이트가 차단될 수 있으므로 앱을 종료하고 새 파일로 교체한다.
5. **CLI 실행 방식:** 변경 없음. UI와 Rust 브리지는 여전히 기존 명령 인자를 가진 **검증된 Node+CLI**를 실행한다. CLI 명령 해석·서버 상태·PID/포트 소유권 확인 등은 CLI 책임. 무결성 검증 캐시는 배포 파일 실행 출처를 확인하는 Tauri 브리지 보안에 한정한다.

이 방식은 실행 파일을 단순히 신뢰하거나 실행 경로를 바꿔 임의 파일을 호출하는 것이 아니다. 변경 방지 핸들을 열 수 없거나 SHA 검증이 실패하면 실행하지 않는다.

## CI 계측 추가

기존 `guiMs`, `bridgeMs`, `cliMs` 외에 읽기 전용 세 명령(각 5회)의 동일한 호출에서 다음을 별도로 수집한다.

- `bundleVerifyMs`: 경로 정규화 및 최초 전체 SHA 또는 기존 보호 핸들/검증값 재사용
- `childProcessMs`: Node 프로세스 생성 준비·기동부터 종료·출력 수집까지
- `cliMs`: Node CLI의 명령 핸들러만 포함, Node 기동/모듈 로딩 제외

GitHub Actions 요약에 각 구간의 p50/p95를 기록하고, 개별 기록 15건을 `c2c-gui-cli-latency-results` JSON artifact로 저장한다. 변경 전 실측과 변경 후 GUI/브리지 p50을 비교하고, **첫 실행은 전체 SHA로 느릴 수 있으므로 반복 실행과 분리**한다.

## 보안 및 회귀 검수

- 검증된 번들 캐시가 연 파일 세트의 쓰기·삭제가 실제 Windows에서 거부되는지 단위 테스트
- 캐시가 제거된 뒤 파일 변조 시 SHA 검증 실패 확인
- 다른 번들 위치나 변경된 경로를 기존 검증값으로 승인하지 않음
- 기존 Quick Tunnel manifest 변조 거부, 다른 PID/인스턴스 보호, 서버 start/stop/restart, 프로젝트·프로필 목록 결과 유지
- 일반 CI + Windows Rust unit tests + 실제 WebView2 15회 성능 CI 통과
- 사용자 환경은 Windows Actions runner와 다를 수 있으므로 별도 PC 체감/실측 검수 필요

**미확인 상태를 성공으로 보고하지 않는다.** Windows CI 실측 결과 전까지 개선 속도는 추정이며, Draft PR로 유지한다.
