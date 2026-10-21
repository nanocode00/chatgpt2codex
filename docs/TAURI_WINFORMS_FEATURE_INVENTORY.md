# WinForms → Tauri feature inventory (UI-only parity)

Tracking: #51. Original user-supplied WinForms screenshots reviewed 2026-10-21:
main window, tray context menu and settings dialog.

This branch adds **visual control coverage only**. `disabled` means there
is intentionally no handler, no Tauri command, and no process/token/config
mutation. Greyed-out controls show **연동 예정**. Blank settings do not claim
to reflect the installed WinForms preferences.

| WinForms control | Tauri location | Current behavior |
| --- | --- | --- |
| MCP 시작, 중지, 재시작 | 관리 → MCP 서버 제어 | Disabled pending audited shared CLI |
| 트레이로 숨기기, 종료 | 관리 → 앱·트레이 | Disabled until Tauri tray lifecycle exists |
| 프로젝트 폴더 / 찾아보기 | 관리 → 프로젝트 | Disabled; existing folder path not read |
| 프로필 선택 | 관리 → 프로젝트 | Disabled future unified CLI catalog |
| 커넥터 URL 복사 | 연결 → 로컬 MCP URL | **Working** local-only copy, not public URL |
| ChatGPT 웹 커넥터 사용 | 연결 → 외부 ChatGPT 연결 | Disabled; existing setting not imported |
| 본인 소유 고정 도메인 | 연결 → 외부 ChatGPT 연결 | Disabled, no fake tunnel hostname |
| 공개 상태 열기 / 공개 URL 복사 | 연결 → 외부 ChatGPT 연결 | Disabled; avoid claiming localhost is public |
| Owner Token 복사 | 연결 → Owner Token | Disabled, secret never shown or cached |
| Owner Token 자동 생성 | 연결 → Owner Token | Disabled; no token rotation |
| 로컬 상태 확인 | 진단 → 진단 도구 | **Working**, reuses native health probe |
| 공개 상태 열기 | 진단 → 진단 도구 | Disabled until tunnel health contract |
| 로그 보기 | 진단 → 진단 도구 | Disabled; health events are not server logs |
| 업데이트 확인 | 진단 → 진단 도구 / 설정 | Disabled |
| GitHub 저장소 / 개발자 정보 | 진단 → 진단 도구 | Disabled pending trusted URL policy |
| 언어 | 설정 → Windows 런처 설정 | Disabled, default selection not implied |
| Windows 시작 시 실행 | 설정 → Windows 런처 설정 | Disabled, existing registry untouched |
| 앱 열 때 MCP 자동 시작 | 설정 → Windows 런처 설정 | Disabled |
| 업데이트 자동 확인 | 설정 → Windows 런처 설정 | Disabled |
| 로컬 포트 설정 | 설정 → Windows 런처 설정 | Disabled actual server port |
| GitHub 저장소 URL | 설정 → Windows 런처 설정 | Disabled; value not imported |
| 설정 저장 | 설정 → Windows 런처 설정 | Disabled for runtime preferences |
| 모니터링 조회 포트 / 자동 Health | 설정 → 모니터링 | **Working**, frontend-only preference |
| CLI 상태 조회 | 연결 → CLI 관리 인스턴스 | **Working**, read-only fixed installed CLI |

## Implementation sequencing

1. Keep Tauri overview and native health intact. All new controls are
   view-only until their privileged CLI equivalents pass tests.
2. After #54 safe Windows lifecycle review, wire fixed typed commands for
   **CLI-owned** instance management (start, stop, restart) without taking over
   v0.3.1 WinForms-managed runtime.
3. Wire projects / profiles / log diagnostics to shared instance manager.
4. Add Cloudflare Quick/Named Tunnel semantics and public endpoint ownership.
5. Add token handling with explicit rotation confirmation and never export
   secrets to browser storage or diagnostics.
6. Migrate WinForms settings with backup, idempotency and user-visible diff;
   then implement native startup, tray, update and settings persistence.

Do not claim GUI feature parity until both the visual and behavior columns
are complete. This PR only completes the **visual inventory**, not parity.
