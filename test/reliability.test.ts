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

for (const change of [
  'cancellation',
  'holder without note',
  'check-in without note',
  'note identity',
  'late worker',
]) {
  test(`completion revalidates ${change} at commit time across native await`, async (t) => {
    const h = fixture(t);
    const id = h.add();
    const w = h.worker(id);
    const g = gate();
    let blocked = false;
    h.native.hook = async (method, params, next) => {
      if (!blocked && method === 'sessions.list' && params.search === w) {
        blocked = true;
        g.enter();
        await g.waiting;
      }
      return next();
    };
    const earlier = h.runtime.updateTask(caller('product', 'earlier'), {
      task: id,
      status: 'done',
      note: 'Accepted',
      message: 'Completed',
    });
    // Attach the rejection handler before releasing the race.
    const rejected = assert.rejects(earlier, /changed while checking workers.*show/);
    await g.entered;
    if (change === 'cancellation')
      await h.runtime.updateTask(caller('product'), {
        task: id,
        status: 'cancelled',
        note: 'Stop',
      });
    if (change === 'holder without note')
      h.store.run("UPDATE tasks SET holder='product' WHERE id=?", id);
    if (change === 'check-in without note')
      await h.runtime.updateTask(caller('engineering', 'later'), { task: id, check_in_minutes: 7 });
    if (change === 'note identity') h.store.note(id, 'product', 'New information');
    if (change === 'late worker')
      h.runtime.recordWorker(taskSessionKey('engineering', h.store.task(id)), 'agent:worker:late');
    const latest = h.store.task(id);
    g.release();
    await rejected;
    assert.deepEqual(h.store.task(id), latest);
    assert(!h.store.notes(id).some((note) => note.text === 'Accepted'));
    assert.equal(h.store.get('SELECT COUNT(*) n FROM outbox').n, 0);
  });
}

test('cancelled-worker abort failure recovers from existing rows after restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jg-cancel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const h = fixture(t, { path: join(dir, 'board.sqlite') });
  const id = h.add();
  const w = h.worker(id);
  h.session(w, { hasActiveRun: true });
  h.native.hook = (method, params, next) => {
    if (method === 'sessions.abort') throw Error('abort offline');
    return next();
  };
  await h.runtime.updateTask(caller('product'), { task: id, status: 'cancelled', note: 'Stop' });
  assert.equal(h.native.calls.filter(([m]) => m === 'sessions.abort').length, 1);
  await h.runtime.tick();
  assert.equal(h.native.calls.filter(([m]) => m === 'sessions.abort').length, 1);
  h.advance(5 * MINUTE);
  h.native.hook = null;
  // A fresh runtime has no volatile stop obligations to recover.
  const reopened = new Store(join(dir, 'board.sqlite'), { now: h.now });
  t.after(() => reopened.close());
  const restarted = new BoardRuntime(reopened, h.runtime.rpc, { now: h.now });
  restarted.requestTick = () => {};
  await restarted.tick();
  assert.equal(h.native.calls.filter(([m]) => m === 'sessions.abort').length, 2);
  assert.equal(h.store.task(id).status, 'cancelled');
  assert.equal(h.store.task(id).cleaned, null);
  assert.equal(h.session(w).hasActiveRun, false);
  h.advance(5 * MINUTE);
  await restarted.tick();
  assert.equal(h.native.calls.filter(([m]) => m === 'sessions.abort').length, 2);
});

test('late spawn recording schedules cancellation retry; unknown native state stays unconfirmed', async (t) => {
  const h = fixture(t);
  const id = h.add();
  const key = taskSessionKey('engineering', h.store.task(id));
  await h.runtime.updateTask(caller('product'), { task: id, status: 'cancelled', note: 'Stop' });
  const w = 'agent:worker:late';
  h.runtime.recordWorker(key, w);
  await h.runtime.tick();
  assert.equal(h.native.calls.filter(([m]) => m === 'sessions.abort').length, 1);
  assert(h.native.logs.some((line) => /stop unconfirmed.*unknown/.test(line)));
  h.advance(5 * MINUTE);
  await h.runtime.tick();
  assert.equal(h.native.calls.filter(([m]) => m === 'sessions.abort').length, 2);
  h.session(w, { hasActiveRun: true, hasActiveSubagentRun: true });
  h.advance(5 * MINUTE);
  await h.runtime.tick();
  assert.equal(h.session(w).hasActiveRun, false);
  assert.equal(h.store.task(id).status, 'cancelled');
  assert.equal(h.store.task(id).cleaned, null);
});

test('cancelled reconciliation is bounded and fair despite persistent failures and cleaned history', async (t) => {
  const h = fixture(t);
  const ids = [];
  for (let i = 0; i < 25; i++) {
    const id = h.add();
    ids.push(id);
    h.worker(id);
    h.store.run(
      "UPDATE tasks SET status='cancelled',holder=NULL,check_at=NULL,cleaned=? WHERE id=?",
      h.now(),
      id,
    );
  }
  h.native.hook = (method, params, next) => {
    if (method === 'sessions.list' || method === 'sessions.abort') throw Error('offline');
    return next();
  };
  for (const count of [10, 20, 25]) {
    await h.runtime.tick();
    assert.equal(h.native.calls.filter(([m]) => m === 'sessions.abort').length, count);
  }
  assert.equal(
    new Set(h.native.calls.filter(([m]) => m === 'sessions.abort').map(([, p]) => p.key)).size,
    25,
  );
  assert(ids.every((id) => h.store.task(id).cleaned === h.now()));
  await h.runtime.tick();
  assert.equal(h.native.calls.filter(([m]) => m === 'sessions.abort').length, 25);
  h.advance(5 * MINUTE);
  await h.runtime.tick();
  assert.equal(h.native.calls.filter(([m]) => m === 'sessions.abort').length, 35);
});

test('reopening during cancellation inspection prevents a stale abort', async (t) => {
  const h = fixture(t);
  const id = h.add();
  const w = h.worker(id);
  h.store.run("UPDATE tasks SET status='cancelled',holder=NULL,check_at=NULL WHERE id=?", id);
  h.session(w, { hasActiveRun: true });
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
  await h.runtime.updateTask(caller('product'), { task: id, status: 'open', note: 'Resume' });
  g.release();
  await scan;
  assert.equal(h.native.calls.filter(([m]) => m === 'sessions.abort').length, 0);
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

for (const outcome of ['accepted', 'error', 'ambiguous live']) {
  for (const change of [
    'check-in',
    'same retry check-in',
    'handover',
    'cancellation',
    'note',
    'worker',
  ]) {
    test(`late wake ${outcome} preserves a new ${change} during dispatch`, async (t) => {
      const h = fixture(t);
      const id = h.add();
      h.store.run('UPDATE tasks SET poked=?,check_at=? WHERE id=?', h.now(), h.now(), id);
      const g = gate();
      h.native.hook = async (method, params, next) => {
        if (method !== 'agent') return next();
        g.enter();
        await g.waiting;
        if (outcome === 'accepted') return next();
        if (outcome === 'ambiguous live') next();
        throw Error('response lost');
      };
      const scan = h.runtime.tick();
      await g.entered;
      if (change === 'check-in')
        await h.runtime.updateTask(caller('engineering'), { task: id, check_in_minutes: 17 });
      if (change === 'same retry check-in')
        await h.runtime.updateTask(caller('engineering'), { task: id, check_in_minutes: 5 });
      if (change === 'handover')
        await h.runtime.updateTask(caller('engineering'), {
          task: id,
          holder: 'product',
          note: 'Review',
        });
      if (change === 'cancellation')
        await h.runtime.updateTask(caller('product'), {
          task: id,
          status: 'cancelled',
          note: 'Stop',
        });
      if (change === 'note')
        await h.runtime.updateTask(caller('product'), { task: id, note: 'New information' });
      if (change === 'worker')
        h.runtime.recordWorker(taskSessionKey('engineering', h.store.task(id)), 'agent:worker:new');
      const latest = h.store.task(id);
      g.release();
      await scan;
      const answered = outcome !== 'error' && change === 'worker';
      assert.deepEqual(
        h.store.task(id),
        answered ? { ...latest, poked: null, check_at: h.now() + 60 * MINUTE } : latest,
      );
      if (change === 'check-in' || change === 'same retry check-in') {
        h.session(taskSessionKey('engineering', h.store.task(id)), { hasActiveRun: false });
        h.runtime.wakes.clear();
        assert.deepEqual((await h.runtime.tick()).woken, []);
      }
    });
  }
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
    assert.equal(store.get('PRAGMA user_version').user_version, 18);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    store.close();
  }
});

for (const status of ['sent', 'queued'])
  for (const destination of ['project', 'owner']) {
    test(`deferred ${status} ${destination} transcript retains delivered destination and exact text after rebind/name change`, async (t) => {
      const h = fixture(t);
      h.native.hook = (method, params, next) => {
        const result = next();
        return method === 'conversations.send' ? { ...result, status } : result;
      };
      if (destination === 'owner') h.store.run('UPDATE projects SET route=NULL WHERE id=?', 'p');
      const target = destination === 'owner' ? owner : group;
      const chat = h.session(`agent:product:${target.target}-chat`, {
        hasActiveRun: true,
        deliveryContext: {
          channel: target.channel,
          accountId: target.accountId,
          to: target.target,
        },
      });
      const id = h.store.enqueue('p', null, 'Exact words');
      await h.runtime.deliver(id);
      assert.equal(h.native.transcripts.length, 0);
      const receipt = JSON.parse(h.store.get('SELECT receipt FROM outbox WHERE id=?', id).receipt);
      assert.equal(receipt.status, status);
      assert.equal(receipt.destination.conversationRef, target.conversationRef);
      assert.equal(
        receipt.sentText,
        destination === 'owner' ? '[Original] Exact words' : 'Exact words',
      );
      h.store.run(
        'UPDATE projects SET route=?,name=? WHERE id=?',
        JSON.stringify(rebound),
        'Renamed',
        'p',
      );
      h.session('agent:product:wrong-chat', {
        deliveryContext: { channel: rebound.channel, to: rebound.target },
      });
      chat.hasActiveRun = false;
      await h.runtime.tick();
      await h.runtime.tick();
      assert.equal(h.native.transcripts.length, 1);
      assert.equal(h.native.transcripts[0].sessionKey, chat.key);
      assert.equal(h.native.transcripts[0].message.content[0].text, receipt.sentText);
      // Future messages still resolve the current binding.
      await h.runtime.deliver(h.store.enqueue('p', null, 'New message'));
      assert.equal(h.native.sends.at(-1).conversationRef, rebound.conversationRef);
    });
  }

test('legacy delivered receipts leave transcript destination uncertainty visible', async (t) => {
  const h = fixture(t);
  const id = h.store.enqueue('p', null, 'Legacy');
  h.store.run(
    "UPDATE outbox SET state='handed',receipt=? WHERE id=?",
    JSON.stringify({ status: 'sent' }),
    id,
  );
  h.session('agent:product:wrong', {
    deliveryContext: { channel: group.channel, to: group.target },
  });
  await h.runtime.tick();
  assert.equal(h.native.transcripts.length, 0);
  assert.equal(h.store.get('SELECT recorded FROM outbox WHERE id=?', id).recorded, 0);
  assert(h.native.logs.some((line) => /destination or text unknown.*legacy receipt/.test(line)));
});

test('partial attachment delivery never falls back or changes successful text destination on retry', async (t) => {
  const h = fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'jg-partial-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = [join(dir, 'one.txt'), join(dir, 'two.txt')];
  paths.forEach((path) => writeFileSync(path, 'bytes'));
  let failures = 0;
  h.native.hook = (method, params, next) => {
    if (method === 'message.action' && params.params.filename === 'two.txt' && failures++ < 4)
      throw Error('file unavailable');
    return next();
  };
  const id = h.store.enqueue('p', null, 'Files', paths);
  assert.equal((await h.runtime.deliver(id)).state, 'retrying');
  h.store.run(
    'UPDATE projects SET route=?,name=? WHERE id=?',
    JSON.stringify(rebound),
    'Changed',
    'p',
  );
  // Beyond the preferred text retry limit, attachments still go to the accepted text chat.
  for (let i = 0; i < 3; i++) assert.equal((await h.runtime.deliver(id)).state, 'retrying');
  assert.equal((await h.runtime.deliver(id)).state, 'sent');
  assert.equal(h.native.sends.length, 1);
  assert.equal(h.native.sends[0].conversationRef, group.conversationRef);
  const files = h.native.calls.filter(([m]) => m === 'message.action').map(([, params]) => params);
  assert(files.every((params) => params.params.to === group.target));
  for (const name of ['one.txt', 'two.txt'])
    assert.equal(
      new Set(
        files
          .filter((params) => params.params.filename === name)
          .map((params) => params.idempotencyKey),
      ).size,
      1,
    );
  assert.equal(h.store.get('SELECT fallback FROM outbox WHERE id=?', id).fallback, 0);
});

test('uncertain text retries preserve operation, destination and wording through rebinding', async (t) => {
  const h = fixture(t);
  h.store.run('UPDATE projects SET route=NULL WHERE id=?', 'p');
  let first = true;
  h.native.hook = (method, params, next) => {
    if (method === 'conversations.send' && first) {
      first = false;
      throw Error('lost response');
    }
    return next();
  };
  const id = h.store.enqueue('p', null, 'Hello');
  await h.runtime.deliver(id);
  h.store.run(
    'UPDATE projects SET route=?,name=? WHERE id=?',
    JSON.stringify(rebound),
    'Changed',
    'p',
  );
  await h.runtime.deliver(id);
  const sends = h.native.calls.filter(([m]) => m === 'conversations.send').map(([, p]) => p);
  assert.deepEqual(sends[1], sends[0]);
  assert.equal(sends[0].message, '[Original] Hello');
  assert.equal(sends[0].conversationRef, owner.conversationRef);
});

test('late concurrent delivery failure cannot discard accepted text and trigger fallback', async (t) => {
  const h = fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'jg-concurrent-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'file.txt');
  writeFileSync(file, 'bytes');
  const id = h.store.enqueue('p', null, 'Already sent', [file]);
  h.store.run('UPDATE outbox SET attempts=2 WHERE id=?', id);
  const g = gate();
  let first = true;
  h.native.hook = async (method, params, next) => {
    if (method === 'conversations.send' && first) {
      first = false;
      g.enter();
      await g.waiting;
      throw Error('late failure');
    }
    if (method === 'message.action') throw Error('file unavailable');
    return next();
  };
  const late = h.runtime.deliver(id);
  await g.entered;
  await h.runtime.deliver(id);
  g.release();
  await late;
  const row = h.store.get('SELECT * FROM outbox WHERE id=?', id);
  assert.equal(row.fallback, 0);
  assert.equal(JSON.parse(row.receipt).status, 'sent');
  assert.equal(JSON.parse(row.receipt).destination.conversationRef, group.conversationRef);
  assert(
    h.native.calls
      .filter(([m]) => m === 'conversations.send')
      .every(([, params]) => params.conversationRef === group.conversationRef),
  );
});

test('an ambiguous wake with unreadable liveness waits for native visibility before retrying', async (t) => {
  const h = fixture(t);
  const id = h.add();
  h.store.run('UPDATE tasks SET check_at=? WHERE id=?', h.now(), id);
  let dispatched = false;
  h.native.hook = (method, params, next) => {
    if (method === 'sessions.list' && dispatched) throw Error('liveness unavailable');
    const result = next();
    if (method === 'agent') {
      dispatched = true;
      throw Error('lost response');
    }
    return result;
  };
  await h.runtime.tick();
  assert.equal(h.store.task(id).idle_wakes, 0);
  h.advance(5 * MINUTE);
  await h.runtime.tick();
  assert.equal(h.native.calls.filter(([m]) => m === 'agent').length, 1);
  h.native.hook = null;
  await h.runtime.tick();
  assert.equal(h.native.calls.filter(([m]) => m === 'agent').length, 1);
  const key = taskSessionKey('engineering', h.store.task(id));
  h.session(key, { hasActiveRun: false });
  await h.runtime.tick();
  assert.equal(h.native.calls.filter(([m]) => m === 'agent').length, 2);
  assert.equal(h.store.task(id).idle_wakes, 1);
});

test('cancellation during model preparation prevents a stale wake dispatch', async (t) => {
  const h = fixture(t);
  const id = h.add();
  h.store.run('UPDATE tasks SET check_at=? WHERE id=?', h.now(), id);
  const g = gate();
  let first = true;
  h.native.hook = async (method, params, next) => {
    if (method === 'sessions.patch' && first) {
      first = false;
      g.enter();
      await g.waiting;
    }
    return next();
  };
  const scan = h.runtime.tick();
  await g.entered;
  await h.runtime.updateTask(caller('product'), { task: id, status: 'cancelled', note: 'Stop' });
  const latest = h.store.task(id);
  g.release();
  await scan;
  assert.deepEqual(h.store.task(id), latest);
  assert.equal(h.native.calls.filter(([m]) => m === 'agent').length, 0);
});
