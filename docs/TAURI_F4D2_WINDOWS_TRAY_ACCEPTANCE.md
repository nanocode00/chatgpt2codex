# F4-D2-A: Tauri Windows tray and window acceptance

**Goal:** Close the F4-D2 gap observed during the user's side-by-side
Windows acceptance: all five application pages looked functional, but window
and system tray behavior were missing. This PR does **not** alter WinForms,
the default C2C server, port 7979, Cloudflare, OAuth, login startup settings
or a production cutover. The native tray module is Windows-only.

## Native preview behavior

| Action | Expected result |
|---|---|
| Start Tauri preview | Main window and C2C tray icon appear |
| Minimize main window | Preview is hidden to tray, not terminated |
| Click title-bar X | Preview is hidden to tray, not terminated |
| Double-click tray icon (left mouse) | Main window restored, unminimized and focused |
| Right-click tray > 창 열기 | Main window restored and focused |
| Right-click tray > 프리뷰 종료 | Exit **Tauri preview only** |
| Manage view > 앱 종료 | Exit **Tauri preview only**, not merely hide |
| Reopen preview after exit | Opens normally; separately installed WinForms still functional |

The tray uses `tauri::tray::TrayIconBuilder` and a default embedded icon.
Menu IDs are restricted to `preview-show` and `preview-quit`. There is
no tray action to start, stop, restart, kill or manage C2C processes or
tunnels. Explicit exit uses `AppHandle::exit(0)`; the native title-bar
close event intercepts the window only after a successful hide.

## Human acceptance (Windows)

1. Leave the **legacy WinForms/default 7979** instance and current
   Cloudflare/ChatGPT registration running. Never choose a stop/start
   action on it.
2. Download the unsigned Windows **preview** artifact from this PR's
   successful Tauri Desktop Smoke run. Extract the whole archive so
   the bundled runtime stays adjacent to the EXE.
3. Launch Tauri and confirm the window AND its own distinct tray icon.
   Check it is the preview's icon, not the WinForms icon.
4. Minimize and restore using tray menu and left double-click. Repeat
   using X and the tray icon.
5. Open Tauri's 관리 page and select explicit preview exit. Confirm that
   the tray icon disappears while WinForms/default stays healthy.
6. Relaunch the preview, then select right-click tray > 프리뷰 종료.
   Again confirm `127.0.0.1:7979/healthz` still responds and
   the existing ChatGPT connector has not been reconfigured.
7. Compare with WinForms tray/launch behavior and record visible
   differences. In particular, do not interpret working tray behavior
   as proof of single-instance protection or login-startup equivalence.

**Fail criteria:** no tray icon, blank/unrestorable window, accidental
termination of the WinForms/default process, tray item launching an
unintended CLI or stale hidden preview that cannot be exited. A failed
step blocks F4-D2 parity sign-off; do not proceed to a real cutover.

## CI and limitations

CI compiles the real Windows Tauri tray API and includes the small native
tray action ID regression test in `cargo test --lib`. Native tray
interaction itself needs real Explorer/manual acceptance; CI cannot certify
shell notifications, minimized-window behavior, restart semantics or tray
icon focus on the user's desktop. Auto-start parity, correct Windows
installer/update, OS process ownership, actual OAuth continuity, real
rollback and **F4-E production transition** remain unverified/no-go.

See [F4-D1 read-only observations](TAURI_F4D_WINDOWS_MANUAL_ACCEPTANCE.md)
and [F4 release gates](TAURI_PRODUCTION_CUTOVER_ROLLBACK_GATE.md).
