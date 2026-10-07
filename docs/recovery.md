# Board backup and staged recovery

[Back to README](../README.md)

The board is the plugin's project record. Native sessions own execution liveness;
Git owns code and worktrees; native receipts own delivery. Backing up the board
does not back up those systems. Never automatically restore an old board.

## Create a consistent snapshot

Use Node with `node:sqlite` and its `backup` API (the repository's supported Node
range; tested on **26.8.1**). The utility is self-contained and shipped in the
package; it needs neither a build nor OpenClaw dependencies. Supply your own
paths, taken from the intended plugin configuration's `statePath`. There is no
default source, automatic discovery, gateway call, service or configuration change.

The destination is a **new directory**, not a database filename. Its existing
parent must be private (no group/world permission bits) and owned by you. Keep it
outside your checkout and any public/shared/synced artifact directory. For example,
after creating a private parent directory of your choice:

```bash
node scripts/board-backup.mjs backup "$BOARD_FILE" "$PRIVATE_PARENT/snapshot-001"
node scripts/board-backup.mjs verify "$PRIVATE_PARENT/snapshot-001/board.sqlite"
```

Define `BOARD_FILE` and `PRIVATE_PARENT` explicitly before running these examples.
The command creates `board.sqlite` and `verification.json` in the new directory.
The directory is mode `0700`; both files are `0600`. Existing destinations,
including symlinks, are refused, with no overwrite flag. The source must be an
existing regular file, not a symlink, and is opened read-only. Missing, foreign,
incompatible or invalid sources are refused; this utility never initializes or
migrates a board.

Node's SQLite backup API includes committed WAL content in a SQLite-consistent
snapshot. Do **not** copy just a running board's main file, delete its sidecars,
or checkpoint/change journal mode on the source to make a backup. The utility
changes journal mode to `DELETE` only on its new private copy, then verifies it
read-only. Its report records time, schema, table counts and SHA-256 without note
or message contents. Output is sensitive even without row text; keep terminal
logs private too. The source admission check and backup are separate observations:
counts in the report describe the verified snapshot, not a promise that the live
board stopped changing. A concurrent schema change is unsupported and may cause
refusal. Read-only SQLite access may need/read/update native WAL shared-memory
coordination files; this is not a forensic zero-filesystem-write guarantee.

## Verify a separate staged restore

Use the **snapshot**, never the running board, as input:

```bash
node scripts/board-backup.mjs stage "$PRIVATE_PARENT/snapshot-001/board.sqlite" "$PRIVATE_PARENT/restore-drill-001"
node scripts/board-backup.mjs verify "$PRIVATE_PARENT/restore-drill-001/board.sqlite"
```

Staging requires a standalone `DELETE`-journal snapshot with no WAL, SHM or journal
sidecars. It makes an exclusive byte copy into another new private directory,
compares SHA-256 before/after copying, opens the staged database read-only and
repeats verification. The staged report's counts/checks must match the snapshot.
Compare its hash to the backup report as well if checking later storage/transfer
corruption; the utility does not automatically trust or authenticate a historical
report. Failed copy/verification removes only the directory created by this
invocation; an interruption can leave a partial directory. Treat that as incomplete
and use a fresh destination. Existing paths are never cleaned up by the command.

Checks are `PRAGMA integrity_check` (all results must be `ok`), schema version
**18**, the four expected tables and exact column names/types, absence of extra
tables/views/triggers, and `PRAGMA foreign_key_check`. The utility does not import
the runtime Store, so verification cannot silently execute board DDL. These are
structural checks, not authentication, a full comparison of every constraint or
index definition, or validation of free-text/JSON/agent judgments. Future schemas
require a separately reviewed utility update, not bypassing the check.

## Decide whether to recover production separately

Successful staging establishes that this SQLite snapshot can be copied and read.
It does **not** authorize replacement or establish application-level correctness.
Before any separately approved live recovery:

1. Preserve and verify a fresh snapshot of the current board. Retain the original
   board and its SQLite sidecars together for rollback; never overwrite the sole
   evidence copy.
2. Inspect the staged records against current native worker/session evidence,
   surviving worktrees and native delivery receipts. Rewinding the board can
   revive old tasks/check-ins, pending messages or cleanup actions. Never assume
   old workers are stopped or old notifications are unsent.
3. Obtain approval for the selected snapshot and reconciliation of those effects.
   Quiesce all board writers and automatic scans before any operator-controlled
   replacement. Do not pair a restored main database with the previous board's
   WAL/SHM/journal files. Preserve permissions and keep an explicit rollback path.
4. A live startup, health/read checks and deliberate reconciliation are another
   authorized operation. A scan/tick can launch paid turns or send messages.
   No command here invokes a gateway, replaces a live board or starts the plugin.

Attachments are referenced by path, not embedded in SQLite. Native sessions,
transcripts, credentials, personas, channels, configuration, Git repositories and
worktrees need their own preservation strategy. This is neither full-host restore
nor off-host/disaster-recovery qualification. SQLite consistency is not globally
exactly-once execution/delivery. Use trusted local paths/filesystems and cooperative
host access: permission checks do not provide hostile-user race containment,
encryption, retention management or authenticated backups. Treat snapshots as
immutable while staging. Protect any off-host copies separately and never commit
boards, staged copies or reports to this repository.

Disposable-fixture regressions and command side effects are in
[TESTING.md](../TESTING.md#recovery-utility).
