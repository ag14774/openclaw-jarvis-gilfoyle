// The worker limit for the engineering manager's direct launches, through the real hooks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, MINUTE } from './support/harness.ts';
import { taskSessionKey } from '../src/topology.ts';

const params = { agentId: 'opencode', model: 'probe', task: 'Fake only' };

async function fixture(t, limit = 1) {
  const h = await harness({
    config: {
      worker: {
        agentId: 'opencode',
        runtime: 'acp',
        limit,
        profiles: [{ id: 'probe', model: 'fake/model' }],
      },
    },
  });
  t.after(() => h.runtime.store.close());
  const call = (args) => h.call('main', 'agent:main:operator', args);
  const project = (await call({ operation: 'create_project', name: 'Admission' })).project;
  const tasks = [];
  for (const title of ['A', 'B', 'C'])
    tasks.push((await call({ operation: 'add_task', project, title })).task);
  const keys = tasks.map((id) => taskSessionKey('engineering', h.runtime.store.task(id)));
  let calls = 0;
  // One tool call in a task session.
  const ctx = (i = 0) => ({
    agentId: 'gilfoyle',
    sessionKey: keys[i],
    runId: 'parent-run',
    toolCallId: `call-${++calls}`,
  });
  const before = (c, p = params) =>
    h.hooks.before_tool_call({ toolName: 'sessions_spawn', params: p }, c);
  const after = (c, child) => {
    if (child)
      Object.assign(h.native.session(child), { hasActiveRun: true, spawnedBy: c.sessionKey });
    return h.hooks.after_tool_call(
      {
        toolName: 'sessions_spawn',
        params,
        result: {
          details: child ? { status: 'accepted', childSessionKey: child } : { status: 'error' },
        },
      },
      c,
    );
  };
  return { h, call, project, tasks, keys, ctx, before, after };
}

test('at the last free slot, only one of two simultaneous launches goes ahead', async (t) => {
  const { h, keys, tasks } = await fixture(t);
  const results = await Promise.all(keys.slice(0, 2).map((key) => h.spawn(key, params)));
  assert.equal(results.filter((r) => r.childSessionKey).length, 1);
  assert.match(
    results.find((r) => r.blocked).blocked,
    /1 workers are already running or starting \(limit 1\)/,
  );
  assert.equal(
    tasks.reduce((n, id) => n + h.runtime.store.task(id).workers.length, 0),
    1,
  );
  assert.match((await h.spawn(keys[1], params)).blocked, /limit 1/);
});

test('launches in one turn go ahead together while there is room', async (t) => {
  const { ctx, before, after } = await fixture(t, 2);
  const [c1, c2] = [ctx(0), ctx(0)];
  const results = await Promise.all([before(c1), before(c2)]);
  assert(results.every((r) => r.params?.model === 'fake/model'));
  assert.match((await before(ctx(1))).blockReason, /2 workers .* \(limit 2\)/);
  await after(c1, 'agent:opencode:acp:one');
  await after(c2, 'agent:opencode:acp:two');
  // Started workers now count as running instead of starting.
  assert.match((await before(ctx(1))).blockReason, /2 workers/);
});

test('a refused or failed launch does not hold a slot', async (t) => {
  const { h, ctx, before, after } = await fixture(t);
  assert.match((await before(ctx(0), { ...params, model: 'unknown' })).blockReason, /profile id/);
  h.native.fail.add('sessions.list');
  assert.match((await before(ctx(0))).blockReason, /Cannot check running workers; try again/);
  h.native.fail.delete('sessions.list');
  const c = ctx(1);
  assert((await before(c)).params);
  // The launch failed natively: its completion frees the slot.
  await after(c);
  assert((await before(ctx(2))).params);
});

test('a launch whose completion never arrives stops counting after 16 minutes', async (t) => {
  const { h, ctx, before } = await fixture(t);
  assert((await before(ctx(0))).params);
  h.advance(15 * MINUTE);
  assert.match((await before(ctx(1))).blockReason, /limit 1/);
  h.advance(MINUTE);
  assert((await before(ctx(1))).params);
});

test('only running workers that the engineering manager launched count', async (t) => {
  const { h, tasks, keys, ctx, before } = await fixture(t);
  const worker = h.native.session('agent:opencode:acp:elsewhere');
  // Launched from a task that has since been cancelled: it still runs, so it counts.
  await h.call('main', 'agent:main:operator', {
    operation: 'update_task',
    task: tasks[2],
    status: 'cancelled',
    note: 'Stop',
  });
  Object.assign(worker, { hasActiveRun: true, spawnedBy: keys[2] });
  assert.match((await before(ctx(0))).blockReason, /limit 1/);
  worker.spawnedBy = taskSessionKey('product', h.runtime.store.task(tasks[0]));
  assert((await before(ctx(0))).params);
});

test('a worker target written differently gets the same limit and profile', async (t) => {
  const { ctx, before } = await fixture(t);
  const result = await before(ctx(0), { ...params, agentId: 'OpenCode' });
  assert.deepEqual([result.params.agentId, result.params.model], ['opencode', 'fake/model']);
  assert.match((await before(ctx(1))).blockReason, /limit 1/);
});

test('a full limit is waited out with ordinary short check-ins, without stalling', async (t) => {
  const { h, tasks, keys } = await fixture(t);
  assert((await h.spawn(keys[0], params)).childSessionKey);
  for (let check = 0; check < 6; check++) {
    assert((await h.spawn(keys[1], params)).blocked);
    const action = await h.call('gilfoyle', keys[1], {
      operation: 'update_task',
      note: 'Waiting for a free worker; checking again shortly.',
      check_in_minutes: 5,
    });
    assert(!action.error, action.error);
    const row = h.runtime.store.task(tasks[1]);
    assert.deepEqual(
      [row.status, row.holder, row.idle_wakes, row.stalled],
      ['open', 'engineering', 0, null],
    );
    h.endAllRuns();
    h.advance(5 * MINUTE);
    await h.tick();
    assert.equal(h.runtime.store.task(tasks[1]).stalled, null);
  }
  assert.equal(h.runtime.store.get('SELECT COUNT(*) AS n FROM outbox').n, 0);
});
