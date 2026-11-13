# Screen 8 — CLI 콘솔 Windows 검수

기준: PR #101 설정 화면 위에 쌓인 `feat/tauri-cli-console` 브랜치.

## 구성

- 기존 F5-E의 탭·버튼별 명령 연결 화면을 **CLI 콘솔**로 교체.
- 단일 C2C 명령 입력, 약 240ms 디바운스 네이티브 문법 검사, 수동 문법 검사, Enter 실행, ↑ 최근 명령 불러오기.
- 실행 결과(JSON/텍스트), 소요 시간, 실패 이유, 결과 복사, 현재 세션 최근 25건 목록. 원문 명령/결과를 디스크에 별도 저장하지 않음.
- `c2c help`는 안전한 로컬 문법 안내. 예제 버튼으로 대표 명령 입력.
- 인증정보 및 민감 문자열은 기존 `cli_parity`의 마스킹 정책을 유지.

## 보안·기능 경계

- 입력은 명령 문자열로만 받지만 **직접 PowerShell/CMD 또는 범용 셸 실행기는 아님**. 서버에서 단일 행·길이·문법·인스턴스를 검사하여 고정 CLI 요청으로 변환.
- 지원되지 않는 옵션, 연결 명령, 경로/셸 리다이렉션, 파이프, 프로세스 제거, 비밀정보 설정, 권한 제어, 다른 인스턴스 호출을 거부.
- `status/health/doctor/logs`, 카탈로그 조회, 프로필/작업 조회, 한정된 설정 조회·변경, 소유권 검사된 `start/stop/restart`, `reload` 및 `job resume/cancel` 등 제공.
- **상태 변경 명령**은 반드시 실행 전 확인. `start/stop/restart`는 기존 `manage_owned_cli` 경로로만 실행.
- 다른 인스턴스를 가리키는 `--instance`는 오류. 명시적으로 지정하려면 `tauri-preview-v1`만 허용.
- `--port` 직접 변경은 금지; 포트는 설정 화면에서만 변경.

## Windows 수동 검수

1. CLI 메뉴를 열면 명령 입력, 문법 상태, 예시 버튼, 실행 결과, 세션 기록 영역이 보인다. 기존 버튼 매트릭스는 사라진다.
2. `c2c help`, `c2c status`, `c2c health`, `c2c repository list`, `c2c profile list`를 실행하고 JSON/텍스트 결과가 표시되는지 본다.
3. `c2c logs --component server` 및 `tunnel`: MCP 중지 상태에서도 이전 로그 또는 빈 결과가 나타나는지 점검.
4. `c2c status && whoami`, `c2c status --instance default`, `c2c secret set token foo`, `c2c config set port 12345`: 실행 전에 문법 거부를 확인.
5. `c2c restart` 또는 `c2c reload`는 확인창에서 취소하면 실제 동작하지 않는지 확인. 승인 후에는 기존 소유권 규칙을 지킨다.
6. 명령 실행 실패 시 사유가 출력에 보이고 성공으로 표시되지 않는지 확인. 출력 복사, 최근 25건, ↑ 기록 불러오기, 좁은 화면 레이아웃을 확인.
7. 콘솔에서 서버를 중지/재시작한 후 대시보드와 연결 화면의 상태를 다시 확인한다. (화면 간 실시간 갱신은 별도 개선 가능.)

## 검증

- `npm --prefix desktop run build`: 로컬 TypeScript + Vite.
- Rust unit tests: 콘솔 문법 허용/거부 경계, Windows CI에서 실행.
- CI/Windows Tauri Desktop Smoke: 신규 Draft PR 생성 후 확인.
- 실제 Windows 수동 검수 전에는 PR 병합하지 않음.
