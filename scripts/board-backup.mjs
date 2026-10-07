// Operator-only: no plugin imports, gateway access, or live replacement.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

// Schema 18's structural admission check; deliberately independent of the mutating Store.
const columns = {
  projects: 'id:TEXT name:TEXT context:TEXT route:TEXT state:TEXT created:INTEGER updated:INTEGER',
  tasks:
    'id:INTEGER project:TEXT title:TEXT body:TEXT status:TEXT holder:TEXT created_by:TEXT workers:TEXT poked:INTEGER woken:INTEGER check_at:INTEGER idle_wakes:INTEGER stalled:INTEGER cleaned:INTEGER created:INTEGER updated:INTEGER',
  notes: 'id:INTEGER task:INTEGER author:TEXT text:TEXT created:INTEGER',
  outbox:
    'id:INTEGER project:TEXT task:INTEGER text:TEXT files:TEXT fallback:INTEGER state:TEXT attempts:INTEGER next_at:INTEGER error:TEXT receipt:TEXT recorded:INTEGER created:INTEGER',
};

function sourcePath(path) {
  assert(path && path !== ':memory:', 'Source must be an existing board file');
  const absolute = resolve(path);
  assert(lstatSync(absolute).isFile(), 'Source must be a regular file, not a symlink');
  return realpathSync(absolute);
}

function inspect(db) {
  assert.equal(
    db.prepare('PRAGMA user_version').get().user_version,
    18,
    'Expected board schema 18',
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND type IN ('table','view','trigger') ORDER BY name",
      )
      .all()
      .map((row) => row.name),
    Object.keys(columns).sort(),
    'Expected only the four board tables (no views or triggers)',
  );
  for (const [table, expected] of Object.entries(columns)) {
    assert.equal(
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => `${row.name}:${row.type}`)
        .join(' '),
      expected,
      `Unexpected ${table} columns`,
    );
  }
  assert.deepEqual(
    db
      .prepare('PRAGMA integrity_check')
      .all()
      .map((row) => row.integrity_check),
    ['ok'],
    'SQLite integrity check failed',
  );
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'Foreign key check failed');
  const counts = {};
  for (const table of Object.keys(columns))
    counts[table] = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  return { schema: 18, integrity: 'ok', foreignKeys: 'ok', counts };
}

function readOnly(path, fn) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
    return fn(db);
  } finally {
    db.close();
  }
}

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function verifyBoard(path) {
  return readOnly(sourcePath(path), inspect);
}

function standalone(path) {
  for (const suffix of ['-wal', '-shm', '-journal'])
    assert(!existsSync(path + suffix), 'Staging requires a standalone snapshot without sidecars');
  assert.equal(
    readOnly(path, (db) => db.prepare('PRAGMA journal_mode').get().journal_mode),
    'delete',
    'Staging requires a DELETE-journal snapshot; create a backup first',
  );
}

export async function createCopy(operation, source, destination) {
  assert(['backup', 'stage'].includes(operation), 'Expected backup or stage');
  const input = sourcePath(source);
  if (operation === 'stage') standalone(input);
  const verified = verifyBoard(input);
  const output = resolve(destination);
  const parent = statSync(realpathSync(dirname(output)));
  assert(parent.isDirectory(), 'Destination parent must be a directory');
  assert.equal(parent.mode & 0o077, 0, 'Destination parent must be private (mode 0700)');
  assert.equal(parent.uid, process.getuid(), 'Destination parent must be owned by the operator');
  // Exclusive directory creation refuses known paths, aliases, and simultaneous invocations.
  mkdirSync(output, { mode: 0o700 });
  const snapshot = join(output, 'board.sqlite');
  try {
    if (operation === 'backup') {
      closeSync(openSync(snapshot, 'wx', 0o600));
      const db = new DatabaseSync(input, { readOnly: true });
      try {
        await backup(db, snapshot);
      } finally {
        db.close();
      }
      // Only the newly created private copy is opened for a journal-mode change.
      const portable = new DatabaseSync(snapshot);
      try {
        portable.exec('PRAGMA journal_mode=DELETE');
      } finally {
        portable.close();
      }
    } else {
      const before = digest(input);
      copyFileSync(input, snapshot, constants.COPYFILE_EXCL);
      assert.equal(digest(snapshot), before, 'Staged bytes differ from snapshot');
      assert.equal(digest(input), before, 'Snapshot changed during staging');
    }
    chmodSync(snapshot, 0o600);
    standalone(snapshot);
    const restored = verifyBoard(snapshot);
    if (operation === 'stage') assert.deepEqual(restored, verified, 'Staged verification differs');
    const report = {
      operation,
      at: new Date().toISOString(),
      ...restored,
      sha256: digest(snapshot),
      scope:
        'Board SQLite copy only; no live replacement, native sessions, files, delivery, or full-host/off-host qualification',
    };
    writeFileSync(join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    return report;
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [operation, source, destination, ...extra] = process.argv.slice(2);
    assert(
      !extra.length &&
        source &&
        ((operation === 'verify' && !destination) ||
          (['backup', 'stage'].includes(operation) && destination)),
      'Usage: node scripts/board-backup.mjs verify SOURCE | backup SOURCE NEW_PRIVATE_DIRECTORY | stage SNAPSHOT NEW_PRIVATE_DIRECTORY',
    );
    const report =
      operation === 'verify'
        ? verifyBoard(source)
        : await createCopy(operation, source, destination);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(`Board recovery refused: ${error.message}`);
    process.exitCode = 1;
  }
}
