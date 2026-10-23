# F4-B: read-only production cutover readiness (no-go dry-run)

**Safety contract:** This command must never stop or restart WinForms, terminate a
PID, alter the Windows 7979/18797 listeners, copy restored credentials to a
production HOME, rotate Owner Token, change OAuth clients, change a public tunnel
or update ChatGPT registration. It is a bounded read-only inspection for Windows.

## Usage

In the Windows Tauri preview open **설정 → WinForms → Tauri 전환 준비 →
F4-B · 운영 전환 사전 점검 → 전환 준비 Dry-run 실행**.

The native `inspect_cutover_readiness` command returns an allowlisted set
of check IDs, statuses (`passed`, `blocked`, `unverified`) and fixed Korean
explanations. It does not serialize credential contents, hashes, raw OAuth
tokens or absolute filesystem paths. Browser-only preview does not run it.

| Check | Evidence | Interpretation |
|---|---|---|
| settings/project | Existing `inspect_paths` snapshot and project existence | Basic source inventory, not functional equivalence |
| Owner Token/OAuth | Format checks only | Neither authenticates a live token nor proves its validity |
| DPAPI archive | Fixed-path bounded archive decrypt/format/SHA validation | Current-user archive readable *at inspection time* |
| Backup freshness | Two read-only source reads vs saved entry SHA-256, optional project presence | Point-in-time match only, no exclusive writer lock |
| Existing localhost | Loopback-only `healthz` with C2C JSON identity | Service identity, **not** OS PID ownership |
| PID/process ownership | Unverified | Need independent process executable, argv, creation time and listener owner check |
| Public OAuth issuer | Unverified | Need stable origin, token validity/scope and real ChatGPT client validation |
| Production rollback | Blocked | No transaction journal, stop/switch/rollback engine |
| Feature parity | Unverified | Needs installer/tray/startup/setting acceptance |

**The returned `canTransitionNow` field is always `false` and
`dryRunOnly` is always `true`.** Even an all-green snapshot would not
permit cutover, because the journal/rollback transaction does not exist.
Do not interpret `passed` as authorization for a user-visible mutation.

## Failure cases and scope

- Missing/corrupt/symlink DPAPI archive: blocked.
- Changed source owner/OAuth/settings or selected project since backup:
  blocked; never overwrite or regenerate the archive on an inspection.
- Legacy port occupied by a different service: blocked.
- Legacy port not listening: unverified; not proof that it is safe to bind.
- Healthy localhost server: still no PID ownership or live OAuth proof.
- Source files may change between inspections. Two reads do not provide
  an atomic snapshot; the F4-C transaction must lock out concurrent writers.
- No real-user credentials or source data should ever be used for CI.

See [F4 contract](TAURI_PRODUCTION_CUTOVER_ROLLBACK_GATE.md) and the synthetic
credential E2E [F3](TAURI_DISPOSABLE_CLI_RESTORE_E2E.md). F4-C needs a distinct
disposable Windows transaction+rollback engine with fault-injection tests;
this PR explicitly does not contain it.
