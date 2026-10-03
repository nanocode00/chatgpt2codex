# On-demand ChatGPT file transfer (Issue #18)

C2C's file transfer tool accepts **original binary bytes**, one requested file at a time. A user may request several files in one chat message; the assistant independently transfers and reports each one. No automatic attachment watcher, continuous synchronization, or public file-sharing endpoint is provided.

## User workflow

1. The user identifies exact files from the current chat or their ChatGPT Library, the registered C2C target project, and optionally a project-relative destination.
2. The assistant obtains the **raw original bytes** from a supported file source (e.g. ChatGPT Library's raw-file materialization, if available), determines exact byte length and SHA-256, and acquires a C2C full-write lease for the selected project.
3. For each requested file, call `file_transfer` with `mode=begin`, `filename`, `sizeBytes`, `sha256`, and optional `destPath`; note the returned `transferId` and `chunkBytes` (256 KiB).
4. Send consecutive raw byte slices encoded in strict canonical Base64, each at most `chunkBytes`, using `mode=chunk`, `transferId`, and zero-based `index`. Each request acknowledges `receivedBytes` and `nextIndex`.
5. Call `mode=finish`. C2C verifies exact declared size and SHA-256 and atomically creates the destination without overwriting an existing different file. Report the final path, bytes, SHA-256, and any per-file error. Use `mode=abort` if cancelling.
6. Repeat for the other selected files. A failure of one file does not roll back completed, independently verified files.

Unless `destPath` is specified, files go to `.chatgpt2codex/imports/<sanitized-basename>`. Explicit destinations are relative to the selected registered project. All operations require a full-write project lease. No executable content is run. Files are limited to 20 MiB each, and a process accepts at most eight simultaneous transfers.

The HTTP Action equivalent is `/actions/file-transfer`; it uses the same tool contract and explicitly requires the same write authorization. The MCP and Action tool registrations share in-process transfer state across requests. After a server restart, any unfinished transfers must be restarted from `begin`.

## Security and data integrity

- An unpredictable UUIDv4 transfer ID and the selected project identify each upload; every operation independently requires an authorized full-write lease. Separate authenticated MCP sessions may continue a transfer only when they know its transfer ID (treat the ID as a short-lived upload secret).
- Declared size and SHA-256 are required *before* accepting chunks; chunk indexes must be sequential. Invalid Base64, missing/duplicate/out-of-order chunks, truncated data, oversize transfers, path escapes, symlinks, secret-classified paths, and non-identical existing destinations are rejected.
- Staging is in the project's `.chatgpt2codex/imports/.staging`; `finish` places the file via a non-overwriting hard link on the same filesystem. `abort`, failed integrity checks, and normal finalization delete temporary staged data. Inactive in-process transfers expire after 30 minutes when transfer operations are next invoked.
- No raw Base64 payload is intentionally included in completion audit records or file-transfer error logs. Do not put private file contents or credentials into transfer metadata or Git commits.

## Public-source direct import without model Base64

If the user explicitly selects a file and there is a byte-identical PUBLIC HTTPS source, use file_transfer mode=from_url with projectId, filename, url, sizeBytes, sha256, and optional destPath. C2C downloads the original bytes directly, rejects unsafe URL schemes/addresses/redirects and private credentials, and matches the exact supplied length and SHA-256 before storing the file. Downloads are limited to 20 MiB.

For example, the user's Library copy of seq2seq-asr-chiu-2018.pdf was confirmed identical to https://arxiv.org/pdf/1712.01769v6 (303358 bytes, SHA-256 687e651bc1461992d6548e48555aae85159c78e2be5d4835042f7facdf268629). The optional public-source verification script in scripts/verify_public_paper_sample.py also downloads and atomically stores this verified fixture in its current C2C test worktree. This demonstrates equivalence to a PUBLIC paper version, not access to the user's private Library through C2C. Actual from_url tool execution against a live server requires publishing this feature and restarting C2C.

## ChatGPT-side source and transport boundary

C2C cannot directly access ChatGPT's isolated `/mnt/data` paths or private attachment URLs. Library materialization can provide original bytes *inside ChatGPT's environment*, but that does not by itself copy the bytes into the user's C2C server. The assistant must have an actual supported byte-to-tool-call transport for the selected files. A manual Base64 relay is suitable only for small diagnostic fixtures; do not claim end-to-end transfer of a large user document based solely on receiving a parsed text excerpt or seeing a materialized path.

The initial feature implementation provides a secure **destination/receiver** and a concrete tool protocol. Production-quality one-request Library-to-C2C transfer of arbitrary large files also needs a supported client-side byte bridge; add it only after verifying its authorization and connectivity. Never publish a user's private files merely to work around the isolation boundary.

## Local verification

From this feature worktree with dependencies installed:

```sh
npm run typecheck
npm test
npm run build
```

The unit tests cover PDF/PNG multi-file intake, exact hashes and bytes, duplicate and missing chunks, failure isolation, destination collisions, path/symlink rejection, cross-session isolation, remote-write permissions, and continuation across separate MCP tool registrations.
