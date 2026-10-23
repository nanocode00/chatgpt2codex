# F4: WinForms → Tauri production cutover and rollback gate

**Status: design only. No production cutover, credentials import, installer change,
server stop, port takeover, OAuth registration change, or token rotation.**

Inputs: the merged Tauri foundation and isolated lifecycle (#53, #55–#59),
read-only migration inventory (#60), current-Windows-user DPAPI backup (#61),
encrypted-only restoration rehearsal (#62), and synthetic private CLI authentication
E2E (#63). These demonstrate implementation building blocks, **not** a safe
transaction against a live, connected ChatGPT instance.

## 1. Non-negotiable invariants

1. The user explicitly chooses when to begin; preflight, backup and preview
   never implicitly initiate cutover. Show the actual endpoint, selected project,
   public issuer and anticipated disconnection, but **never secrets**.
2. Legacy `default` on `127.0.0.1:7979` and `tauri-preview-v1` on
   `127.0.0.1:18797` remain independently owned until a separately approved
   transaction. No port collision or two writable CLI processes using the same
   OAuth/state directory. Never assume a recorded PID belongs to C2C.
3. No Owner Token plain text is stored in the existing credential backup:
   `owner-token.json` contains only a verifier hash. Existing ChatGPT OAuth
   state includes client/token **hashes**, not recoverable bearer secrets.
   Backing up hashes does not prove that remote clients still possess valid,
   unexpired tokens, matching scopes or the expected issuer.
4. The DPAPI backup is bound to the same Windows user. It is not a
   cross-machine/account disaster-recovery mechanism. Never print, log,
   upload, or send decrypted owner/OAuth state to the WebView or a PR.
5. Preserve the immutable, original DPAPI archive and existing WinForms
   install until a *separate* explicit removal decision **after** successful
   cutover and rollback rehearsal.
6. Preserve the actual origin/issuer: a `trycloudflare.com` Quick Tunnel URL can
   change across restarts. If it cannot remain the identical issuer, **block
   claims of transparent OAuth continuity**; plan a user-approved reconnect
   instead. A healthy local `healthz` does not prove public OAuth continuity.
7. Stop only a process whose executable/argv, instance, workspace, start time,
   PID and listener ownership were verified. Never blindly kill a process
   occupying 7979 or terminate an unverified legacy/cloudflared instance.
8. Fail closed on malformed state, ACLs, reparse points/junctions, symlinks,
   stale backup, changing OAuth source, unexpected listener ownership or
   unavailable rollback. Cancel before the irreversible boundary must be safe.
9. Existing Worktree, branch, and Tauri preview changes must not be removed by
   the migration. The migration transaction operates on **runtime state only**.

## 2. Required parity and preconditions (no-go if unresolved)

| Area | Preflight requirement | Blocker / plan |
|---|---|---|
| Existing runtime | Legacy default PID, exact binary and command line, port and health are matched | Unknown PID owner: abort, require manual operator investigation |
| Settings | Selected project exists; expected startup, tray, language and update settings mapped | Tauri lacks required feature: keep WinForms |
| Credential data | Stable two-phase snapshot of owner hash, OAuth, settings and optional project; schema/length/hash valid | Race or malformed content: abort; preserve original |
| ACL | Same-user private staging, restrictive DACL on directories/files, no inherited broad read access or reparse points | Cannot restrict/verify: abort before plaintext staging |
| DPAPI | Fresh archive verified on the exact Windows account, original archive preserved | Decryption failure or stale/incomplete state: abort |
| Public auth | Stable HTTPS issuer, resource URL, scope, audience, existing clients and token expiry reviewed | Quick Tunnel changed: reconnect plan and explicit user approval |
| Rollback | Original launcher/CLI still installed; verified legacy start path and reachable recovery instructions | Any missing recovery prerequisite: abort |
| Runtime capability | Audited CLI binary+manifest integrity, instance control, localhost and public probes verified | Bundle mismatch or listener conflict: abort |
| Consent | User has seen downtime, public connector implications and success/rollback criteria | No explicit consent: remain in preview |

Preflight must be read-only. Never make `canTransitionNow` true merely because
F1–F3 pass; enable it only when the future implementation checks **all**
runtime gates and a reversible transaction is available.

## 3. Proposed transactional state machine

Persist a **secret-free, fsync'd** transaction journal containing a random
operation ID, state, source/target instance identifiers, file digests,
verified binary digests, preflight decisions and monotonic step outcomes.
Avoid credential bytes, token hashes, raw URLs containing secrets or sensitive
absolute paths in journal and telemetry. Encrypt additional necessary
metadata locally if a safe subset cannot be used.

| State | Allowed action | Failure/restart behavior |
|---|---|---|
| `IDLE` | Read-only readiness | Do nothing |
| `PREFLIGHT_OK` | Verify every gate; capture immutable evidence | Abort on changed input |
| `STAGED` | DPAPI-protected checkpoint; private target staging; verify ACL/hash/schema | Delete staging on failure; keep original |
| `QUIESCE_REQUESTED` | Explicitly confirm shutdown and revoke *new writes*, not credentials | Cancel if legacy cannot be safely quiesced |
| `LEGACY_STOPPED` | Graceful stop of **verified** legacy process; confirm PID exit, port free and OAuth writer absent | Resume verified legacy when safe |
| `TARGET_STARTING` | Start one verified target on approved listener with isolated controlled state ownership | Stop only owned target then rollback |
| `PROBING` | Check local API owner bearer, MCP OAuth exchange, public issuer/endpoint and user-visible ChatGPT reconnection | Roll back or hold for explicit reconnect decision |
| `COMMITTED` | Confirm durable ownership; preserve rollback materials | Do not uninstall WinForms automatically |
| `ROLLBACK` | Stop owned target, restore verified original state, start legacy with verified binaries, confirm local/public status | Escalate to safe manual recovery; never force PID kill |
| `MANUAL_RECOVERY` | Present actionable, nonsecret status/instructions | No repeated blind auto-retry |

At every step the transaction acquires an OS-level single-instance operation
lock. Fresh reads of lease/owner/port must be taken **at action time**, not just
preflight. Journal recovery after a crash must be idempotent and decide whether
legacy or target is active before acting; do **not** auto-kill an unknown process
on startup. No two processes may write the same `oauth.json`. Recovery should
require explicit owner confirmation whenever there is ambiguous ownership.

### Credentials and origin strategy

Preferred option for preserving the existing ChatGPT registration: retain the
exact compatible localhost/public issuer semantics **and** already-valid OAuth
state, with runtime ownership moved only after the old writer has stopped.
The issuer must be compared byte-for-byte after normalized URL validation.
Do not claim continuity based on restored token-hash files alone; exercise a
real user-approved ChatGPT client roundtrip in a controlled acceptance check.
The F3 synthetic token test is explicitly insufficient.

If Quick Tunnel changes the public issuer or the old token set is expired,
support a **separate opt-in reconnection** path. Never silently rotate Owner
Token, revoke existing clients or write updated connector settings. The real
OAuth state/refresh tokens and Owner Token may be unavailable to the tool;
ask the local owner to complete the login or reconnect through the supported UI,
without pasting bearer secrets into a chat.

### Restore mechanics

Do not restore from the real DPAPI backup into a shared production HOME until
all write-exclusion and ACL checks pass. First stage under a fresh random
same-user-private directory with allowlisted filenames, restrictive ACLs and
byte-for-byte checksums. Verify no unexpected junction/symlink in any ancestor.
After quiescence and verified old process exit, use a documented atomic switch
or copy + fsync sequence into the **approved** target and protect a full,
immutable rollback snapshot. Check Windows replace/rename semantics explicitly;
do not assume POSIX atomic directory rename behavior on Windows.

## 4. Rollback guarantees and exit criteria

Automatic rollback is allowed only when the target was launched by this
transaction and both prior and next process identities are unambiguous.
Never overwrite changed OAuth state from a concurrently active process. If
stale tokens, public DNS or issuer changes preclude transparent reconnection,
show this as a **partial recovery** rather than a successful rollback.

Successful cutover requires: one active default server; authenticated local
Owner Token requests; successful OAuth MCP access with the user-approved
connected client; correct public origin; expected selected project/profile;
no duplicate writer, no leaked credentials, and durable recovery journal.
Success must be **measured after** the actual switch, not inferred from F3.

Successful rollback requires: target stopped with verified ownership;
original launcher/runtime restored and healthy; original credentials/hash
files unchanged or verified restored; expected public connector state observed
and clearly reported; no orphan listeners; no loss of rollback archive.

## 5. Test matrix before any shipping cutover UI

- Disposable Windows runner: success path and rollback after every state
  transition; fault injection for locked/invalid ACL, junctions, corrupt DPAPI,
  wrong-user DPAPI, invalid schema/checksum, missing source files, disk full
  and power-loss-like partial journal writes.
- Refuse forged or reused PID, unrecognized `cloudflared` ownership,
  7979 occupied by an unrelated process, conflicting target process and
  simultaneous transaction attempts. Prove no foreign process is signaled.
- OAuth: missing/expired access token, invalid refresh, mismatched issuer,
  changed Quick Tunnel, wrong resource/scope, and valid controlled fixture
  across full MCP exchange. Never export real secrets as test artifacts.
- Idempotency: retry/read-only status after crash at each phase; correct
  manual recovery instructions; cancel before stop; verified rollback after
  target launch; proof that no two writers share OAuth files.
- Real Windows **manual acceptance**, with backups checked and old launcher
  still installed: opt-in cutover, measured local/remote auth and manual
  rollback rehearsal **before** any launcher deprecation.
- Product parity: tray behavior, startup, logs, install/update/uninstall,
  settings and project/profile selection must have acceptance tests.

## 6. Implementation split (future reviewable PRs)

1. **F4-A: Transaction spec + security review (this document).** No runtime
   writes or UI switches. Resolve public issuer/Quick Tunnel continuity and
   source ACL/backup handling.
2. **F4-B: Read-only cutover readiness.** Implement exact process/port,
   credential freshness and issuer checks; evidence-only dry-run UI.
3. **F4-C: Disposable reversible transaction engine.** Journal/lock,
   fault injection and per-phase rollback; synthetic credentials only.
4. **F4-D: Private Windows same-user acceptance.** Manual checks of real
   WinForms/Tauri feature parity and explicitly authorized OAuth/reconnection
   rehearsal; still no uninstall.
5. **F4-E: Opt-in production cutover.** Ship only after audited F4-B/C/D
   gates, signed distribution/recovery and review. Keep rollback until the
   user separately retires WinForms.

**Release decision:** F1–F3 green; **F4 NOT READY** for automatic production
cutover. This document is a gating contract, not permission to initiate it.
