# C2C CLI 상태 조회 지연: 경로 분석과 개선

## 기존 경로 (스크린 8, PR #102)

`CLI 콘솔 입력 → 네이티브 문법 검사 → invoke(run_owned_cli_console) → execute → managed_cli::parity_cli`

정상 상태의 `c2c status`에도 다음 항목들이 매번 발생했다.

1. `payload()`가 번들 manifest를 확인하고 Node, CLI JS, cloudflared 실행 파일 전체의 SHA-256을 계산.
2. `record_if_any()`가 소유권을 확인하며 `expected_record()`로 진입.
3. 이전 Tauri 사용자선택 작업 공간 확인을 위해 `selected_workspace()`가 고정 작업 공간과 이미 일치하는 경우에도 호출. 내부에서 **추가 Node CLI `config show`**, 선택 저장소가 있으면 **`repository list`**까지 실행 가능.
4. 이후 실제 `c2c status --instance tauri-preview-v1` 실행을 위해 또 별도의 Node CLI 프로세스 생성 및 종료 대기.
5. 상태 조회는 CLI 쪽에서 PID와 Health를 확인하고 JSON을 반환.

즉, 현재 작업 공간에 대한 반복 상태 조회에서 불필요한 외부 프로세스가 생기고, 커다란 번들 파일의 해시 및 Node 초기화가 매번 반복되었다.

## 변경

- **소유권 검사의 조기 종료:** 기록의 `workspace`가 앱 소유 고정 작업 공간과 동일하면 `selected_workspace()`를 호출하지 않음. 과거 작업 공간은 기존 호환 경로 유지.
- **상태 조회 전용 네이티브 경로:** `status` 및 로컬 `health`는 고정 위치의 상태 기록(128 KiB 상한, symlink 거부), CLI 경로, 소유 작업 공간, 포트, 로컬 Health의 JSON 서비스 ID와 Windows 프로세스 생존 여부를 직접 확인. 외부 프로그램을 시작하거나 기록을 변경하지 않음.
- **예외 폴백:** 예전 작업 공간, PID 확인 불가, 종료된 PID, 공개 터널의 외부 Health 검사 등은 기존 **해시 검증된** CLI 경로 유지.
- **안전 분리:** 서버의 시작·중지·재시작·설정·작업 변경 명령에는 원래의 전량 SHA 검증, 잠금 및 프로세스 소유권 검사를 계속 적용. 읽기 전용 네이티브 경로에서 사용하는 번들 파일 경로는 식별용일 뿐 실행에 사용하지 않음.
- **계측:** CLI 콘솔의 결과 하단에 해당 경로(네이티브/Node CLI)와 조회 소요 밀리초를 표시. 기존 화면도 전체 실행 경과 시간을 표시함.

## 검증

- Rust Windows 단위 테스트: 무효한 Node 실행 파일을 둔 상태에서도 같은 고정 작업 공간의 실제 기록/현 PID를 조회, 원본 기록 무수정, 잘못된 작업 공간은 폴백 처리.
- 프런트엔드/소스 회귀 테스트.
- Windows Tauri Desktop Smoke + 사용자 PC에서 실제 비교:
  - `c2c status` 3회 반복: 최초/반복 소요 시간과 결과 하단 경로 확인
  - `c2c health` 로컬/터널 상태 확인
  - `c2c logs --component server` 정상 로그 및 부재 로그 확인
  - 서버 중지 뒤 offline 조회, 다시 시작 뒤 running 조회
  - 재시작·포트 변경 등 **상태 변경 명령**의 보호 장치 유지

실제 Windows PC 환경의 전후 성능 수치는 아직 측정되지 않았으므로, 임의의 개선 배수나 시간 단축을 주장하지 않는다.
