import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardRuntime } from '../src/runtime.ts';
import { Store } from '../src/store.ts';
import { configureTopology, taskSessionKey } from '../src/topology.ts';

const MINUTE = 60_000;
const route = (c, target = c) => ({
  conversationRef: `conv_${c.repeat(32)}`,
  channel: 'fake',
  accountId: 'default',
  target,
  kind: 'direct',
});
const group = { ...route('a', 'original'), kind: 'group' };
const owner = route('b', 'owner');
const rebound = route('c', 'new');
const caller = (role, session = role) => ({ role, session, task: null, source: null });
const gate = () => {
  let enter, release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  return { enter, release, entered, waiting };
};

// Every external effect is fake; RPC also asserts that SQLite never spans an await.
function fixture(t, { path = ':memory:' } = {}) {
  configureTopology({
    productAgentId: 'product',
    engineeringAgentId: 'engineering',
    workerAgentId: 'worker',
  });
  let now = 1_000_000_000;
  const store = new Store(path, { now: () => now });
  t.after(() => store.close());
  store.run(
    'INSERT INTO projects(id,name,route,created,updated) VALUES(?,?,?,?,?)',
    'p',
    'Original',
    JSON.stringify(group),
    now,
    now,
  );
  const native = {
    calls: [],
    sessions: [],
    sends: [],
    files: [],
    transcripts: [],
    logs: [],
    hook: null,
  };
  const session = (key, extra = {}) => {
    let row = native.sessions.find((row) => row.key === key);
    if (!row) {
      row = { key, sessionId: key, hasActiveRun: false, updatedAt: now, ...extra };
      native.sessions.push(row);
    } else Object.assign(row, extra);
    return row;
  };
  const rpc = async (method, params) => {
    assert.equal(store.db.isTransaction, false, `${method} must be outside a transaction`);
    native.calls.push([method, params]);
    const next = () => {
      switch (method) {
        case 'sessions.list':
          return {
            sessions: native.sessions
              .filter(
                (row) =>
                  row.key.startsWith(`agent:${params.agentId}:`) &&
                  row.key.includes(params.search ?? ''),
              )
              .map((row) => ({ ...row })),
          };
        case 'sessions.create':
          session(params.key);
          return {};
        case 'sessions.patch':
          return {};
        case 'agent':
          session(params.sessionKey, { hasActiveRun: true, updatedAt: now });
          return { runId: 'accepted' };
        case 'sessions.abort':
          assert.equal(params.clearQueued, true);
          // An absent native row stays absent, rather than pretending abort confirmed it.
          if (native.sessions.some((row) => row.key === params.key))
            session(params.key, { hasActiveRun: false, hasActiveSubagentRun: false });
          return {};
        case 'conversations.list':
          return { conversations: [owner] };
        case 'conversations.send':
          native.sends.push(params);
          return { status: 'sent', messageId: 'sent' };
        case 'message.action':
          native.files.push(params);
          return { ok: true };
        default:
          assert.fail(`Unexpected fake RPC ${method}`);
      }
    };
    return native.hook ? native.hook(method, params, next) : next();
  };
  const runtime = new BoardRuntime(store, rpc, {
    now: () => now,
    ownerChat: { channel: 'fake', accountId: 'default', to: 'owner' },
    log: (line) => native.logs.push(line),
    appendTranscript: async (entry) => {
      native.transcripts.push(entry);
      return {};
    },
  });
  runtime.requestTick = () => {};
  const add = (role = 'engineering') =>
    runtime.addTask(caller('engineering'), { project: 'p', title: 'Work', holder: role }).task;
  const worker = (id, key = `agent:worker:${id}`) => {
    store.run(
      'UPDATE tasks SET workers=? WHERE id=?',
      JSON.stringify([{ key, at: now - 3 * MINUTE }]),
      id,
    );
    session(key);
    return key;
  };
  return {
    store,
    runtime,
    native,
    session,
    add,
    worker,
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

const count = (h, method) => h.native.calls.filter(([m]) => m === method).length;
// Holds the first native read of `key` until released.
const holdRead = (h, key) => {
  const g = gate();
  let held = false;
  h.native.hook = async (method, params, next) => {
    if (!held && method === 'sessions.list' && params.search === key) {
      held = true;
      g.enter();
      await g.waiting;
    }
    return next();
  };
  return g;
};

test('a cancellation made while a completion checks the workers wins', async (t) => {
  const h = fixture(t);
  const id = h.add();
  const g = holdRead(h, h.worker(id));
  const done = h.runtime.updateTask(caller('product', 'earlier'), {
    task: id,
    status: 'done',
    note: 'Accepted',
    message: 'Completed',
  });
  const rejected = assert.rejects(done, /changed.*while its workers were checked.*show/);
  await g.entered;
  await h.runtime.updateTask(caller('product'), { task: id, status: 'cancelled', note: 'Stop' });
  const latest = h.store.task(id);
  g.release();
  await rejected;
  assert.deepEqual(h.store.task(id), latest);
  assert(!h.store.notes(id).some((note) => note.text === 'Accepted'));
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outbox').n, 0);
});

test('a worker recorded while a completion checks the workers stops the completion', async (t) => {
  const h = fixture(t);
  const id = h.add();
  const g = holdRead(h, h.worker(id));
  const done = h.runtime.updateTask(caller('product'), { task: id, status: 'done', note: 'Ok' });
  const rejected = assert.rejects(done, /changed.*while its workers were checked/);
  await g.entered;
  h.runtime.recordWorker(taskSessionKey('engineering', h.store.task(id)), 'agent:worker:late');
  g.release();
  await rejected;
  assert.equal(h.store.task(id).status, 'open');
});

test('the scan’s own bookkeeping during the worker check does not reject a completion', async (t) => {
  const h = fixture(t);
  const id = h.add();
  const g = holdRead(h, h.worker(id));
  const done = h.runtime.updateTask(caller('product'), { task: id, status: 'done', note: 'Ok' });
  await g.entered;
  h.store.run(
    'UPDATE tasks SET woken=?,check_at=?,idle_wakes=1,poked=NULL WHERE id=?',
    h.now(),
    h.now() + MINUTE,
    id,
  );
  g.release();
  assert.equal((await done).status, 'done');
});

test('stopping a cancelled task’s workers is retried until they stop, then never again', async (t) => {
  const h = fixture(t);
  const id = h.add();
  const w = h.worker(id);
  h.session(w, { hasActiveRun: true });
  h.native.hook = (method, params, next) => {
    if (method === 'sessions.abort') throw Error('abort offline');
    return next();
  };
  await h.runtime.updateTask(caller('product'), { task: id, status: 'cancelled', note: 'Stop' });
  assert.equal(count(h, 'sessions.abort'), 1);
  await h.runtime.tick();
  assert.equal(count(h, 'sessions.abort'), 1);
  h.advance(5 * MINUTE);
  h.native.hook = null;
  await h.runtime.tick();
  assert.equal(count(h, 'sessions.abort'), 2);
  assert.equal(h.session(w).hasActiveRun, false);
  // The next check confirms the stop; after that the task is never checked again.
  h.advance(5 * MINUTE);
  await h.runtime.tick();
  assert.equal(h.store.task(id).check_at, null);
  const reads = count(h, 'sessions.list');
  for (let i = 0; i < 3; i++) {
    h.advance(60 * MINUTE);
    await h.runtime.tick();
  }
  assert.equal(count(h, 'sessions.list'), reads);
  assert.equal(count(h, 'sessions.abort'), 2);
});

test('a cancelled task’s worker whose session is gone counts as stopped', async (t) => {
  const h = fixture(t);
  const id = h.add();
  const w = h.worker(id);
  h.native.sessions = h.native.sessions.filter((row) => row.key !== w);
  await h.runtime.updateTask(caller('product'), { task: id, status: 'cancelled', note: 'Stop' });
  assert.equal(count(h, 'sessions.abort'), 0);
  assert.equal(h.store.task(id).check_at, null);
});

test('an unreadable worker state is retried, a few tasks per scan', async (t) => {
  const h = fixture(t);
  const ids = [];
  for (let i = 0; i < 12; i++) {
    const id = h.add();
    ids.push(id);
    h.worker(id);
  }
  h.native.hook = (method, params, next) => {
    if (method === 'sessions.list') throw Error('offline');
    return next();
  };
  for (const id of ids)
    await h.runtime.updateTask(caller('product'), { task: id, status: 'cancelled', note: 'Stop' });
  h.advance(5 * MINUTE);
  const reads = count(h, 'sessions.list');
  await h.runtime.tick();
  assert.equal(count(h, 'sessions.list') - reads, 10);
  await h.runtime.tick();
  assert.equal(count(h, 'sessions.list') - reads, 12);
  h.native.hook = null;
  h.advance(5 * MINUTE);
  await h.runtime.tick();
  h.advance(5 * MINUTE);
  await h.runtime.tick();
  assert(ids.every((id) => h.store.task(id).check_at === null));
});

test('a worker recorded after its task was cancelled is stopped by the next scan', async (t) => {
  const h = fixture(t);
  const id = h.add();
  const key = taskSessionKey('engineering', h.store.task(id));
  await h.runtime.updateTask(caller('product'), { task: id, status: 'cancelled', note: 'Stop' });
  const w = 'agent:worker:late';
  h.session(w, { hasActiveRun: true });
  h.runtime.recordWorker(key, w);
  await h.runtime.tick();
  assert.equal(count(h, 'sessions.abort'), 1);
  assert.equal(h.session(w).hasActiveRun, false);
  h.advance(5 * MINUTE);
  await h.runtime.tick();
  assert.equal(h.store.task(id).check_at, null);
});

test('reopening a task while its workers are being stopped prevents the stop', async (t) => {
  const h = fixture(t);
  const id = h.add();
  const w = h.worker(id);
  h.store.run("UPDATE tasks SET status='cancelled',holder=NULL,check_at=? WHERE id=?", h.now(), id);
  h.session(w, { hasActiveRun: true });
  const g = holdRead(h, w);
  const scan = h.runtime.tick();
  await g.entered;
  await h.runtime.updateTask(caller('product'), { task: id, status: 'open', note: 'Resume' });
  g.release();
  await scan;
  assert.equal(count(h, 'sessions.abort'), 0);
  assert.equal(h.store.task(id).status, 'open');
});

for (const poked of [false, true]) {
  test(`failed ${poked ? 'poked' : 'scheduled'} wakes retain inactivity and retry at five-minute cadence`, async (t) => {
    const h = fixture(t);
    const id = h.add();
    h.store.run(
      'UPDATE tasks SET poked=?,check_at=?,idle_wakes=2 WHERE id=?',
      poked ? h.now() : null,
      h.now(),
      id,
    );
    h.native.hook = (method, params, next) => {
      if (method === 'agent') throw Error('dispatch offline');
      return next();
    };
    for (let i = 0; i < 5; i++) {
      await h.runtime.tick();
      assert.match(h.runtime.health.lastError, /dispatch offline/);
      assert.equal(h.store.task(id).idle_wakes, 2);
      assert.equal(h.store.task(id).poked, poked ? 1_000_000_000 : null);
      assert.equal(h.store.task(id).stalled, null);
      const tries = h.native.calls.filter(([m]) => m === 'agent').length;
      h.advance(MINUTE);
      await h.runtime.tick();
      assert.equal(h.native.calls.filter(([m]) => m === 'agent').length, tries);
      h.advance(4 * MINUTE);
    }
    h.native.hook = null;
    assert.deepEqual((await h.runtime.tick()).woken, [id]);
    assert.equal(h.store.task(id).idle_wakes, 3);
    assert.equal(h.store.task(id).poked, null);
    h.session(taskSessionKey('engineering', h.store.task(id)), { hasActiveRun: false });
    h.runtime.wakes.clear();
    h.advance(60 * MINUTE);
    assert.deepEqual((await h.runtime.tick()).stalled, [id]);
  });
}

test('ambiguous dispatch confirmed live counts once and does not dispatch again mid-turn', async (t) => {
  const h = fixture(t);
  const id = h.add();
  h.store.run('UPDATE tasks SET check_at=? WHERE id=?', h.now(), id);
  h.native.hook = (method, params, next) => {
    const result = next();
    if (method === 'agent') throw Error('lost acknowledgement');
    return result;
  };
  assert.deepEqual((await h.runtime.tick()).woken, [id]);
  assert.equal(h.store.task(id).idle_wakes, 1);
  h.advance(61 * MINUTE);
  await h.runtime.tick();
  assert.equal(h.native.calls.filter(([m]) => m === 'agent').length, 1);
});

test('changed tasks during native wake preparation are neither dispatched nor stalled', async (t) => {
  const h = fixture(t);
  const id = h.add();
  const w = h.worker(id);
  h.store.run('UPDATE tasks SET check_at=?,idle_wakes=3 WHERE id=?', h.now(), id);
  const g = gate();
  h.native.hook = async (method, params, next) => {
    if (method === 'sessions.list' && params.search === w) {
      g.enter();
      await g.waiting;
    }
    return next();
  };
  const scan = h.runtime.tick();
  await g.entered;
  await h.runtime.updateTask(caller('product'), { task: id, note: 'Fresh information' });
  const latest = h.store.task(id);
  g.release();
  await scan;
  assert.deepEqual(h.store.task(id), latest);
  assert.equal(h.native.calls.filter(([m]) => m === 'agent').length, 0);
  assert.equal(h.native.sends.length, 0);
});

for (const outcome of ['accepted', 'lost acknowledgement'])
  test(`the holder acting during a wake dispatch keeps its own check-in (${outcome})`, async (t) => {
    const h = fixture(t);
    const id = h.add();
    h.store.run('UPDATE tasks SET poked=?,check_at=? WHERE id=?', h.now(), h.now(), id);
    const g = gate();
    h.native.hook = async (method, params, next) => {
      if (method !== 'agent') return next();
      g.enter();
      await g.waiting;
      const result = next();
      if (outcome !== 'accepted') throw Error('response lost');
      return result;
    };
    const scan = h.runtime.tick();
    await g.entered;
    await h.runtime.updateTask(caller('engineering'), {
      task: id,
      note: 'On it',
      check_in_minutes: 17,
    });
    g.release();
    assert.deepEqual((await scan).woken, [id]);
    const row = h.store.task(id);
    assert.deepEqual([row.check_at, row.poked, row.idle_wakes], [h.now() + 17 * MINUTE, null, 0]);
  });

test('another manager’s note during a wake dispatch wakes the holder again after the turn', async (t) => {
  const h = fixture(t);
  const id = h.add();
  h.store.run('UPDATE tasks SET check_at=? WHERE id=?', h.now(), id);
  const g = gate();
  h.native.hook = async (method, params, next) => {
    if (method === 'agent' && count(h, 'agent') === 1) {
      g.enter();
      await g.waiting;
    }
    return next();
  };
  const scan = h.runtime.tick();
  await g.entered;
  await h.runtime.updateTask(caller('product'), { task: id, note: 'Also check X' });
  g.release();
  await scan;
  assert.notEqual(h.store.task(id).poked, null);
  h.session(taskSessionKey('engineering', h.store.task(id)), { hasActiveRun: false });
  h.runtime.wakes.clear();
  assert.deepEqual((await h.runtime.tick()).woken, [id]);
  assert.match(h.native.calls.filter(([m]) => m === 'agent').at(-1)[1].message, /Also check X/);
});

const attachment = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jg-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'plan.png');
  writeFileSync(path, 'png');
  return path;
};

test('delivered text never falls back; its files are retried in the same chat', async (t) => {
  const h = fixture(t);
  let fail = true;
  h.native.hook = (method, params, next) => {
    if (method === 'message.action' && fail) throw Error('upload failed');
    return next();
  };
  const id = h.store.enqueue('p', null, 'With file', [attachment(t)]);
  const first = await h.runtime.deliver(id);
  assert.equal(first.state, 'sent');
  assert.match(first.error, /Attachments not delivered yet, retrying: upload failed/);
  for (let i = 0; i < 4; i++) {
    h.advance(60 * MINUTE);
    await h.runtime.tick();
  }
  assert.equal(h.native.sends.length, 1);
  assert.equal(h.store.get('SELECT fallback FROM outbox WHERE id=?', id).fallback, 0);
  fail = false;
  h.advance(60 * MINUTE);
  await h.runtime.tick();
  assert.equal(h.native.sends.length, 1);
  assert.deepEqual(
    h.native.files.map((file) => file.params.to),
    [group.target],
  );
  assert.deepEqual(
    { ...h.store.get('SELECT state,error FROM outbox WHERE id=?', id) },
    {
      state: 'handed',
      error: null,
    },
  );
});

test('files that never get through leave the delivered text delivered, with the error', async (t) => {
  const h = fixture(t);
  h.native.hook = (method, params, next) => {
    if (method === 'message.action') throw Error('upload failed');
    return next();
  };
  const id = h.store.enqueue('p', null, 'With file', [attachment(t)]);
  await h.runtime.deliver(id);
  for (let i = 0; i < 12; i++) {
    h.advance(60 * MINUTE);
    await h.runtime.tick();
  }
  const row = h.store.get('SELECT state,error,fallback FROM outbox WHERE id=?', id);
  assert.equal(row.state, 'handed');
  assert.match(row.error, /Attachments not delivered: upload failed/);
  assert.equal(row.fallback, 0);
  assert.equal(h.native.sends.length, 1);
  assert(h.native.logs.some((line) => /attachments not delivered/.test(line)));
});

test('two deliveries of one message at once send it once', async (t) => {
  const h = fixture(t);
  const id = h.store.enqueue('p', null, 'Once');
  const [a, b] = await Promise.all([h.runtime.deliver(id), h.runtime.deliver(id)]);
  assert.equal(h.native.sends.length, 1);
  assert.deepEqual(a, b);
});

test('foreign schema-zero databases are refused read-only and rejected handles close', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jg-admission-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const version of [0, 99]) {
    const path = join(dir, `foreign-${version}.sqlite`);
    const db = new DatabaseSync(path);
    db.exec(
      `CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('keep'); PRAGMA user_version=${version}`,
    );
    db.close();
    chmodSync(path, 0o640);
    const bytes = readFileSync(path);
    let closed = 0;
    const close = DatabaseSync.prototype.close;
    DatabaseSync.prototype.close = function () {
      closed++;
      return close.call(this);
    };
    try {
      assert.throws(() => new Store(path), /not a project board/);
    } finally {
      DatabaseSync.prototype.close = close;
    }
    assert.equal(closed, 1);
    assert.deepEqual(readFileSync(path), bytes);
    assert.equal(statSync(path).mode & 0o777, 0o640);
    assert.equal(existsSync(`${path}-wal`), false);
    assert.equal(existsSync(`${path}-shm`), false);
    const inspect = new DatabaseSync(path);
    assert.equal(inspect.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.equal(inspect.prepare('PRAGMA user_version').get().user_version, version);
    assert.equal(inspect.prepare('SELECT value FROM unrelated').get().value, 'keep');
    assert.equal(
      inspect.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='tasks'").get().n,
      0,
    );
    inspect.close();
  }
  for (const existing of [false, true]) {
    const path = join(dir, `empty-${existing}.sqlite`);
    if (existing) new DatabaseSync(path).close();
    const store = new Store(path);
    assert.equal(store.get('PRAGMA user_version').user_version, 19);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    store.close();
  }
});
