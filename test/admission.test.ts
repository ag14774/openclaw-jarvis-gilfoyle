import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { harness, MINUTE } from './support/harness.ts';
import { taskSessionKey } from '../src/topology.ts';
import { Store } from '../src/store.ts';
import { testHooks } from '../src/index.ts';

const params = { agentId: 'opencode', model: 'probe', task: 'Fake only' };
const worker = {
  agentId: 'opencode',
  runtime: 'acp',
  limit: 1,
  profiles: [{ id: 'probe', model: 'fake/model' }],
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
async function fixture(t, { file = false } = {}) {
  const dir = file ? mkdtempSync(join(tmpdir(), 'jg-admission-')) : null;
  const path = dir ? join(dir, 'board.sqlite') : ':memory:';
  const h = await harness({ config: { statePath: path, worker, scanMs: 3_600_000 } });
  t.after(() => {
    h.runtime.store.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const call = (args) => h.call('main', 'agent:main:operator', args);
  const project = (await call({ operation: 'create_project', name: 'Admission' })).project;
  const tasks = [];
  for (const title of ['A', 'B'])
    tasks.push((await call({ operation: 'add_task', project, title })).task);
  const keys = tasks.map((id) => taskSessionKey('engineering', h.runtime.store.task(id)));
  const ctx = (i = 0, toolCallId = 'call-1') => ({
    agentId: 'gilfoyle',
    sessionKey: keys[i],
    sessionId: `parent-${i}`,
    runId: 'parent-run',
    toolCallId,
  });
  const before = (context = ctx(), p = params, hooks = h.hooks) =>
    hooks.before_tool_call({ toolName: 'sessions_spawn', params: p }, context);
  const after = (context = ctx(), result, hooks = h.hooks, extra = {}) =>
    hooks.after_tool_call({ toolName: 'sessions_spawn', params, result, ...extra }, context);
  const accepted = (context = ctx(), child = 'agent:opencode:acp:child') => {
    Object.assign(h.native.session(child), { hasActiveRun: true, spawnedBy: context.sessionKey });
    return { details: { status: 'accepted', childSessionKey: child, runId: 'child-run' } };
  };
  const slowCount = () => {
    const entered = deferred();
    const resume = deferred();
    const request = h.bridge.request.bind(h.bridge);
    h.bridge.request = async (method, p) => {
      if (method === 'sessions.list' && p.agentId === 'opencode') {
        entered.resolve();
        await resume.promise;
      }
      return request(method, p);
    };
    return { entered: entered.promise, resume: resume.resolve };
  };
  return { h, path, call, project, tasks, keys, ctx, before, after, accepted, slowCount };
}

test('limit=1 concurrent real hook spawns admit and record exactly one fake worker', async (t) => {
  const { h, keys, tasks } = await fixture(t);
  const results = await Promise.all(keys.map((key) => h.spawn(key, params)));
  assert.equal(results.filter((r) => r.childSessionKey).length, 1);
  assert.match(results.find((r) => r.blocked).blocked, /pending or unconfirmed.*retry/);
  assert.equal(h.native.sessions.filter((s) => s.hasActiveRun).length, 1);
  assert.equal(
    tasks.reduce((sum, id) => sum + h.runtime.store.task(id).workers.length, 0),
    1,
  );
  assert.match((await h.spawn(keys[1], params)).blocked, /1 workers are already running/);
});

test('shared registrations keep custody through acceptance and recording, not only counting', async (t) => {
  const { h, before, after, accepted, ctx, tasks } = await fixture(t, { file: true });
  const other = h.registerHooks();
  const grant = await before();
  assert.equal(grant.params.model, 'fake/model');
  assert.match((await before(ctx(1), params, other.hooks)).blockReason, /pending or unconfirmed/);
  const result = accepted();
  h.native.session(result.details.childSessionKey).hasActiveRun = false;
  // It is recorded synchronously before the gate can hand off; grace preserves
  // occupancy while an accepted native worker has not yet appeared active.
  await after(ctx(), result, other.hooks);
  assert.equal(h.runtime.store.task(tasks[0]).workers.length, 1);
  assert.match((await before(ctx(1), params, other.hooks)).blockReason, /limit 1/);
  h.advance(3 * MINUTE);
  assert.ok((await before(ctx(1), params, other.hooks)).params);
});

test('same-parent/same-turn overlap and late/unrelated post-hooks never unlock a newer claim', async (t) => {
  const { h, before, after, accepted, ctx } = await fixture(t);
  assert.ok((await before()).params);
  assert.match((await before(ctx(0, 'call-2'))).blockReason, /pending or unconfirmed/);
  await after(ctx(0, 'unrelated'), accepted(ctx(), 'agent:opencode:acp:unrelated'));
  assert.match((await before(ctx(1))).blockReason, /pending or unconfirmed/);
  await after(ctx(), accepted());
  h.advance(3 * MINUTE);
  for (const row of h.native.sessions) row.hasActiveRun = false;
  assert.ok((await before(ctx(0, 'call-2'))).params);
  await after(ctx(), accepted()); // late duplicate of old call
  await after({ ...ctx(0, 'call-2'), runId: 'other-run' }, accepted());
  await after({ ...ctx(0, 'call-2'), sessionId: 'other-incarnation' }, accepted());
  await after(ctx(0, 'call-2'), accepted(), h.hooks, { toolCallId: 'conflicting-event' });
  assert.match((await before(ctx(1, 'call-3'))).blockReason, /pending or unconfirmed/);
  await after(ctx(0, 'call-2'), accepted(ctx(), 'agent:opencode:acp:second'));
  assert.match((await before(ctx(1, 'call-3'))).blockReason, /limit 1/);
});

for (const missing of ['runId', 'toolCallId'])
  test(`missing ${missing} blocks only this spawn and consumes no claim`, async (t) => {
    const { before, ctx } = await fixture(t);
    const context = ctx();
    delete context[missing];
    assert.match((await before(context)).blockReason, /needs native runId and toolCallId/);
    assert.ok((await before()).params);
  });

test('event-only invocation IDs correlate; conflicting IDs refuse before acquiring', async (t) => {
  const { h, before, after, accepted, ctx } = await fixture(t);
  assert.ok(
    (await h.hooks.before_tool_call({ toolName: 'sessions_spawn', params, runId: 'wrong' }, ctx()))
      .block,
  );
  const context = ctx();
  delete context.runId;
  delete context.toolCallId;
  assert.ok(
    (
      await h.hooks.before_tool_call(
        { toolName: 'sessions_spawn', params, runId: 'parent-run', toolCallId: 'call-1' },
        context,
      )
    ).params,
  );
  await after(context, accepted(), h.hooks, { runId: 'parent-run', toolCallId: 'call-1' });
  assert.match((await before(ctx(1))).blockReason, /limit 1/);
});

for (const state of [
  'error',
  'missing',
  'unknown',
  'missing-parent',
  'malformed-list',
  'stale-active',
])
  test(`native count ${state} cannot fail open or free active occupancy`, async (t) => {
    const { h, keys, before, ctx } = await fixture(t);
    const result = await h.spawn(keys[0], params);
    const row = h.native.session(result.childSessionKey);
    h.advance(3 * MINUTE);
    if (state === 'error') h.native.fail.add('sessions.list');
    if (state === 'missing') h.native.sessions = [];
    if (state === 'unknown') delete row.hasActiveRun;
    if (state === 'missing-parent') delete row.spawnedBy;
    if (state === 'malformed-list') h.bridge.request = async () => ({});
    if (state === 'stale-active') h.advance(7 * 60 * MINUTE);
    const blocked = await before(ctx(1));
    assert.ok(blocked.block);
    assert.match(
      blocked.blockReason,
      state === 'stale-active' ? /limit 1/ : /admission unavailable/,
    );
    // Known prelaunch errors/refusals release: the next caller checks again rather
    // than inheriting uncertain launch custody, and other work is unaffected.
    assert.doesNotMatch((await before(ctx(1, 'retry'))).blockReason, /pending or unconfirmed/);
    assert.equal(
      await h.hooks.before_tool_call(
        { toolName: 'sessions_spawn', params },
        { agentId: 'main', sessionKey: 'agent:main:personal' },
      ),
      undefined,
    );
  });

for (const outcome of ['missing', 'error', 'isError', 'unknown', 'wrong-child', 'record-failure'])
  test(`post-hook ${outcome} retains explicit custody without automatic unlock`, async (t) => {
    const { h, before, after, accepted, ctx, tasks } = await fixture(t);
    assert.ok((await before()).params);
    let result;
    let extra = {};
    if (outcome !== 'missing') result = accepted();
    if (outcome === 'error') extra = { error: 'native dispatch uncertain' };
    if (outcome === 'isError') result.isError = true;
    if (outcome === 'unknown') result.details.status = 'unknown';
    if (outcome === 'wrong-child') result.details.childSessionKey = 'agent:researcher:acp:other';
    if (outcome === 'record-failure')
      h.runtime.recordWorker = () => {
        throw new Error('write failed');
      };
    await after(ctx(), result, h.hooks, extra);
    if (outcome === 'error' || outcome === 'isError' || outcome === 'unknown')
      assert.equal(h.runtime.store.task(tasks[0]).workers.length, 1);
    assert.ok(
      h.warnings.some((message) => /remains unconfirmed.*no automatic unlock/.test(message)),
    );
    h.advance(24 * 60 * MINUTE);
    await h.endTurn('gilfoyle', ctx().sessionKey);
    assert.match(
      (await before(ctx(1))).blockReason,
      /pending or unconfirmed.*elapsed time and reload/,
    );
    assert.ok(
      !(
        await before({
          ...ctx(1),
          agentId: 'main',
          sessionKey: taskSessionKey('product', h.runtime.store.task(tasks[1])),
        })
      )?.block,
    );
    assert.equal(await before(ctx(1), { agentId: 'researcher', task: 'look' }), undefined);
    assert.equal(
      await h.hooks.before_tool_call({ toolName: 'read', params: {} }, ctx(1)),
      undefined,
    );
    assert.equal(
      await h.hooks.before_tool_call(
        { toolName: 'sessions_spawn', params },
        { agentId: 'other', sessionKey: 'agent:other:personal' },
      ),
      undefined,
    );
  });

test('missing post-hook, cancelled owning turn and elapsed time never clear a granted claim', async (t) => {
  const { h, before, ctx, call, tasks } = await fixture(t);
  const abort = new AbortController();
  assert.ok((await before({ ...ctx(), abortSignal: abort.signal })).params);
  abort.abort();
  await call({
    operation: 'update_task',
    task: tasks[0],
    status: 'cancelled',
    note: 'Stop',
    message: 'Stopped',
  });
  h.advance(24 * 60 * MINUTE);
  await h.endTurn('gilfoyle', ctx().sessionKey);
  assert.match((await before(ctx(1))).blockReason, /pending or unconfirmed/);
});

for (const status of ['cancelled', 'done'])
  test(`native running workers on ${status} tasks still consume the limit`, async (t) => {
    const { h, keys, tasks, before, ctx } = await fixture(t);
    await h.spawn(keys[0], params);
    h.runtime.store.run('UPDATE tasks SET status=?,holder=NULL WHERE id=?', status, tasks[0]);
    h.advance(3 * MINUTE);
    assert.match((await before(ctx(1))).blockReason, /limit 1/);
  });

test('product launches and worker descendants do not consume engineering direct-worker capacity', async (t) => {
  const { h, tasks, keys, before } = await fixture(t);
  const productKey = taskSessionKey('product', h.runtime.store.task(tasks[0]));
  await h.spawn(productKey, params);
  const direct = await h.spawn(keys[0], params);
  assert.ok(direct.childSessionKey); // product worker was excluded even during grace
  h.advance(3 * MINUTE);
  const row = h.native.session(direct.childSessionKey);
  row.hasActiveRun = false;
  row.hasActiveSubagentRun = true;
  Object.assign(h.native.session('agent:opencode:subagent:descendant'), {
    hasActiveRun: true,
    spawnedBy: direct.childSessionKey,
  });
  assert.ok((await before()).params);
});

test('failed profile validation releases safely before launch permission', async (t) => {
  const { before } = await fixture(t);
  assert.match((await before(undefined, { ...params, model: 'bad' })).blockReason, /profile id/);
  assert.ok((await before()).params);
});

test('text-only accepted result records before release; malformed text retains custody', async (t) => {
  const { h, before, after, accepted, ctx } = await fixture(t);
  assert.ok((await before()).params);
  const result = accepted();
  await after(ctx(), { content: [{ type: 'text', text: JSON.stringify(result.details) }] });
  h.advance(3 * MINUTE);
  h.native.session(result.details.childSessionKey).hasActiveRun = false;
  assert.ok((await before(ctx(1))).params);
  await after(ctx(1), { content: [{ type: 'text', text: '{' }] });
  assert.match((await before()).blockReason, /pending or unconfirmed/);
});

test('a late worker record during native count forces a fresh admission check', async (t) => {
  const { h, keys, tasks, before, after, accepted, ctx, slowCount } = await fixture(t);
  const first = await h.spawn(keys[0], params);
  h.advance(3 * MINUTE);
  h.native.session(first.childSessionKey).hasActiveRun = false;
  const slow = slowCount();
  const pending = before(ctx(1));
  await slow.entered;
  await after(ctx(0, 'late'), accepted(ctx(), 'agent:opencode:acp:late'));
  slow.resume();
  assert.match((await pending).blockReason, /records changed while counting/);
  assert.equal(h.runtime.store.task(tasks[0]).workers.length, 2);
  assert.match((await before(ctx(1, 'retry'))).blockReason, /limit 1/);
});

test('recording never truncates older running identities when a task accumulates workers', async (t) => {
  const { h, tasks, after, accepted, ctx, before } = await fixture(t);
  for (let i = 0; i < 51; i++) {
    const result = accepted(ctx(), `agent:opencode:acp:history-${i}`);
    h.native.session(result.details.childSessionKey).hasActiveRun = i === 0;
    await after(ctx(0, `late-${i}`), result);
  }
  h.advance(3 * MINUTE);
  const records = h.runtime.store.task(tasks[0]).workers;
  assert.equal(records.length, 51);
  assert.equal(records[0].key, 'agent:opencode:acp:history-0');
  assert.match((await before(ctx(1))).blockReason, /1 workers are already running/);
  assert.ok(
    h.native.calls
      .filter(([method]) => method === 'sessions.list')
      .every(([, p]) => p.archived === 'all'),
  );
});

for (const change of ['paused', 'cancelled'])
  test(`${change} during slow native count wins; no SQLite transaction spans RPC or blocks another writer`, async (t) => {
    const { h, path, keys, tasks, project, before, ctx, slowCount } = await fixture(t, {
      file: true,
    });
    const first = await h.spawn(keys[0], params);
    h.advance(3 * MINUTE);
    h.native.session(first.childSessionKey).hasActiveRun = false;
    const slow = slowCount();
    const pending = before(ctx(1));
    await slow.entered;
    assert.match((await before(ctx(0, 'concurrent'))).blockReason, /pending or unconfirmed/);
    const writer = new Store(path);
    try {
      writer.tx(() => {
        if (change === 'paused')
          writer.run("UPDATE projects SET state='paused' WHERE id=?", project);
        else writer.run("UPDATE tasks SET status='cancelled',holder=NULL WHERE id=?", tasks[1]);
      });
    } finally {
      writer.close();
    }
    slow.resume();
    assert.match((await pending).blockReason, /changed while checking workers/);
    if (change === 'paused')
      h.runtime.store.run("UPDATE projects SET state='active' WHERE id=?", project);
    else
      h.runtime.store.run(
        "UPDATE tasks SET status='open',holder='engineering' WHERE id=?",
        tasks[1],
      );
    assert.ok((await before(ctx(1, 'retry'))).params);
  });

test('a hook wait timing out does not unlock its continuing callback', async (t) => {
  const { h, keys, before, ctx, slowCount } = await fixture(t);
  const first = await h.spawn(keys[0], params);
  h.advance(3 * MINUTE);
  h.native.session(first.childSessionKey).hasActiveRun = false;
  const slow = slowCount();
  const callback = before();
  await slow.entered;
  // Model the pinned host Promise.race: wait ends, original callback continues.
  await assert.rejects(
    Promise.race([callback, Promise.reject(new Error('hook timeout'))]),
    /hook timeout/,
  );
  assert.match((await before(ctx(1))).blockReason, /pending or unconfirmed/);
  slow.resume();
  assert.ok((await callback).params);
  assert.match((await before(ctx(1))).blockReason, /pending or unconfirmed/);
});

test('reload startOver preserves granted custody and matching old hook records in the new runtime', async (t) => {
  const { h, before, after, accepted, ctx, tasks } = await fixture(t, { file: true });
  const old = h.runtime;
  const first = h.hooks.service;
  const other = h.registerHooks();
  t.after(async () => {
    await first.stop();
    await other.service.stop();
    testHooks.bridge = null;
  });
  testHooks.bridge = h.bridge;
  await first.start();
  assert.ok((await before()).params);
  await other.service.start();
  assert.ok(old.stopped);
  assert.notEqual(h.runtime, old);
  assert.match((await before(ctx(1), params, other.hooks)).blockReason, /pending or unconfirmed/);
  await after(ctx(), accepted());
  assert.equal(h.runtime.store.task(tasks[0]).workers.length, 1);
  assert.match((await before(ctx(1), params, other.hooks)).blockReason, /limit 1/);
});

test('reload during native count cannot grant from the retired runtime', async (t) => {
  const { h, keys, before, ctx, slowCount } = await fixture(t, { file: true });
  const first = await h.spawn(keys[0], params);
  h.advance(3 * MINUTE);
  h.native.session(first.childSessionKey).hasActiveRun = false;
  const other = h.registerHooks();
  t.after(async () => {
    await h.hooks.service.stop();
    await other.service.stop();
    testHooks.bridge = null;
  });
  testHooks.bridge = h.bridge;
  await h.hooks.service.start();
  const slow = slowCount();
  const pending = before();
  await slow.entered;
  await other.service.start();
  assert.match((await before(ctx(1), params, other.hooks)).blockReason, /pending or unconfirmed/);
  slow.resume();
  assert.ok((await pending).block);
  assert.ok((await before(ctx(1), params, other.hooks)).params);
});

test('accepted post-hook after cancellation records the worker and schedules existing abort retry', async (t) => {
  const { h, before, after, accepted, ctx, call, tasks } = await fixture(t);
  assert.ok((await before()).params);
  await call({
    operation: 'update_task',
    task: tasks[0],
    status: 'cancelled',
    note: 'Stop',
    message: 'Stopped',
  });
  await after(ctx(), accepted());
  assert.equal(h.runtime.store.task(tasks[0]).check_at, h.now());
  assert.match((await before(ctx(1))).blockReason, /limit 1/);
  await h.tick();
  assert.deepEqual(h.native.aborted, ['agent:opencode:acp:child']);
});

test('a new process loses unrecorded admission custody: restart is explicitly not a hard guarantee', async (t) => {
  const { path, before } = await fixture(t, { file: true });
  assert.ok((await before()).params); // model accepted native effect with lost result
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { harness } from './test/support/harness.ts';
    import { taskSessionKey } from './src/topology.ts';
    const h = await harness({ config: { statePath: ${JSON.stringify(path)}, worker: ${JSON.stringify(worker)} } });
    const task = h.runtime.store.task(2);
    const result = await h.hooks.before_tool_call(
      { toolName: 'sessions_spawn', params: ${JSON.stringify(params)} },
      { agentId: 'gilfoyle', sessionKey: taskSessionKey('engineering', task), runId: 'new-process', toolCallId: 'new-call' },
    );
    assert.ok(result.params, JSON.stringify(result));
    h.runtime.store.close();
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
});
