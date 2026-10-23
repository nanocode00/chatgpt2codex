# F4-C0: Disposable cutover journal and rollback fault-injection fixture

**This PR only implements a test-only Rust state-machine harness.**
There is deliberately **no** production cutover executor, no Tauri invoke
command, no token read/move, no real CLI process stop/start, no listener
handover and no Windows installer changes. It is not F4-C production-ready.

## Motivation

F4-A defines the release gates and F4-B exposes read-only blockers. Before
implementing a real transaction engine, model how a journal, exclusive lease,
phase transitions, faults, and rollback are expected to behave *when every
process and credential is synthetic*.

## Hard execution boundaries

The fixture is compiled only with Rust `#[cfg(test)]`. The integration tests
perform their bodies only when all conditions are true:

- `windows-latest`, `GITHUB_ACTIONS=true`, `CI=true`,
  `C2C_F4C_E2E=true`, and a real `RUNNER_TEMP` directory
- A new per-test unique directory underneath `RUNNER_TEMP`
- No argument, code path or Tauri command to choose production files,
  localhost ports, registry settings, user HOME, OAuth, or a PID

Windows CI executes the suite with:

```text
C2C_F4C_E2E=true
cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib cutover_transaction_fixture -- --nocapture
```

The fixture uses synthetic in-memory writer flags and a static noncredential
byte string. It does not claim that synthetic process ownership protects an
actual Windows PID; real process ownership remains blocked in F4-B.

## Modeled durable checkpoints

```text
PREFLIGHT_OK -> STAGED -> QUIESCE_REQUESTED -> LEGACY_STOPPED
 -> TARGET_STARTING -> PROBING -> COMMITTED
\-> ROLLBACK -> ROLLED_BACK
```

- A new uniquely named directory is allocated for each case. A `create_new`
  lock refuses concurrent or stale ownership and is never force-removed to
  make an unknown process fit.
- The journal records fixed schema/phase/sequence only. No credential,
  secret, hash, hostname, absolute path or process command is serialized.
- Every checkpoint is create-new, append-only and `sync_all` flushed.
  The reader checks exact sequence, size bounds, parseability, version,
  and legal transitions. An interrupted/truncated/forged checkpoint enters
  **manual recovery** instead of skipping over damaged evidence.
- Every modeled transition can inject failure. Rollback revokes the synthetic
  target writer before re-enabling the synthetic legacy writer.
- A missing ownership flag refuses mutation; a repeated commit attempt
  cannot re-enter an existing journal. No synthetic case has two active
  writers.
- Existing source fixture bytes are never changed.

## Still required for F4-C (real architecture)

- A Windows native production-suitable journal, atomic storage/ACLs, file and
  directory reparse-point defenses, durable crash recovery and journal locking
- Verified WinForms and Tauri process/listener *real* identities and public
  issuer continuity with no blind PID signals
- Privately staged DPAPI backup validation with no concurrent OAuth writer
  and safe atomic Windows state handover/rollback
- Real independently controlled disposable CLI lifecycles with failure
  injection and authenticated MCP probe (F3 only tested a static synthetic
  restore separately)
- User-approved Windows manual acceptance (F4-D), recovery instructions,
  feature parity, and a distinctly reviewed production opt-in action (F4-E)

Until all those gates are implemented, `canTransitionNow` must remain
`false`. The connected WinForms v0.3.1 default instance on 7979 is not
modified by this work.

References:
- [F4 release contract](TAURI_PRODUCTION_CUTOVER_ROLLBACK_GATE.md)
- [F4-B dry-run](TAURI_READONLY_CUTOVER_DRY_RUN.md)
- [F3 synthetic credential E2E](TAURI_DISPOSABLE_CLI_RESTORE_E2E.md)
