# F4-C2: Disposable Windows file-state handover and interrupted recovery

**Test-only release gate.** This is not a production credential migrator,
installer feature, Windows profile recovery utility or live WinForms cutover.
The Rust module `cutover_file_fixture` is compiled only with
`#[cfg(all(test, windows))]` and its test bodies additionally require
`GITHUB_ACTIONS=true`, `CI=true`, `C2C_F4C2_E2E=true` and `RUNNER_TEMP`.

The tests create their own uniquely named directories beneath the Windows
GitHub-hosted runner's temporary directory. They never read the installed
WinForms state, default/7979, Windows profile or real OAuth data. All filenames
are fixed and the files contain visibly noncredential synthetic text.

## Windows filesystem behavior exercised

- Stage two synthetic files and sync both to disk before promoting them.
- Preserve an original fixture directory by renaming `live` to `rollback`
  on the same volume. Promote `stage` to `live` using a separate rename.
- Persist a bounded append-only JSON journal with strict schema, contiguous
  sequence, valid phase transitions and `sync_all` for every checkpoint.
- Check byte-level SHA-256 equivalence against hardcoded fixture bytes for
  both the original and target. Never overwrite unexpected files.
- Refuse symbolic links and Windows reparse points on inspected fixture
  directories/files; require ordinary, bounded files.
- Recover the preserved original after interruptions **after staging**, **just
  after the original directory rename**, **after recording that rename**,
  **just after target promotion**, and **after recording target promotion**.
- Simulate another interruption after quarantining a promoted target while a
  verified original is still in `rollback`. Rerun recovery idempotently.
- Corrupt the latest checkpoint, or change a retained original file: refuse
  to automatically recover and preserve forensic state.

The corresponding CI step runs:

```text
C2C_F4C2_E2E=true
cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib cutover_file_fixture -- --nocapture
```

## Important boundaries

Windows directory renames are **separate operations**, not an atomic
transaction for two directories. The checkpoint reader and file-state
inspections handle modeled pauses *between* these rename operations; a
power loss, antivirus lock, concurrent process or fsync failure in production
can introduce additional ambiguous states. The tests intentionally choose
safe manual recovery when checkpoint integrity or original file identity
cannot be established.

This test does **not** prove production ACLs, Windows registry/startup parity,
inter-process locks, quiescence of WinForms, stable public OAuth issuer, live
Owner Token continuity, concurrent OAuth writer exclusion, credential-bearing
file encryption or a real machine restart. Those are separate F4-C/F4-D/F4-E
release gates. **F4-B `canTransitionNow` remains `false`.**

See [F4-C0 synthetic journal](TAURI_DISPOSABLE_TRANSACTION_REHEARSAL.md),
[F4-C1 native CLI rehearsal](TAURI_NATIVE_DISPOSABLE_ROLLBACK.md),
and [F4 production cutover contract](TAURI_PRODUCTION_CUTOVER_ROLLBACK_GATE.md).
