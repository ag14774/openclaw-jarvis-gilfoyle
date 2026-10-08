import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCopy, verifyBoard } from '../scripts/board-backup.mjs';
import { Store } from '../src/store.ts';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jg-recovery-'));
  chmodSync(root, 0o700);
  const source = join(root, 'source.sqlite');
  const store = new Store(source);
  store.db.exec('PRAGMA wal_autocheckpoint=0');
  store.run("INSERT INTO projects(id,name,created,updated) VALUES('p','Private fixture',1,1)");
  store.run(
    "INSERT INTO tasks(project,title,created_by,created,updated) VALUES('p','Fixture','product',1,1)",
  );
  store.note(1, 'product', 'Private fixture note');
  store.enqueue('p', 1, 'Private fixture notification');
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, source, store };
}

test('backup includes committed WAL, excludes an uncommitted write, and verifies a separate private stage', async (t) => {
  const { root, source, store } = fixture(t);
  assert(statSync(source + '-wal').size > 0);
  const mainBefore = readFileSync(source);
  const walBefore = readFileSync(source + '-wal');
  store.db.exec('BEGIN IMMEDIATE');
  store.note(1, 'engineering', 'Uncommitted note');
  const snapshotDir = join(root, 'snapshot');
  const report = await createCopy('backup', source, snapshotDir);
  store.db.exec('ROLLBACK');
  const snapshot = join(snapshotDir, 'board.sqlite');
  assert.deepEqual(report.counts, { projects: 1, tasks: 1, notes: 1, outbox: 1 });
  assert.deepEqual(readFileSync(source), mainBefore);
  assert.deepEqual(readFileSync(source + '-wal'), walBefore);
  assert.equal(store.get('PRAGMA journal_mode').journal_mode, 'wal');
  assert.equal(store.get('SELECT count(*) AS n FROM notes').n, 1);
  const stageDir = join(root, 'stage');
  const staged = await createCopy('stage', snapshot, stageDir);
  assert.equal(staged.sha256, report.sha256);
  assert.deepEqual(verifyBoard(join(stageDir, 'board.sqlite')), verifyBoard(snapshot));
  assert.notEqual(statSync(snapshot).ino, statSync(join(stageDir, 'board.sqlite')).ino);
  for (const directory of [snapshotDir, stageDir]) {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(directory).sort(), ['board.sqlite', 'verification.json']);
    for (const name of readdirSync(directory))
      assert.equal(statSync(join(directory, name)).mode & 0o777, 0o600);
    const text = readFileSync(join(directory, 'verification.json'), 'utf8');
    assert(!text.includes('Private fixture'));
    assert.equal(JSON.parse(text).integrity, 'ok');
  }
  const db = new DatabaseSync(join(stageDir, 'board.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT text FROM notes').get().text, 'Private fixture note');
    assert.throws(() => db.exec('DELETE FROM notes'), /readonly/i);
  } finally {
    db.close();
  }
});

test('known directories, original file, hardlinks and symlink aliases are never overwritten', async (t) => {
  const { root, source } = fixture(t);
  const original = readFileSync(source);
  const known = join(root, 'known');
  mkdirSync(known, { mode: 0o700 });
  const marker = join(known, 'keep');
  writeFileSync(marker, 'known backup');
  const alias = join(root, 'alias');
  symlinkSync(known, alias);
  const dangling = join(root, 'dangling');
  symlinkSync(join(root, 'missing-target'), dangling);
  const hardlink = join(root, 'hardlink.sqlite');
  linkSync(source, hardlink);
  for (const destination of [known, alias, dangling, source, hardlink])
    await assert.rejects(createCopy('backup', source, destination), /EEXIST/);
  await assert.rejects(createCopy('backup', source, root), /private|EEXIST/);
  assert.equal(readFileSync(marker, 'utf8'), 'known backup');
  assert.deepEqual(readFileSync(source), original);
  const snapshotDir = join(root, 'snapshot');
  await createCopy('backup', source, snapshotDir);
  const snapshot = join(snapshotDir, 'board.sqlite');
  const bytes = readFileSync(snapshot);
  await assert.rejects(createCopy('stage', snapshot, snapshotDir), /EEXIST/);
  await assert.rejects(createCopy('stage', snapshot, source), /EEXIST/);
  assert.deepEqual(readFileSync(snapshot), bytes);
});

test('concurrent copies to one destination admit exactly one invocation', async (t) => {
  const { root, source } = fixture(t);
  const destination = join(root, 'collision');
  const results = await Promise.allSettled([
    createCopy('backup', source, destination),
    createCopy('backup', source, destination),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(verifyBoard(join(destination, 'board.sqlite')).counts.tasks, 1);
});

test('missing and symlink sources and nonprivate parents are refused without output', async (t) => {
  const { root, source } = fixture(t);
  const alias = join(root, 'source-alias');
  symlinkSync(source, alias);
  const output = join(root, 'refused');
  for (const input of [join(root, 'absent'), alias, ':memory:', root])
    await assert.rejects(createCopy('backup', input, output));
  const shared = join(root, 'shared');
  mkdirSync(shared);
  chmodSync(shared, 0o755);
  await assert.rejects(createCopy('backup', source, join(shared, 'refused')), /private/);
  assert(!existsSync(output));
  assert.deepEqual(readdirSync(shared), []);
});

test('schema-zero and malformed sources are refused read-only', async (t) => {
  const { root, source, store } = fixture(t);
  const foreign = join(root, 'foreign.sqlite');
  const db = new DatabaseSync(foreign);
  db.exec("CREATE TABLE unrelated(secret TEXT); INSERT INTO unrelated VALUES ('keep')");
  db.close();
  const malformed = join(root, 'malformed.sqlite');
  writeFileSync(malformed, 'not SQLite');
  store.db.exec('PRAGMA user_version=0');
  for (const input of [foreign, malformed, source]) {
    const before = readFileSync(input);
    await assert.rejects(createCopy('backup', input, join(root, 'refused')));
    assert.deepEqual(readFileSync(input), before);
    assert(!existsSync(join(root, 'refused')));
  }
  const check = new DatabaseSync(foreign, { readOnly: true });
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 0);
  assert.equal(check.prepare('SELECT secret FROM unrelated').get().secret, 'keep');
  check.close();
});

test('positive versions do not admit unrelated databases or views replacing base tables', async (t) => {
  const { root, source, store } = fixture(t);
  const foreign = join(root, 'foreign.sqlite');
  const db = new DatabaseSync(foreign);
  db.exec('PRAGMA user_version=99; CREATE TABLE unrelated(value BLOB)');
  db.close();
  store.db.exec('DROP TABLE outbox; CREATE VIEW outbox AS SELECT 1');
  for (const input of [foreign, source]) {
    const before = readFileSync(input);
    await assert.rejects(createCopy('backup', input, join(root, 'refused')), /base board tables/);
    assert.deepEqual(readFileSync(input), before);
  }
  assert(!existsSync(join(root, 'refused')));
});

for (const version of [17, 23])
  test(`schema ${version} archives changed columns and unknown data and objects without interpretation`, async (t) => {
    const { root, source, store } = fixture(t);
    store.db.exec(
      version === 17
        ? 'ALTER TABLE tasks DROP COLUMN plan; ALTER TABLE outbox DROP COLUMN recorded'
        : "ALTER TABLE tasks ADD COLUMN future BLOB; UPDATE tasks SET future=x'00ff80'; ALTER TABLE outbox RENAME COLUMN recorded TO future_recorded",
    );
    store.db.exec(`
    PRAGMA user_version=${version};
    CREATE TABLE "odd"" name; --"(id INTEGER PRIMARY KEY, payload BLOB);
    INSERT INTO "odd"" name; --" VALUES(1,x'00ff804142');
    CREATE TABLE "__proto__"(value TEXT);
    INSERT INTO "__proto__" VALUES('unknown');
    CREATE TABLE "constructor"(value TEXT);
    CREATE TABLE sqliteXextra(value TEXT);
    CREATE INDEX "unknown index" ON "odd"" name; --"(hex(payload)) WHERE id > 0;
    CREATE VIEW "unknown view" AS SELECT hex(payload) AS value FROM "odd"" name; --";
    CREATE TRIGGER "unknown trigger" AFTER INSERT ON "odd"" name; --"
      BEGIN INSERT INTO "constructor" VALUES(hex(new.payload)); END;
  `);
    const schema = store.all('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name');
    const snapshot = join(root, 'copy', 'board.sqlite');
    const report = await createCopy('backup', source, join(root, 'copy'));
    assert.equal(report.schema, version);
    assert.equal(report.counts['odd" name; --'], 1);
    assert.equal(report.counts.__proto__, 1);
    assert.equal(report.counts.constructor, 0);
    assert.equal(report.counts.sqliteXextra, 0);
    assert.equal(Object.keys(report.counts).length, 8);
    const serialized = JSON.parse(readFileSync(join(root, 'copy', 'verification.json'), 'utf8'));
    assert.deepEqual(serialized.counts, report.counts);
    const before = readFileSync(snapshot);
    const staged = await createCopy('stage', snapshot, join(root, 'stage'));
    assert.equal(staged.sha256, report.sha256);
    assert.deepEqual(readFileSync(snapshot), before);
    assert.deepEqual(readFileSync(join(root, 'stage', 'board.sqlite')), before);
    for (const path of [snapshot, join(root, 'stage', 'board.sqlite')]) {
      const db = new DatabaseSync(path);
      try {
        assert.deepEqual(
          db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all(),
          schema,
        );
        assert.equal(db.prepare('SELECT value FROM "unknown view"').get().value, '00FF804142');
        assert.deepEqual(
          db.prepare('SELECT payload FROM "odd"" name; --"').get().payload,
          new Uint8Array([0, 255, 128, 65, 66]),
        );
        if (version === 23)
          assert.equal(db.prepare('SELECT hex(future) AS value FROM tasks').get().value, '00FF80');
        db.exec('INSERT INTO "odd"" name; --" VALUES(2,x\'abcd\')');
        assert.equal(db.prepare('SELECT value FROM "constructor"').get().value, 'ABCD');
      } finally {
        db.close();
      }
    }
  });

test('checks requiring a custom SQLite function are refused without skipping verification', async (t) => {
  const { root, source, store } = fixture(t);
  store.db.function('private_check', { deterministic: true }, (value) =>
    value === 'keep' ? 1 : 0,
  );
  store.db.exec(
    "CREATE TABLE custom(value TEXT); INSERT INTO custom VALUES('keep'); CREATE INDEX custom_index ON custom(private_check(value))",
  );
  const main = readFileSync(source);
  const wal = readFileSync(source + '-wal');
  assert.throws(() => verifyBoard(source), /private_check|unsafe|function/i);
  await assert.rejects(
    createCopy('backup', source, join(root, 'refused')),
    /private_check|unsafe|function/i,
  );
  assert(!existsSync(join(root, 'refused')));
  assert.deepEqual(readFileSync(source), main);
  assert.deepEqual(readFileSync(source + '-wal'), wal);
});

test('foreign-key damage is refused despite intact SQLite pages', async (t) => {
  const { root, source, store } = fixture(t);
  store.db.exec('PRAGMA foreign_keys=OFF');
  store.run('UPDATE notes SET task=999');
  assert.equal(store.get('PRAGMA integrity_check').integrity_check, 'ok');
  await assert.rejects(createCopy('backup', source, join(root, 'refused')), /Foreign key/);
  assert(!existsSync(join(root, 'refused')));
});

test('page corruption in a previously verified snapshot is refused', async (t) => {
  const { root, source } = fixture(t);
  const destination = join(root, 'snapshot');
  await createCopy('backup', source, destination);
  const snapshot = join(destination, 'board.sqlite');
  const db = new DatabaseSync(snapshot, { readOnly: true });
  const pageSize = db.prepare('PRAGMA page_size').get().page_size;
  const rootPage = db
    .prepare("SELECT rootpage FROM sqlite_schema WHERE name='notes'")
    .get().rootpage;
  db.close();
  const damaged = readFileSync(snapshot);
  damaged[(rootPage - 1) * pageSize] = 0; // Invalid b-tree page kind, intact SQLite header/schema.
  writeFileSync(snapshot, damaged);
  assert.throws(() => verifyBoard(snapshot), /integrity|malformed|corrupt/i);
  await assert.rejects(createCopy('stage', snapshot, join(root, 'refused')));
  assert(!existsSync(join(root, 'refused')));
  assert.deepEqual(readFileSync(snapshot), damaged);
});

test('staging refuses WAL sources and sidecars rather than losing committed data', async (t) => {
  const { root, source } = fixture(t);
  await assert.rejects(createCopy('stage', source, join(root, 'refused')), /standalone/);
  const snapshotDir = join(root, 'snapshot');
  await createCopy('backup', source, snapshotDir);
  const snapshot = join(snapshotDir, 'board.sqlite');
  writeFileSync(snapshot + '-wal', 'sidecar');
  await assert.rejects(createCopy('stage', snapshot, join(root, 'refused')), /sidecars/);
  assert(!existsSync(join(root, 'refused')));
});

test('CLI validates arguments and verifies without gateway or runtime imports', async (t) => {
  const { root, source } = fixture(t);
  const utility = join(root, 'board-backup.mjs');
  copyFileSync(fileURLToPath(new URL('../scripts/board-backup.mjs', import.meta.url)), utility);
  for (const args of [[], ['restore', source], ['verify', source, source], ['backup', source]]) {
    const result = spawnSync(process.execPath, [utility, ...args], {
      encoding: 'utf8',
      cwd: root,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
  const destination = join(root, 'cli-snapshot');
  const result = spawnSync(process.execPath, [utility, 'backup', source, destination], {
    encoding: 'utf8',
    cwd: root,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).counts.notes, 1);
  const verify = spawnSync(
    process.execPath,
    [utility, 'verify', join(destination, 'board.sqlite')],
    { encoding: 'utf8', cwd: root },
  );
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(JSON.parse(verify.stdout).schema, 19);
});
