# WinForms → Tauri functional parity inventory (F5 baseline)

As of **2026-10-28**, based on repository \`main\` at
\`f8d006b2181d2d208bbc697e4b3c0d74ace39fab\` (merged PRs #69–#75).
The baseline is \`windows/ChatGPTToCodexLauncher.cs\`; Tauri behavior comes
from \`desktop/src/{App,LegacyControls,MigrationPreflight,runtime}.*\` and
the exact native command registration in
\`desktop/src-tauri/src/lib.rs\`.

This is **a source-and-evidence audit, not an assertion that the Windows
applications are functionally interchangeable**. The installed legacy
WinForms application and its live \`default\` instance on port **7979**
must remain untouched. F4-E production cutover stays **NO-GO**.

## Terms and ownership

- **Connected**: usable Tauri native control with a defined scope.
- **Read-only**: observed status; cannot change the associated runtime.
- **Partial**: a related control exists, but the WinForms operation is not
  fully implemented or targets a different instance.
- **Pending**: intentionally disabled / UI placeholder; a visible control
  must never imply functional parity.
- **Independent**: \`tauri-preview-v1\` uses an owned bundled Node CLI,
  isolated HOME/workspace, \`127.0.0.1:18797\`, **no tunnel**, with
  separate credentials. This is NOT WinForms \`default:7979\`.

## Feature-by-feature comparison

| Domain / WinForms baseline | Tauri UI behavior on current main | Classification | Next action |
| --- | --- | --- | --- |
| Main window with runtime status | Overview and local \`/healthz\` probe; user-selectable **monitoring** port only | Connected / read-only | Distinguish inspected port and owned-instance scope |
| WinForms MCP start / stop / restart | Manage buttons actually control **independent** \`tauri-preview-v1:18797\`, not legacy \`default:7979\` | Partial / independent | Keep legacy control read-only; later enable only audited ownership-scoped controls |
| Server/runtime state in tray | Tauri tray and window lifecycle implemented | Connected, limited manual proof | No per-legacy-service tray control assumed |
| Hide to tray / restore | Native tray close/hide/restore exists; **Manage → 트레이로 숨기기** is still disabled | Partial | **F5 quick win:** bind this button to existing native tray behavior |
| Duplicate desktop launch | Windows native single-instance callback restores window | Connected | Reuse existing regression tests |
| App exit independent of server | \`앱 종료\` command exits Tauri preview without stopping default server | Connected | Clarify owned background-instance lifetime on app exit |
| Selected WinForms project folder / Browse | Tauri Manage selected-project field and Browse are disabled; migration reports/snapshots can **inspect** legacy selection | Partial / read-only | **F5-A:** expose current selection read-only, then separated picker/change flow |
| WinForms project startup workspace | No connected WinForms workspace selector; independent CLI fixed preview workspace | Pending | Scope any editable selection to owned preview instance only |
| CLI project catalog (not a WinForms UI parity item) | CLI project list/show/add/remove exists, but Tauri project list UI not connected | Pending / CLI extension | **F5-A:** read-only list with bounded, typed results |
| CLI Python/Docker profile catalog (not a WinForms UI parity item) | CLI profile list/show/test/add/remove exists; Tauri profile select disabled | Pending / CLI extension | **F5-A:** read-only profile summary; defer edits |
| Local MCP URL / copy | Local endpoint display/copy uses inspected localhost port | Connected | Do not represent local address as public OAuth endpoint |
| Cloudflare Quick Tunnel / Named hostname | Public HTTPS health and verified/stale URL/copy exist; tunnel enable, hostname edit and lifecycle are disabled | Partial / read-only | Read-only status first; user-owned settings only in a later opt-in change |
| ChatGPT web-connector enable | Related status UI, but switch and persisted configuration are not connected | Pending | No automatic re-registration or issuer changes |
| Owner Token copy / regenerate | Legacy token UI intentionally disabled; dedicated preview \`prepare\` can create a **different**, one-time token | Partial / independent | Preserve legacy credential isolation; never display original token |
| Local health and server / tunnel logs | Native local probe, bounded redacted CLI log reader, WinForms temp-log fallback, public probe | Connected / read-only | Add evidence of origin and staleness where relevant |
| Open local/public health in browser | Native probes exist, but WinForms open-link parity is incomplete | Partial | F5 quick win: trusted/verified URL open only |
| GitHub repository open / developer info | Buttons remain disabled | Pending | F5 quick win: trusted URL only, no arbitrary launcher |
| Update check / auto update | Disabled UI; dedicated NSIS setup and CI upgrade fixture **are not an updater** | Pending | Defer updater/signing to release track |
| Launcher language setting | Tauri shows disabled legacy setting; existing UI language hardcoded in parts | Pending | Localized UI/preferences as separate feature |
| Windows login auto-start | Dedicated **Tauri-only** HKCU Run entry can be toggled in real installed NSIS app; legacy Run entry untouched | Connected / Tauri-only | No claim of legacy startup preference migration |
| Start MCP when launcher opens | Disabled; never auto-start live default | Pending | Opt-in independent-instance policy only |
| MCP actual server port | WinForms persisted port can be inspected by migration; Tauri settings port changes **monitoring only** | Partial / read-only | Avoid silently converting monitor port into server port |
| Public hostname / GitHub repository / persisted launch options | Read-only WinForms migration inspection/snapshot and disabled edit fields | Partial / read-only | Read-only visibility first, editing later with explicit ownership |
| Settings save | Only frontend monitoring preference saves; WinForms settings are not rewritten | Partial | Do not label local UI preferences as CLI runtime settings |
| Existing settings and credential backup | Read-only migration, DPAPI encrypted backup + disposable restore rehearsal | Connected / safety tooling | Not a live restore or production handover |
| Installed Windows setup/reinstall/uninstall | Separate Tauri \`currentUser\` NSIS; hosted Windows install/uninstall and 0.1.0→0.1.1 fixture tests | Connected / independent | No auto-updater, signed release or WinForms uninstallation |

## Evidence: tests and limitations

- Windows CI on PRs **#74/#75**: standalone NSIS build;
  disposable installation and uninstallation; bundled CLI hashes;
  separate legacy Run sentinel; same-version reinstall and test-fixture
  version upgrade; isolated preview data preserved.
- Windows laptop human acceptance on **2026-10-28**:
  installed Tauri EXE and bundle present alongside WinForms;
  GUI worked; dedicated login-start Run value ON then OFF;
  Tauri-only uninstalled; existing default remained
  \`alive=True\`, \`healthy=True\`, \`port=7979\`.
- **Not proven** by that acceptance: real Windows relogin auto-launch;
  each tray interaction and duplicate-window edge case in that
  installation; actual production OAuth/ChatGPT public roundtrip;
  Windows live default-instance ownership takeover;
  interruption halfway through a real NSIS installer and automatic
  rollback; signed package or an updater.
- In particular, a synthetic journal/fixture or a rejected corrupt
  installer is **not** proof of crash-safe recovery of a live client.

## F5 implementation order: user-visible value first

### F5-A — make project/profile information useful (first PR)

1. Add a narrow, **read-only**, typed native Rust bridge that uses only
   a verified bundled CLI/exact preview workspace to retrieve
   \`project list\` and \`profile list\` (or the existing native catalog
   API if already audited). Show current scope and empty/error states.
2. Display legacy selected-project **read-only** only if the existing
   migration inspector already supports it. Never auto-import that
   project into the owned preview. Never leak raw config secrets.
3. Replace disabled placeholders in Manage with truthful data, keeping
   browsing/editing disabled until scope and ownership are defined.
4. Accept: no writes to legacy settings/default/7979; unknown CLI or
   malformed data fail closed; Windows CI, UI build and a short human
   preview check. **Do not add installer/reboot/cutover tests** to this
   read-only feature PR.

### F5-B — connect small native UI affordances (independent PR)

- Wire \`트레이로 숨기기\` to the existing native Tauri window/tray
  handler; keep exit separate from server stop.
- Wire repository/open-health actions only to fixed trusted URLs or
  verified endpoint origins, with bounded inputs.
- Accept: UI action does what its label says, no arbitrary command or
  execution path, no default-instance mutation.

### F5-C — owned-instance project selection and runtime preferences

- Introduce explicit profile/project selection for the **owned**
  \`tauri-preview-v1\` only with selection preview and confirmation,
  exact CLI ownership validation and no hidden runtime restart.
- Add settings editing only when the canonical CLI config interface and
  error/rollback behavior are defined. Keep WinForms configuration
  separately read-only until a future migration decision.
- Add Cloudflare management and token rotation **only** after separate
  credential/issuer UX decisions; no silent rotation.

### F4-E — production cutover (separate, later)

Requires its own explicit operator approval and live proof of process
identity, ACL-safe state migration, credential/OAuth issuer continuity
or planned reconnect, and rollback. **Do not make F5 depend on this.**

## Previously open PRs to triage, not merge as F5 shortcuts

- **#50:** old Windows installer payload tests. Check overlap with
  merged independent NSIS F4-D4 CI before any reuse.
- **#52:** older WinForms visual-dashboard direction; superseded as
  the UI implementation by Tauri 2 + React. Review/close only after
  checking that it contains no independent necessary change.
- **#54:** old draft PID ownership guard. Investigate whether its
  proposed checks are already covered by the current CLI; do **not**
  merge blindly into the live Windows process lifecycle.

## Scope control

Treat F5 as product UI and feature wiring. Prefer one small PR per
visible behavior; extend targeted tests, not the migration/release
matrix, unless the change actually affects that boundary. Never touch
the dirty \`/home/honorbear/chatgpt2codex\` main worktree as part of
the review. This inventory is documentation only; it adds no privileged
desktop control or Windows machine changes.
