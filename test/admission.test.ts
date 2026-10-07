import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { harness, MINUTE } from './support/harness.ts';
import { taskSessionKey } from '../src/topology.ts';
import { Store } from '../src/store.ts';
import plugin, { testHooks } from '../src/index.ts';

const params = { agentId: 'opencode', model: 'probe', task: 'Fake only' };
const ADMISSION_MS = 16 * MINUTE;
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
  assert.match(results.find((r) => r.blocked).blocked, /invocation is pending.*retry/);
  assert.equal(h.native.sessions.filter((s) => s.hasActiveRun).length, 1);
  assert.equal(
    tasks.reduce((sum, id) => sum + h.runtime.store.task(id).workers.length, 0),
    1,
  );
  assert.match((await h.spawn(keys[1], params)).blocked, /1 workers are already running/);
});

test('shared registrations serialize through completion and recording, not only counting', async (t) => {
  const { h, before, after, accepted, ctx, tasks } = await fixture(t, { file: true });
  const other = h.registerHooks();
  const grant = await before();
  assert.equal(grant.params.model, 'fake/model');
  assert.match((await before(ctx(1), params, other.hooks)).blockReason, /invocation is pending/);
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

test('equal JSON configuration with reordered nested object properties shares invocation serialization', async (t) => {
  const { h, path, before, after, accepted, ctx, tasks } = await fixture(t, { file: true });
  const other = h.registerHooks({
    worker: {
      profiles: [{ model: 'fake/model', id: 'probe' }],
      limit: 1,
      runtime: 'acp',
      agentId: 'opencode',
    },
    ownerChat: { to: 'telegram:100', accountId: 'default', channel: 'telegram' },
    engineeringAgentId: 'gilfoyle',
    productAgentId: 'main',
    scanMs: 3_600_000,
    statePath: path,
  });
  const decisions = await Promise.all([before(), before(ctx(1), params, other.hooks)]);
  assert.equal(decisions.filter((decision) => decision?.params).length, 1);
  assert.match(decisions.find((decision) => decision?.block).blockReason, /invocation is pending/);
  await after(ctx(), accepted(), other.hooks);
  assert.equal(h.runtime.store.task(tasks[0]).workers.length, 1);
  assert.match((await before(ctx(1), params, other.hooks)).blockReason, /limit 1/);
});

test('native-trimmed configured target shares the gate and receives the configured profile', async (t) => {
  const { before, after, accepted, ctx } = await fixture(t);
  const spaced = { ...params, agentId: ' \topencode\n ' };
  const decisions = await Promise.all([before(ctx(), spaced), before(ctx(1), params)]);
  assert.equal(decisions.filter((decision) => decision?.params).length, 1);
  assert.equal(decisions[0].params.agentId, 'opencode');
  assert.equal(decisions[0].params.model, 'fake/model');
  assert.match(decisions[1].blockReason, /invocation is pending/);
  await after(ctx(), accepted());
  assert.match((await before(ctx(1), spaced)).blockReason, /limit 1/);
});

test('native-trimmed target profile refusal consumes no claim', async (t) => {
  const { before } = await fixture(t);
  assert.match(
    (await before(undefined, { ...params, agentId: ' opencode ', model: 'bad' })).blockReason,
    /profile id/,
  );
  assert.ok((await before()).params);
});

test('unavailable board refuses both exact and native-trimmed configured targets', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jg-admission-unavailable-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hooks = {};
  plugin.register({
    pluginConfig: {
      statePath: dir, // A directory cannot be opened as the SQLite board.
      productAgentId: 'main',
      engineeringAgentId: 'gilfoyle',
      worker,
    },
    logger: { warn() {} },
    registerTool() {},
    registerService() {},
    registerGatewayMethod() {},
    on: (name, fn) => (hooks[name] = fn),
  });
  for (const agentId of ['opencode', ' opencode ', 'OpenCode', '!!OpenCode!!']) {
    const decision = await hooks.before_tool_call(
      { toolName: 'sessions_spawn', params: { ...params, agentId } },
      {
        agentId: 'gilfoyle',
        sessionKey: 'agent:gilfoyle:jarvis-gilfoyle:task-1-1',
        runId: 'parent-run',
        toolCallId: `call-${agentId}`,
      },
    );
    assert.equal(decision.block, true);
    assert.match(decision.blockReason, /Worker admission unavailable.*Project board unavailable/);
  }
});

test('same-parent/same-turn overlap and late/unrelated post-hooks never unlock a newer claim', async (t) => {
  const { h, before, after, accepted, ctx } = await fixture(t);
  assert.ok((await before()).params);
  assert.match((await before(ctx(0, 'call-2'))).blockReason, /invocation is pending/);
  await after(ctx(0, 'unrelated'), accepted(ctx(), 'agent:opencode:acp:unrelated'));
  assert.match((await before(ctx(1))).blockReason, /invocation is pending/);
  await after(ctx(), accepted());
  h.advance(3 * MINUTE);
  for (const row of h.native.sessions) row.hasActiveRun = false;
  assert.ok((await before(ctx(0, 'call-2'))).params);
  await after(ctx(), accepted()); // late duplicate of old call
  await after({ ...ctx(0, 'call-2'), runId: 'other-run' }, accepted());
  await after({ ...ctx(0, 'call-2'), sessionId: 'other-incarnation' }, accepted());
  await after(ctx(0, 'call-2'), accepted(), h.hooks, { toolCallId: 'conflicting-event' });
  await after(ctx(0, 'unrelated'), undefined, h.hooks, { error: 'completed unrelated call' });
  await after(ctx(), undefined); // late completion without a child also cannot unlock
  assert.match((await before(ctx(1, 'call-3'))).blockReason, /invocation is pending/);
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
  'unknown',
  'missing-parent',
  'malformed-list',
  'nonadvancing-page',
  'unknown-completeness',
  'stale-active',
])
  test(`native count ${state} cannot fail open or free active occupancy`, async (t) => {
    const { h, keys, before, ctx } = await fixture(t);
    const result = await h.spawn(keys[0], params);
    const row = h.native.session(result.childSessionKey);
    h.advance(3 * MINUTE);
    if (state === 'error') h.native.fail.add('sessions.list');
    if (state === 'unknown') delete row.hasActiveRun;
    if (state === 'missing-parent') delete row.spawnedBy;
    if (state === 'malformed-list') h.bridge.request = async () => ({});
    if (state === 'nonadvancing-page' || state === 'unknown-completeness') {
      const request = h.bridge.request.bind(h.bridge);
      h.bridge.request = async (method, p) => {
        const result = await request(method, p);
        if (method === 'sessions.list') {
          if (state === 'nonadvancing-page') {
            result.hasMore = true;
            result.nextOffset = p.offset;
          } else delete result.hasMore;
        }
        return result;
      };
    }
    if (state === 'stale-active') h.advance(7 * 60 * MINUTE);
    const blocked = await before(ctx(1));
    assert.ok(blocked.block);
    assert.match(
      blocked.blockReason,
      state === 'stale-active' ? /limit 1/ : /admission unavailable/,
    );
    // Known prelaunch errors/refusals release: the next caller checks again rather
    // than inheriting an unfinished invocation, and other work is unaffected.
    assert.doesNotMatch((await before(ctx(1, 'retry'))).blockReason, /invocation is pending/);
    assert.equal(
      await h.hooks.before_tool_call(
        { toolName: 'sessions_spawn', params },
        { agentId: 'main', sessionKey: 'agent:main:personal' },
      ),
      undefined,
    );
  });

test('native cleanup of completed archived history permits new work without deleting board history', async (t) => {
  const { h, path, keys, tasks, project, call, before, ctx } = await fixture(t, { file: true });
  const launched = await h.spawn(keys[0], params);
  h.advance(61 * MINUTE);
  h.native.session(launched.childSessionKey).hasActiveRun = false;
  for (let i = 0; i < tasks.length; i++) {
    const result = await call({
      operation: 'update_task',
      task: tasks[i],
      status: i === 0 ? 'done' : 'cancelled',
      note: 'Finished',
      message: 'Finished',
    });
    assert.ok(!result.error, result.error);
  }
  assert.ok(!(await call({ operation: 'update_project', project, state: 'archived' })).error);
  const nextProject = (await call({ operation: 'create_project', name: 'Next' })).project;
  const nextTask = (await call({ operation: 'add_task', project: nextProject, title: 'New work' }))
    .task;
  const nextKey = taskSessionKey('engineering', h.runtime.store.task(nextTask));
  const history = h.runtime.store.task(tasks[0]).workers;
  h.native.sessions = h.native.sessions.filter((row) => row.key !== launched.childSessionKey);
  for (const minutes of [0, 5, 1440]) {
    h.advance(minutes * MINUTE);
    const context = { ...ctx(), sessionKey: nextKey, toolCallId: `retry-${minutes}` };
    const grant = await before(context);
    assert.ok(grant.params, JSON.stringify(grant));
    const result = {
      details: { status: 'accepted', childSessionKey: `agent:opencode:acp:next-${minutes}` },
    };
    Object.assign(h.native.session(result.details.childSessionKey), {
      spawnedBy: nextKey,
      hasActiveRun: false,
    });
    await h.hooks.after_tool_call({ toolName: 'sessions_spawn', params, result }, context);
    h.advance(3 * MINUTE);
  }
  assert.deepEqual(h.runtime.store.task(tasks[0]).workers, history);
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
      const h = await harness({ config: { statePath: ${JSON.stringify(path)}, worker: ${JSON.stringify(worker)} } });
      h.advance(2 * 24 * 60 * 60 * 1000);
      const result = await h.hooks.before_tool_call(
        { toolName: 'sessions_spawn', params: ${JSON.stringify(params)} },
        { agentId: 'gilfoyle', sessionKey: ${JSON.stringify(nextKey)}, runId: 'fresh', toolCallId: 'fresh' },
      );
      assert.ok(result.params, JSON.stringify(result));
      assert.equal(h.runtime.store.task(${tasks[0]}).workers.length, 1);
      h.runtime.store.close();
    `,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
});

test('missing recent native parent refuses during visibility grace but never settles history', async (t) => {
  const { h, keys, tasks, before, ctx } = await fixture(t);
  await h.spawn(keys[0], params);
  const history = h.runtime.store.task(tasks[0]).workers;
  h.native.sessions = [];
  assert.match((await before(ctx(1))).blockReason, /parent unknown during visibility grace/);
  h.advance(3 * MINUTE);
  assert.ok((await before(ctx(1))).params);
  assert.deepEqual(h.runtime.store.task(tasks[0]).workers, history);
});

test('native observation pages past idle history and counts an older active direct worker', async (t) => {
  const { h, keys, before, ctx } = await fixture(t);
  for (let i = 0; i < 201; i++) h.native.session(`agent:opencode:acp:idle-${i}`);
  Object.assign(h.native.session('agent:opencode:acp:older-active'), {
    hasActiveRun: true,
    spawnedBy: keys[0],
  });
  assert.match((await before(ctx(1))).blockReason, /limit 1/);
  const pages = h.native.calls.filter(([method]) => method === 'sessions.list');
  assert.equal(pages.length, 2);
  assert.equal(pages[1][1].offset, 200);
  h.native.session('agent:opencode:acp:older-active').hasActiveRun = false;
  assert.ok((await before(ctx(1, 'retry'))).params);
});

test('a completed deterministic input rejection permits the next valid fake spawn', async (t) => {
  const { h, before, after, ctx } = await fixture(t);
  assert.ok((await before(ctx(), { ...params, taskName: 'BAD NAME' })).params);
  await after(ctx(), { details: { status: 'error', error: 'Native input rejection' } });
  assert.equal(h.native.sessions.length, 0);
  assert.ok((await h.spawn(ctx(1).sessionKey, params)).childSessionKey);
});

for (const outcome of ['missing', 'empty', 'error', 'isError', 'unknown', 'malformed-text'])
  test(`matching completion with ${outcome} result and no child releases invocation serialization`, async (t) => {
    const { h, before, after, ctx } = await fixture(t);
    assert.ok((await before()).params);
    const result = {
      missing: undefined,
      empty: {},
      error: { details: { status: 'error' } },
      isError: { isError: true },
      unknown: { details: { status: 'unknown' } },
      'malformed-text': { content: [{ type: 'text', text: '{' }] },
    }[outcome];
    await after(ctx(), result, h.hooks, outcome === 'error' ? { error: 'native error' } : {});
    assert.ok((await before(ctx(1))).params);
    assert.equal(h.native.sessions.length, 0);
    assert.equal(h.warnings.length, 0);
  });

for (const outcome of ['error', 'isError', 'unknown'])
  test(`matching ${outcome} completion records a known child before release; visible child prevents excess`, async (t) => {
    const { h, before, after, accepted, ctx, tasks } = await fixture(t);
    assert.ok((await before()).params);
    const result = accepted();
    const extra = outcome === 'error' ? { error: 'native dispatch uncertain' } : {};
    if (outcome === 'error') result.details.status = 'error';
    if (outcome === 'isError') result.isError = true;
    if (outcome === 'unknown') result.details.status = 'unknown';
    const record = h.runtime.recordWorker.bind(h.runtime);
    let duringRecord;
    h.runtime.recordWorker = (...args) => {
      duringRecord = before(ctx(1));
      return record(...args);
    };
    await after(ctx(), result, h.hooks, extra);
    assert.match((await duringRecord).blockReason, /invocation is pending/);
    assert.equal(h.runtime.store.task(tasks[0]).workers.length, 1);
    assert.match((await before(ctx(1))).blockReason, /limit 1/);
    h.advance(3 * MINUTE);
    h.native.session(result.details.childSessionKey).hasActiveRun = false;
    assert.ok((await before(ctx(1, 'retry'))).params);
  });

for (const failure of ['throw', 'unconfirmed'])
  test(`record ${failure} is reported and completed invocation releases despite failed history write`, async (t) => {
    const { h, before, after, accepted, ctx, tasks } = await fixture(t);
    assert.ok((await before()).params);
    const result = accepted();
    h.runtime.recordWorker = () => {
      if (failure === 'throw') throw new Error('write failed');
    };
    await after(ctx(), result);
    assert.equal(h.runtime.store.task(tasks[0]).workers.length, 0);
    assert.match(
      h.warnings[0],
      /Worker recording failed: (write failed|worker recording unconfirmed)/,
    );
    assert.match((await before(ctx(1))).blockReason, /limit 1/);
    h.native.sessions = [];
    assert.ok((await before(ctx(1, 'retry'))).params);
  });

test('absent completion survives cancelled turn and reload until original expiry', async (t) => {
  const { h, before, after, ctx, call, tasks } = await fixture(t, { file: true });
  const other = h.registerHooks();
  t.after(async () => {
    await h.hooks.service.stop();
    await other.service.stop();
    testHooks.bridge = null;
  });
  testHooks.bridge = h.bridge;
  await h.hooks.service.start();
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
  h.advance(ADMISSION_MS - 1);
  await h.endTurn('gilfoyle', ctx().sessionKey);
  await other.service.start();
  assert.match((await before(ctx(1), params, other.hooks)).blockReason, /invocation is pending/);
  h.advance(1);
  assert.ok((await before(ctx(1), params, other.hooks)).params);
  await after(ctx(), undefined); // old completion cannot release the replacement
  assert.match(
    (await before(ctx(1, 'next'), params, other.hooks)).blockReason,
    /invocation is pending/,
  );
});

test('actual baseline claim adopts one deadline on upgrade; reload and late old completion preserve replacement', async (t) => {
  const { h, path, before, after, accepted, ctx, tasks } = await fixture(t, { file: true });
  const source = spawnSync('git', ['show', 'c132af9:src/index.ts'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(source.status, 0, source.stderr);
  // Load the actual baseline registration, resolving only its relative imports to
  // the unchanged source dependencies. The board file and native API are disposable fakes.
  const baseline = await import(
    `data:text/javascript;base64,${Buffer.from(
      source.stdout.replace(
        /from '\.\/(.*?)\.js'/g,
        (_match, name) => `from '${new URL(`../src/${name}.ts`, import.meta.url).href}'`,
      ),
    ).toString('base64')}`
  );
  Object.assign(baseline.testHooks, testHooks, { bridge: h.bridge });
  const config = {
    statePath: path,
    productAgentId: 'main',
    engineeringAgentId: 'gilfoyle',
    ownerChat: { channel: 'telegram', accountId: 'default', to: 'telegram:100' },
    worker,
    scanMs: 3_600_000,
  };
  const oldHooks = {};
  baseline.default.register({
    pluginConfig: config,
    logger: { warn: (message) => h.warnings.push(message) },
    registerTool() {},
    registerGatewayMethod() {},
    registerService: (service) => (oldHooks.service = service),
    on: (name, fn) => (oldHooks[name] = fn),
  });
  const services = [h.hooks.service, oldHooks.service];
  t.after(async () => {
    for (const service of services) await service.stop();
    testHooks.bridge = null;
  });
  testHooks.bridge = h.bridge;
  await h.hooks.service.start();
  await oldHooks.service.start();
  assert.ok((await before(ctx(), params, oldHooks)).params);
  // Baseline acquisition predates adoption, but its time was never retained.
  h.advance(5 * MINUTE);
  const upgraded = h.registerHooks();
  services.push(upgraded.service);
  await upgraded.service.start();
  h.advance(8 * MINUTE);
  const reloaded = h.registerHooks();
  services.push(reloaded.service);
  await reloaded.service.start();
  h.advance(8 * MINUTE - 1);
  assert.match(
    (await before(ctx(1, 'early'), params, reloaded.hooks)).blockReason,
    /invocation is pending/,
  );
  h.advance(1);
  assert.ok((await before(ctx(1, 'replacement'), params, reloaded.hooks)).params);
  await after(ctx(), undefined, oldHooks);
  assert.match(
    (await before(ctx(0, 'next'), params, reloaded.hooks)).blockReason,
    /invocation is pending/,
  );
  await after(ctx(), accepted(), oldHooks);
  assert.equal(h.runtime.store.task(tasks[0]).workers[0].key, 'agent:opencode:acp:child');
  assert.match(
    (await before(ctx(0, 'next'), params, reloaded.hooks)).blockReason,
    /invocation is pending/,
  );
  await after(ctx(1, 'replacement'), undefined, reloaded.hooks);
  assert.match((await before(ctx(0, 'next'), params, reloaded.hooks)).blockReason, /limit 1/);
});

test('missing completion recovers exactly at expiry; late old child records without releasing newer claim', async (t) => {
  const { h, before, after, accepted, ctx, tasks } = await fixture(t);
  assert.ok((await before()).params);
  h.advance(ADMISSION_MS - 1);
  assert.match((await before(ctx(1, 'early'))).blockReason, /invocation is pending/);
  h.advance(1);
  assert.ok((await before(ctx(1, 'new'))).params);
  await after(ctx(), accepted());
  assert.equal(h.runtime.store.task(tasks[0]).workers.length, 1);
  assert.match((await before(ctx(0, 'third'))).blockReason, /invocation is pending/);
  await after(ctx(1, 'new'), undefined);
  assert.match((await before(ctx(0, 'third'))).blockReason, /limit 1/);
});

test('wall-clock rollback does not extend process-local admission expiry', async (t) => {
  const { h, before, ctx } = await fixture(t);
  assert.ok((await before()).params);
  h.advance(-24 * 60 * MINUTE);
  h.advance(ADMISSION_MS - 1);
  assert.match((await before(ctx(1))).blockReason, /invocation is pending/);
  h.advance(1);
  assert.ok((await before(ctx(1))).params);
});

for (const replacement of ['none', 'pending'])
  test(`suspended prelaunch callback cannot grant at expiry with ${replacement} replacement`, async (t) => {
    const { h, before, ctx, slowCount } = await fixture(t);
    const slow = slowCount();
    const old = before();
    await slow.entered;
    h.advance(ADMISSION_MS);
    let newer;
    if (replacement !== 'none') newer = before(ctx(1, 'new'));
    slow.resume();
    assert.match((await old).blockReason, /expired or replaced/);
    if (newer) assert.ok((await newer).params);
    const next = await before(ctx(0, 'next'));
    if (replacement === 'pending') assert.match(next.blockReason, /invocation is pending/);
    else assert.ok(next.params);
  });

for (const completed of [false, true])
  test(`expired old callback resuming after newer grant (completed=${completed}) cannot reacquire permission`, async (t) => {
    const { h, before, after, ctx, slowCount } = await fixture(t);
    const request = h.bridge.request.bind(h.bridge);
    const slow = slowCount();
    const old = before();
    await slow.entered;
    h.advance(ADMISSION_MS);
    h.bridge.request = request; // Only the old callback remains suspended.
    assert.ok((await before(ctx(1, 'new'))).params);
    if (completed) await after(ctx(1, 'new'), undefined);
    slow.resume();
    assert.match((await old).blockReason, /expired or replaced/);
    const next = await before(ctx(0, 'next'));
    if (completed) assert.ok(next.params);
    else assert.match(next.blockReason, /invocation is pending/);
  });

test('matching completion releases serialization but unavailable current native count still refuses', async (t) => {
  const { h, before, after, ctx } = await fixture(t);
  assert.ok((await before()).params);
  await after(ctx(), undefined, h.hooks, { error: 'unknown native effect' });
  h.native.fail.add('sessions.list');
  for (const id of ['next', 'retry'])
    assert.match((await before(ctx(1, id))).blockReason, /admission unavailable/);
  h.native.fail.delete('sessions.list');
  assert.ok((await before(ctx(1, 'available'))).params);
});

test('matching error records another known agent child without charging configured-worker capacity', async (t) => {
  const { h, before, after, ctx, tasks } = await fixture(t);
  assert.ok((await before()).params);
  await after(ctx(), {
    details: { status: 'error', childSessionKey: 'agent:researcher:subagent:known' },
  });
  assert.equal(h.runtime.store.task(tasks[0]).workers[0].key, 'agent:researcher:subagent:known');
  assert.ok((await before(ctx(1))).params);
});

for (const status of ['cancelled', 'done'])
  test(`native running workers on ${status} tasks still consume the limit`, async (t) => {
    const { h, keys, tasks, before, ctx } = await fixture(t);
    await h.spawn(keys[0], params);
    h.runtime.store.run('UPDATE tasks SET status=?,holder=NULL WHERE id=?', status, tasks[0]);
    h.advance(3 * MINUTE);
    assert.match((await before(ctx(1))).blockReason, /limit 1/);
  });

for (const status of ['open', 'cancelled', 'done'])
  test(`observed direct workers on ${status} tasks count even without a worker record`, async (t) => {
    const { h, tasks, keys, before, ctx, project } = await fixture(t);
    h.runtime.store.run('UPDATE tasks SET status=? WHERE id=?', status, tasks[0]);
    Object.assign(h.native.session('agent:opencode:acp:unrecorded'), {
      hasActiveRun: true,
      spawnedBy: keys[0],
    });
    // Task/project status does not settle a natively active direct worker.
    if (status !== 'open')
      h.runtime.store.run("UPDATE projects SET state='archived' WHERE id=?", project);
    const otherProject = (
      await h.call('main', 'agent:main:operator', {
        operation: 'create_project',
        name: 'Active project',
      })
    ).project;
    const otherTask = (
      await h.call('main', 'agent:main:operator', {
        operation: 'add_task',
        project: otherProject,
        title: 'Waiting',
      })
    ).task;
    const context = {
      ...ctx(1),
      sessionKey: taskSessionKey('engineering', h.runtime.store.task(otherTask)),
    };
    assert.equal(h.runtime.store.task(tasks[0]).workers.length, 0);
    assert.match((await before(context)).blockReason, /limit 1/);
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

test('text-only child result records before matching completion releases', async (t) => {
  const { h, before, after, accepted, ctx } = await fixture(t);
  assert.ok((await before()).params);
  const result = accepted();
  await after(ctx(), { content: [{ type: 'text', text: JSON.stringify(result.details) }] });
  h.advance(3 * MINUTE);
  h.native.session(result.details.childSessionKey).hasActiveRun = false;
  assert.ok((await before(ctx(1))).params);
  await after(ctx(1), { content: [{ type: 'text', text: '{' }] });
  assert.ok((await before()).params);
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
    assert.match((await before(ctx(0, 'concurrent'))).blockReason, /invocation is pending/);
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
  assert.match((await before(ctx(1))).blockReason, /invocation is pending/);
  slow.resume();
  assert.ok((await callback).params);
  assert.match((await before(ctx(1))).blockReason, /invocation is pending/);
});

test('reload startOver preserves unfinished invocation and matching old hook records in the new runtime', async (t) => {
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
  assert.match((await before(ctx(1), params, other.hooks)).blockReason, /invocation is pending/);
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
  assert.match((await before(ctx(1), params, other.hooks)).blockReason, /invocation is pending/);
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

test('a new process loses unfinished invocation serialization: restart is explicitly not a hard guarantee', async (t) => {
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

for (const target of [
  { agentId: 'OpenCode' },
  { agentId: '!!OpenCode!!' },
  { agent_id: 'OpenCode' },
  { agentId: 'OpenCode', agent_id: 'researcher' },
]) {
  test('native reader and canonicalizer cover target ' + JSON.stringify(target), async (t) => {
    const { h, before, after, accepted, ctx } = await fixture(t);
    const { agentId: _ignored, ...rest } = params;
    const input = { ...rest, ...target };
    const decisions = await Promise.all([before(ctx(), input), before(ctx(1), input)]);
    assert.equal(decisions.filter((x) => x?.params).length, 1);
    assert.equal(decisions[0].params.agentId, 'opencode');
    assert.equal(decisions[0].params.model, 'fake/model');
    assert.match(decisions[1].blockReason, /invocation is pending/);
    await after(ctx(), accepted());
    assert.match((await before(ctx(1), input)).blockReason, /limit 1/);
    h.native.fail.add('sessions.list');
    assert.match((await before(ctx(1), input)).blockReason, /Worker admission unavailable/);
  });
}
