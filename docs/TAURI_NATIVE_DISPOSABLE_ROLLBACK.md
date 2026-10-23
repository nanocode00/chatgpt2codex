# F4-C1: Real disposable Windows CLI handover and rollback

Scope: **only** the opt-in `windows-latest` CI fixture. This is a follow-up
to the in-memory F4-C0 state-machine tests and the user-observed Windows
F4-B no-go Dry-run. It is **not** an installer or production transaction.

## Runtime isolation

`scripts/test-windows-f4-native-rollback.ps1` runs only when
`GITHUB_ACTIONS=true`, `CI=true`, `C2C_F4C1_E2E=true`, and Windows
`RUNNER_TEMP` exists as a real directory. The script creates a unique
temporary root, sets `HOME`, `USERPROFILE`, and `XDG_CONFIG_HOME`
to that sandbox, and confirms Node sees the disposable HOME before invoking
the repo-built CLI. It uses distinct ephemeral localhost ports (neither 7979
nor 18797), a private fixture workspace and two explicit fixture instance
names. No tunnel is started; public URLs or installed Windows launchers are
never read, and all runtime operations are delegated to the CLI's own
fail-closed PID ownership checks.

A new synthetic Owner Token verifier is generated entirely in the sandbox.
The output is never printed; its file SHA-256 is checked again after every
handover. The fixture does not migrate real Owner Token/OAuth credentials.

## Scenarios

1. Start and verify the real source CLI; stop the owned source; inject a
   target-not-started failure; roll back by restarting the source.
2. Stop source, start and verify the real target, inject a failure, then
   stop the owned target before restarting the source.
3. Complete an orderly source-to-target switchover, then explicitly switch
   back and prove the original owner-token verifier file was unchanged.

After *every* mutation, query both named instances to ensure they are not
simultaneously writing the shared temporary HOME, validate the localhost
`healthz` service identity, and refuse to stop any unknown process.
Regardless of the outcome, cleanup attempts to stop only verified disposable
instances and restore process environment variables. A failed cleanup fails
CI rather than claiming success.

## What this does not prove

- Production WinForms PID/port ownership or handover of default/7979.
- Transaction-safe copying of live OAuth credential files; no real OAuth
  registration is copied into the fixture.
- Crash-durable or atomic Windows state replacement, concurrent writers
  outside the two fixture names, machine restart recovery, public
  Cloudflare/OAuth issuer continuity, or a one-click rollback UI.
- That the F4-B check can return `canTransitionNow=true`: it must remain
  false until the distinct F4 release gates and manual acceptance are met.

The accompanying UI change uses a separate F4-B check layout:
one row for the check title + state, followed by full-width explanatory
text. This corrects the cramped, excessive-height status columns reported
during the real Windows preview review.

See [F4 release gate](TAURI_PRODUCTION_CUTOVER_ROLLBACK_GATE.md),
[F4-B dry-run](TAURI_READONLY_CUTOVER_DRY_RUN.md), and
[F4-C0 synthetic model](TAURI_DISPOSABLE_TRANSACTION_REHEARSAL.md).
