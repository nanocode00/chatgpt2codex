# Tauri–CLI 기능 대응표 (F5-E)

기준: `src/cli.ts`의 공개 CLI 명령. Tauri는 `tauri-preview-v1` 인스턴스, 기본 로컬 포트 `7979`(설정 화면에서 변경 가능), 앱 전용 HOME 및 SHA 검증된 번들만 사용한다. 서버 포트 변경은 소유권 검증 후 중지·재시작하며, 다른 프로세스는 강제 종료하지 않는다.

원칙: **1개 UI 조작 ↔ 1개 검증된 CLI 명령 또는 명확히 표시된 CLI 하위 명령**. 범용 셸/명령줄 입력창을 만들지 않는다. 모든 CLI 기능을 무조건 Tauri에서 제공한다는 의미는 아니며, 미연결 기능을 항상 표시한다.

| CLI 명령 | Tauri UI | 상태/안전 경계 |
| --- | --- | --- |
| `owner-token --generate/--rotate` | 연결 → MCP 준비 / Token 재발급 | 연결됨. 재발급 시 기존 OAuth 승인 무효화 |
| `start` | 관리 → MCP 시작 / 공개 MCP 시작 | 연결됨. 고정 작업 공간과 검증된 Quick Tunnel |
| `stop`, `restart` | 관리 → MCP 중지 / MCP 재시작 | 연결됨. 엄격한 소유권 검사 |
| `status` / `ps` | CLI 탭 → 진단 → status | 연결됨. `ps`는 동일한 CLI 별칭 |
| `health` | CLI 탭 → 진단 → health | 연결됨. 응답 JSON을 보여주며 오프라인 exit 1도 정상적으로 표시 |
| `logs --component server/tunnel` | CLI 탭 → 진단 → 로그 | 연결됨. 최대 80줄/16KiB 표시, 민감 행 마스킹 |
| `doctor` | CLI 탭 → 진단 → doctor | 연결됨. Tauri 고정 작업 공간 진단, 텍스트 마스킹 |
| `reload` | CLI 탭 → 진단 → reload | 연결됨. Windows는 소유권 확인 후 비공개 인증 Named Pipe, Linux/WSL은 SIGHUP. 프로필·프로젝트 갱신 완료 응답을 확인하며 MCP PID·포트·Quick Tunnel을 재시작하지 않음 |
| `profile list/show/test` | CLI 탭 → 프로필 | 연결됨. Python/Docker 상세 포함 |
| `profile add --python` | CLI 탭 → Python 등록/교체 | 연결됨. 사용자 지정 실제 `python.exe` 확인 및 CLI 자체 실행 가능 검사 |
| `profile add --compose-file` | CLI 탭 → Docker 등록/교체 | 연결됨. Compose 상대 경로와 프로젝트/서비스명 제한 |
| `profile remove [--python/--docker]` | CLI 탭 → 프로필 제거 | 연결됨. 명시적 사용자 확인 |
| `profile import-env` | CLI | 의도적 보류. 환경 변수 반입/검증 설계 필요 |
| `config show --instance` | CLI 탭 → 설정 조회 | 연결됨. 프리뷰 인스턴스 한정 |
| `config export` | CLI 탭 → 비밀 제외 설정 내보내기 | 연결됨. 읽기/미리보기, 파일 저장 UI는 별도 |
| `config set/unset` | CLI 탭 → 설정 변경/해제 | 제한 연결. 고정 인스턴스의 `host/port/tunnel` 안전 범위만; 임의 작업 공간/Named Tunnel 설정 금지 |
| `config import`, `config import-env` | CLI | 보류. 파일/환경 변수/비밀정보 반입 전 별도 설계 |
| `repository list/add/remove` | 관리 → 프로젝트 목록/등록/해제 | 연결됨. 등록 해제는 파일 삭제 아님 |
| `repository show` | CLI 탭 → 추가 조회 | 연결됨. 프로젝트 ID의 세부 메타데이터 |

| `repository use` | CLI (프리뷰에서는 사용하지 않음) | Tauri는 전역 선택 프로젝트가 아닌 복수 프로젝트 catalog + 도구별 `projectId` 사용 |
| `secret list` | CLI 탭 → 추가 조회 | 읽기 전용. 비밀정보 **이름만** 표시, 값 조회 불가 |
| `lock list` | CLI 탭 → 추가 조회 | 읽기 전용. 격리 HOME의 잠금 목록 |
| `job list/status/logs` | CLI 탭 → 추가 조회 | 읽기 전용. 작업 상세·최근 로그 10건; 비밀 키·Bearer 문자열 마스킹 |
| `control list/auto status` | CLI 탭 → 추가 조회 | 읽기 전용. 제어 요청과 자동 승인 상태만 표시 |
| `secret set/remove/import-env` | CLI | 보류. 비밀정보 입력·저장·권한/승인 UI 필요 |
| `lock release`, `job resume/cancel`, `control approve/reject/kill/auto on/off` | CLI | 보류. 실행 중 작업/권한/잠금 변경은 추후 검증·확인 모델 필요 |
| `serve`, `init` | 내부 런타임 관리 | Tauri는 고정 인스턴스 및 `owner-token`으로 별도 준비; 일반 CLI 진입을 열지 않음 |
| `help` | CLI 대응표 + 문서 | 명령별 정식 도움말은 터미널에서 `c2c help` |

## 테스트 경계

- PR 자동 검증: 타입 검사, Rust 단위 테스트, Node/CLI 격리 실행, Windows Tauri 빌드/Smoke.
- 사용자 Windows 수동 검증: 프로필 Python/Docker 추가·확인·테스트·삭제, 설정 표시/내보내기 및 제한 변경, 실행 중 `reload`, `health/doctor/logs`, WinForms/7979 무변경. 여러 기능 구현을 마친 뒤 **한 번** 통합 검증한다.
- CLI 전체 1:1 목표는 위 표의 **보류 항목을 안전하게 명시적 지원하거나 CLI 전용으로 문서화**할 때까지 진행 중이다. 일부 UI 화면을 구현했다고 전체 CLI가 완전 지원된 것으로 주장하지 않는다.

## Windows reload (F5-E 후속)

- Windows에서 `c2c reload --instance tauri-preview-v1`는 **실행 중인** 전용 서버의 프로젝트/프로필 목록만 갱신한다. 더 이상 Linux 전용 `SIGHUP`에 의존하지 않는다. Linux/WSL은 기존 신호 동작을 유지한다.
- 프로세스 소유권 검증 후 격리 사용자 상태 폴더의 일회성 랜덤 인증 정보와 Windows Named Pipe로 서버에 직접 요청한다. 공개 HTTPS, MCP, Cloudflare를 거치지 않는다. 임의 shell 명령이나 Owner Token은 전송하지 않는다.
- 성공 응답은 실제 서버가 업데이트를 완료한 뒤 반환하며 PID, MCP 포트와 Quick Tunnel 주소는 변하지 않는다. 실패·구버전 서버·외부 PID는 거부하고 **자동 restart는 실행하지 않는다**.
- Python/Docker 프로필 또는 프로젝트 추가/제거 시 지원되는 실행 중인 Windows 인스턴스에 자동 재로드를 시도하며 CLI의 `liveReload` 결과에서 성공/실패 여부를 확인할 수 있다.
- 이전 번들에서 이미 실행 중인 MCP 서버에는 파이프가 없다. **최초 업그레이드 시에만 완전 종료 → 새 번들 실행 → 공개 연결 시작이 필요**하다. 이후 일반 `reload`는 ChatGPT 연결을 끊지 않아야 한다.
- `host`, `port`, `tunnel`, `public-hostname` 변경은 여전히 별도 재시작이 필요하다.
