import test from 'node:test';
import './support/setup.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { ProjectRuntime, sourceString, orderReady } from '../src/runtime.ts';
import { controllerKey, isManagerActor } from '../src/helpers/record-contracts.ts';
import plugin from '../src/index.ts';
const a = {
  conversationRef: `conv_${'a'.repeat(32)}`,
  channel: 'telegram',
  accountId: 'default',
  target: 'telegram:100',
  kind: 'direct',
};
const b = {
  conversationRef: `conv_${'b'.repeat(32)}`,
  channel: 'discord',
  accountId: 'default',
  target: 'channel:200',
  threadId: '201',
  kind: 'channel',
};
const g = { ...a, conversationRef: `conv_${'c'.repeat(32)}`, accountId: 'gilfoyle' };
const fallbackDestinations = {
  product: { channel: a.channel, accountId: a.accountId, to: a.target, kind: 'direct' },
  engineering: { channel: g.channel, accountId: g.accountId, to: g.target, kind: 'direct' },
};
function fixture(rpc = async () => {}) {
  let now = Date.now();
  const store = new Store(':memory:', { now: () => now });
  const p = store.declare({
    key: 'source',
    name: 'Alpha',
    purpose: 'Build useful things',
    route: a,
    productFallback: a,
    engineeringFallback: g,
  });
  const rt = new ProjectRuntime(store, rpc, { fallbackDestinations, now: () => now });
  rt.requestTick = () => {};
  return { store, p, rt, advance: (n) => (now += n) };
}
test('project survives reopen without repository or model session; declaration identity is strict', () => {
  const root = mkdtempSync(join(tmpdir(), 'project-registry-')),
    path = join(root, 'db');
  let s = new Store(path);
  const p = s.declare({ key: '1', name: 'Alpha', purpose: 'Idea', route: a, productFallback: a });
  s.close();
  s = new Store(path);
  assert.equal(s.get('PRAGMA user_version').user_version, 4);
  assert.equal(s.all('SELECT * FROM communication_intents').length, 0);
  assert.equal(s.project(p.id).purpose, 'Idea');
  assert.deepEqual(s.project(p.id).boards, []);
  assert.equal(
    s.declare({ key: '1', name: 'Alpha', purpose: 'Idea', route: a, productFallback: a }).id,
    p.id,
  );
  assert.throws(() =>
    s.declare({ key: '1', name: 'Beta', purpose: 'Idea', route: a, productFallback: a }),
  );
  s.close();
  rmSync(root, { recursive: true });
});
test('independent moves preserve identity, inactive route, and strict revision', () => {
  const { store, p } = fixture();
  store.move({ key: 'm1', id: p.id, managerRole: 'product', route: b, revision: 1 });
  store.move({ key: 'm2', id: p.id, managerRole: 'engineering', route: g, revision: 2 });
  assert.equal(store.project(p.id).productConversation.conversationRef, b.conversationRef);
  assert.equal(store.project(p.id).engineeringConversation.conversationRef, g.conversationRef);
  assert.throws(() =>
    store.move({ key: 'stale', id: p.id, managerRole: 'product', route: a, revision: 1 }),
  );
  store.run("UPDATE projects SET state='inactive' WHERE id=?", p.id);
  assert.equal(store.project(p.id).productConversation.conversationRef, b.conversationRef);
});
test('late routing resolves after move and native operation identity remains stable across retry', async () => {
  const sent = [];
  const { store, p, rt } = fixture(async (m, args) => {
    sent.push({ m, args });
    return { status: 'sent', messageId: '42' };
  });
  const d = store.enqueue({ project: p.id, event: 'done', kind: 'result', message: 'Done' });
  store.move({ key: 'm', id: p.id, managerRole: 'product', route: b, revision: 1 });
  await rt.deliver(d);
  await rt.deliver(store.get('SELECT * FROM deliveries WHERE id=?', d.id));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].args.conversationRef, b.conversationRef);
  assert.equal(store.project(p.id).productConversation.conversationRef, b.conversationRef);
});
test('uncertain send reconciliation reuses exact native operation, never creates a fresh send', async () => {
  let calls = [];
  const { store, p, rt, advance } = fixture(async (m, args) => {
    calls.push(args);
    return calls.length === 1 ? { status: 'unknown' } : { status: 'sent', messageId: '43' };
  });
  const d = store.enqueue({ project: p.id, event: 'result', message: 'Result' });
  await rt.deliver(d);
  advance(60001);
  await rt.deliver(store.get('SELECT * FROM deliveries WHERE id=?', d.id));
  assert.deepEqual(calls[0], calls[1]);
});
test('bounded failure refreshes one exact address-based owner fallback without rebinding', async () => {
  const calls = [],
    fresh = { ...a, conversationRef: `conv_${'d'.repeat(32)}` };
  const { store, p, rt, advance } = fixture(async (m, args) => {
    if (m === 'conversations.list') return { conversations: [fresh] };
    calls.push(args);
    if (args.conversationRef === b.conversationRef) throw Error('denied');
    return { status: 'sent', messageId: '44' };
  });
  store.move({ key: 'm', id: p.id, managerRole: 'product', route: b, revision: 1 });
  const d = store.enqueue({
    project: p.id,
    event: 'question',
    kind: 'question',
    message: 'Which repository?',
    fallbackMessage: 'I could not reach the project chat. Which repository should I use?',
  });
  for (let i = 0; i < 4; i++) {
    await rt.deliver(store.get('SELECT * FROM deliveries WHERE id=?', d.id));
    advance(60001);
  }
  assert.equal(calls.filter((c) => c.conversationRef === fresh.conversationRef).length, 1);
  assert.equal(
    calls.find((c) => c.conversationRef === fresh.conversationRef).message,
    'I could not reach the project chat. Which repository should I use?',
  );
  assert.equal(store.project(p.id).productFallback.conversationRef, fresh.conversationRef);
  assert.equal(store.project(p.id).productConversation.conversationRef, b.conversationRef);
  assert.equal(store.get('SELECT status FROM deliveries WHERE id=?', d.id).status, 'fallback-sent');
});
test('configured engineering fallback resolves by native address on first need', async () => {
  const calls = [];
  const { store, p, rt, advance } = fixture(async (m, args) => {
    if (m === 'conversations.list') return { conversations: [g] };
    calls.push(args);
    if (args.conversationRef === b.conversationRef) throw Error('denied');
    return { status: 'sent', messageId: 'engineering-fallback' };
  });
  store.run('UPDATE projects SET engineering_fallback=NULL WHERE id=?', p.id);
  const d = store.enqueue({
    project: p.id,
    event: 'engineering-copy',
    kind: 'copy',
    managerRole: 'engineering',
    message: 'Engineering update',
    route: b,
  });
  for (let i = 0; i < 4; i++) {
    await rt.deliver(store.get('SELECT * FROM deliveries WHERE id=?', d.id));
    advance(60001);
  }
  assert.equal(calls.filter((c) => c.conversationRef === g.conversationRef).length, 1);
  assert.equal(store.project(p.id).engineeringFallback.conversationRef, g.conversationRef);
  assert.equal(store.get('SELECT status FROM deliveries WHERE id=?', d.id).status, 'fallback-sent');
});
test('fallback destination resolution rejects missing and ambiguous native addresses', async () => {
  const duplicate = { ...a, conversationRef: `conv_${'e'.repeat(32)}` },
    { rt } = fixture(async () => ({ conversations: [a, duplicate] }));
  await assert.rejects(rt.fallbackRoute('product'), /unavailable or ambiguous/);
  delete rt.fallbackDestinations.product;
  await assert.rejects(rt.fallbackRoute('product'), /not configured/);
});
test('additional notification consumes only named event and remains additive', async () => {
  const calls = [];
  const { store, p, rt } = fixture(async (m, args) => {
    calls.push(args);
    return { status: 'sent', messageId: String(calls.length) };
  });
  store.copy({ project: p.id, event: 'pr:3', managerRole: 'engineering', route: g });
  await rt.deliver(store.enqueue({ project: p.id, event: 'other', message: 'Other' }));
  assert.equal(store.all('SELECT * FROM copies WHERE consumed IS NULL').length, 1);
  await rt.deliver(store.enqueue({ project: p.id, event: 'pr:3', message: 'PR finished' }));
  const copy = store.get("SELECT * FROM deliveries WHERE kind='copy'");
  await rt.deliver(copy);
  await rt.deliver(store.get('SELECT * FROM deliveries WHERE id=?', copy.id));
  assert.equal(calls.filter((c) => c.agentId === 'gilfoyle').length, 1);
  assert.equal(store.project(p.id).engineeringConversation, null);
});
test('inactive notification pauses, reactivation skips missed schedule occurrences and recovers pending', async () => {
  let sends = 0;
  const { store, p, rt, advance } = fixture(async () => {
    sends++;
    return { status: 'sent', messageId: '45' };
  });
  const d = store.enqueue({ project: p.id, event: 'pending', message: 'Pending' });
  const s = store.schedule({
    project: p.id,
    spec: { scope: 'check' },
    next: Date.now() - 300000,
    intervalMs: 60000,
  });
  store.run("UPDATE projects SET state='inactive' WHERE id=?", p.id);
  await rt.deliver(d);
  assert.equal(sends, 0);
  advance(600000);
  store.reactivate(p.id, rt.now());
  assert(store.get('SELECT next FROM schedules WHERE id=?', s.id).next > rt.now());
  await rt.deliver(d);
  assert.equal(sends, 1);
});
test('multiple projects share chats without sharing repositories or changing preferred routes', () => {
  const { store, p } = fixture();
  const q = store.declare({
    key: 'second',
    name: 'Beta',
    purpose: 'Independent',
    route: a,
    productFallback: a,
  });
  store.attach(p.id, 'repo-a', 'file:///a');
  store.attach(p.id, 'repo-b', 'file:///b');
  store.attach(q.id, 'repo-c', 'file:///c');
  assert.equal(store.project(p.id).boards.length, 2);
  assert.throws(() => store.attach(q.id, 'repo-a', 'file:///a'));
  assert.equal(store.list().length, 2);
});
test('purpose controller separates project Features and leaves non-project cards on the canonical manager', () => {
  const id = '10000000-0000-4000-8000-000000000001',
    f = { id, notes: `Type: feature\nProject identity: 20000000-0000-4000-8000-000000000002` },
    w = { id: 'work', notes: 'Type: work-item', metadata: { automation: { tenant: id } } };
  assert.equal(controllerKey([f, w], w), `agent:gilfoyle:jarvis-gilfoyle:${id}`);
  assert.equal(controllerKey([{ ...f, notes: 'Type: feature' }, w], w), 'agent:gilfoyle:main');
  assert.notEqual(controllerKey([f, w], w, 'main'), controllerKey([f, w], w));
});
test('inactivation rejects omitted dispositions and incomplete inventory', async () => {
  const { store, p, rt } = fixture(async () => ({ cards: [], total: 0 }));
  store.schedule({ project: p.id, spec: { scope: 'check' }, next: Date.now() + 60000 });
  await assert.rejects(
    rt.operation(
      'inactivate',
      { projectId: p.id, confirmed: true, revision: 1, dispositions: {} },
      { agentId: 'main', operator: true },
    ),
  );
  assert.equal(store.project(p.id).state, 'active');
});

test('inactivation requires and honors a pending communication-intent disposition', async () => {
  const { store, p, rt } = fixture(async () => ({ cards: [], total: 0 }));
  const intent = store.requestCommunication({
    project: p.id,
    event: 'blocker:inactivation',
    scope: '10000000-0000-4000-8000-000000000001',
    kind: 'blocker',
    facts: { condition: 'coordination-stalled' },
  });
  await assert.rejects(
    rt.operation(
      'inactivate',
      { projectId: p.id, confirmed: true, revision: 2, dispositions: {} },
      { agentId: 'main', operator: true },
    ),
    /Every unfinished/,
  );
  await rt.operation(
    'inactivate',
    {
      projectId: p.id,
      confirmed: true,
      revision: 2,
      dispositions: { [intent.id]: 'stop' },
    },
    { agentId: 'main', operator: true },
  );
  assert.equal(store.project(p.id).state, 'inactive');
  assert.equal(
    store.get('SELECT status FROM communication_intents WHERE id=?', intent.id).status,
    'dismissed',
  );
});

test('inactivation fails if a communication intent appears after inventory', async () => {
  const { store, p, rt } = fixture(async () => ({ cards: [], total: 0 }));
  rt.hasActiveExecution = async () => {
    store.requestCommunication({
      project: p.id,
      event: 'blocker:concurrent',
      scope: '10000000-0000-4000-8000-000000000001',
      kind: 'blocker',
      facts: { condition: 'concurrent-recovery' },
    });
    return false;
  };
  await assert.rejects(
    rt.operation(
      'inactivate',
      { projectId: p.id, confirmed: true, revision: 1, dispositions: {} },
      { agentId: 'main', operator: true },
    ),
    /Project changed/,
  );
  assert.equal(store.project(p.id).state, 'active');
  assert.equal(store.all("SELECT * FROM communication_intents WHERE status='pending'").length, 1);
});

test('draining tracks the delivery produced from a finish communication intent', async () => {
  const { store, p, rt } = fixture();
  const scope = '10000000-0000-4000-8000-000000000001';
  const intent = store.requestCommunication({
    project: p.id,
    event: `blocker:${scope}`,
    scope,
    kind: 'blocker',
    facts: { condition: 'coordination-stalled' },
  });
  await rt.operation(
    'inactivate',
    {
      projectId: p.id,
      confirmed: true,
      revision: 2,
      dispositions: { [intent.id]: 'finish' },
    },
    { agentId: 'main', operator: true },
  );
  const exchange = store.exchange(p.id, scope, 'product');
  const decision = await rt.operation(
    'communication-decision',
    {
      projectId: p.id,
      event: intent.event,
      notify: true,
      reason: 'The owner should know.',
      message: 'I retained the request and need more time to resolve its coordination state.',
    },
    { agentId: 'main', sessionKey: exchange.session },
  );
  store.run('UPDATE exchanges SET closed=? WHERE id=?', rt.now(), exchange.id);
  store.run(
    "UPDATE deliveries SET status='retry',due=? WHERE id=?",
    rt.now() + 60000,
    decision.deliveryId,
  );
  await rt.tick();
  assert.equal(store.project(p.id).state, 'draining');
});

test('nearby milestones share a late-routed receipt without losing their event identities', async () => {
  const sent = [];
  const { store, p, rt, advance } = fixture(async (m, args) => {
    sent.push(args);
    return { status: 'sent', messageId: '55' };
  });
  const one = store.enqueue({
      project: p.id,
      event: 'started',
      message: 'Engineering started',
      due: rt.now() + 45000,
    }),
    two = store.enqueue({
      project: p.id,
      event: 'reviewed',
      message: 'Review passed',
      due: rt.now() + 45000,
    });
  advance(46000);
  rt.batchMilestones(store.project(p.id));
  store.move({ key: 'm', id: p.id, managerRole: 'product', route: b, revision: 1 });
  await rt.deliver(store.get("SELECT * FROM deliveries WHERE kind='milestone-batch'"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].conversationRef, b.conversationRef);
  assert(
    sent[0].message.includes('Engineering started') && sent[0].message.includes('Review passed'),
  );
  for (const d of [one, two])
    assert.equal(store.get('SELECT status FROM deliveries WHERE id=?', d.id).status, 'sent');
});

test('native metadata tokens prevent a queued message replacing an in-flight source', async () => {
  const { store, rt } = fixture(async () => ({ conversations: [a] }));
  const session = 'agent:main:telegram:direct:100';
  const one = { route: a, sessionKey: session, sourceToken: 'one', messageId: '1' },
    two = { ...one, sourceToken: 'two', messageId: '2' };
  store.source('token:one', one);
  store.source('token:two', two);
  store.source(session, two);
  const actual = await rt.current({ agentId: 'main', sessionKey: session, sourceToken: 'one' });
  assert.equal(actual.messageId, '1');
  await assert.rejects(rt.current({ agentId: 'main', sessionKey: session }), /sourceToken/);
  await assert.rejects(
    rt.current({ agentId: 'main', sessionKey: 'other', sourceToken: 'one' }),
    /different conversation/,
  );
});

test('native-controller admission failures request Jarvis composition without sending static prose', async () => {
  const { store, p, rt, advance } = fixture(async () => {
    throw Error('native unavailable');
  });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(rt.dispatch(store.project(p.id), 'feature', 'engineering', ['card']));
    advance(120001);
  }
  await rt.dispatch(store.project(p.id), 'feature', 'engineering', ['card']);
  assert.equal(store.all("SELECT * FROM deliveries WHERE kind='blocker'").length, 0);
  const intents = store.all("SELECT * FROM communication_intents WHERE kind='blocker'");
  assert.equal(intents.length, 1);
  assert.equal(intents[0].status, 'pending');
  assert.equal(JSON.parse(intents[0].facts).condition, 'coordination-stalled');
  assert.equal(
    store.get("SELECT attempts FROM exchanges WHERE scope='feature' AND role='engineering'")
      .attempts,
    3,
  );
});

test('Jarvis turns structured communication facts into the only user-facing message', async () => {
  const { store, p, rt } = fixture();
  const scope = '10000000-0000-4000-8000-000000000001';
  store.requestCommunication({
    project: p.id,
    event: `blocker:${scope}`,
    scope,
    kind: 'blocker',
    facts: { condition: 'coordination-stalled', obligationRetained: true },
  });
  const e = store.exchange(p.id, scope, 'product');
  const result = await rt.operation(
    'communication-decision',
    {
      projectId: p.id,
      event: `blocker:${scope}`,
      notify: true,
      reason: 'The owner should know what is waiting.',
      message:
        'I found a coordination issue and kept the request safely recorded while I investigate it.',
    },
    { agentId: 'main', sessionKey: e.session },
  );
  assert.equal(result.status, 'composed');
  const delivery = store.get('SELECT * FROM deliveries WHERE id=?', result.deliveryId);
  assert.equal(
    delivery.text,
    'I found a coordination issue and kept the request safely recorded while I investigate it.',
  );
  assert(!delivery.text.includes('bounded attempts'));
});

test('controller admission validates complete native scope and admits only one turn per role', async () => {
  const calls = [];
  let active = [];
  const { store, p, rt } = fixture(async (m, args) => {
    calls.push({ m, args });
    if (m === 'sessions.list') return { sessions: active, hasMore: false };
    if (m === 'workboard.cards.list') return { cards: [], boards: [] };
    if (m === 'sessions.create') return { key: args.key };
    if (m === 'agent') {
      active = [{ key: args.sessionKey, status: 'running', hasActiveRun: true }];
      return { runId: args.idempotencyKey, status: 'accepted' };
    }
    throw Error(m);
  });
  await rt.dispatch(p, 'scope-a', 'engineering', ['card-a'], {
    'card-a': 'notification-repair',
  });
  const q = store.declare({
    key: 'q',
    name: 'Other',
    purpose: 'Other project',
    route: a,
    productFallback: a,
  });
  await rt.dispatch(q, 'scope-b', 'engineering', ['card-b']);
  assert.equal(calls.filter((c) => c.m === 'agent').length, 1);
  assert(calls.some((c) => c.m === 'workboard.cards.list'));
  assert(
    calls.find((c) => c.m === 'agent').args.message.includes('"card-a":"notification-repair"'),
  );
});

test('receipt-backed settlement repairs only notification bookkeeping and never repeats a send or completion', async () => {
  const calls = [];
  const featureId = '10000000-0000-4000-8000-000000000001',
    noticeId = '20000000-0000-4000-8000-000000000002';
  const cards = [
    {
      id: featureId,
      status: 'done',
      metadata: {
        automation: { summary: 'Outcome: delivered. Tested.' },
        proof: [{ id: 'feature-proof', status: 'passed' }],
      },
    },
    {
      id: noticeId,
      agentId: 'main',
      status: 'done',
      updatedAt: 1,
      notes: `Type: action\nKind: owner-notification\nFeature: ${featureId}`,
      metadata: {
        automation: {
          idempotencyKey: `action:${featureId}:owner-notification`,
          tenant: featureId,
          summary: 'Old natural summary',
        },
        failureCount: 2,
        proof: [
          { id: 'original-proof', status: 'passed', note: 'Actual delivery previously reported' },
        ],
      },
    },
  ];
  const { store, p, rt } = fixture(async (m, args) => {
    calls.push(m);
    const n = cards[1];
    if (m === 'workboard.cards.proof')
      n.metadata.proof.push({
        id: 'receipt-proof',
        status: args.status,
        label: args.label,
        note: args.note,
      });
    else if (m === 'workboard.cards.update') {
      assert.equal(args.expectedUpdatedAt, n.updatedAt);
      if (args.patch.metadata.automation)
        Object.assign(n.metadata.automation, args.patch.metadata.automation);
      if (args.patch.metadata.failureCount !== undefined)
        n.metadata.failureCount = args.patch.metadata.failureCount;
    } else throw Error(m);
    n.updatedAt++;
    return { card: structuredClone(n) };
  });
  rt.cards = async () => structuredClone(cards);
  const d = store.enqueue({
    project: p.id,
    event: `result:${featureId}`,
    kind: 'result',
    message: 'Result',
  });
  store.run(
    "UPDATE deliveries SET status='sent',route=?,receipt=? WHERE id=?",
    JSON.stringify(a),
    JSON.stringify({
      status: 'sent',
      messageId: '600',
      conversationRef: a.conversationRef,
      channel: 'telegram',
    }),
    d.id,
  );
  await rt.settleNotice(store.get('SELECT * FROM deliveries WHERE id=?', d.id));
  await rt.settleNotice(store.get('SELECT * FROM deliveries WHERE id=?', d.id));
  assert.equal(cards[1].metadata.proof.length, 2);
  assert.equal(cards[1].metadata.proof[0].id, 'original-proof');
  assert.equal(cards[1].metadata.failureCount, 2);
  assert(cards[1].metadata.automation.summary.includes('600'));
  assert(!calls.includes('conversations.send') && !calls.includes('workboard.cards.complete'));
});

test('recurring copies bind actual schedule occurrences and deduplicate each one', async () => {
  const { store, p, rt } = fixture();
  const schedule = '30000000-0000-4000-8000-000000000003';
  store.schedule({
    id: schedule,
    project: p.id,
    spec: { scope: 'read-only report' },
    next: rt.now() + 60000,
    intervalMs: 60000,
  });
  store.copy({
    project: p.id,
    event: `schedule:${schedule}:result`,
    managerRole: 'engineering',
    route: g,
    recurring: true,
  });
  rt.cards = async () => [
    { id: 'f1', notes: `Source message: ${schedule}-1000` },
    { id: 'f2', notes: `Source message: ${schedule}-2000` },
  ];
  const one = store.enqueue({
      project: p.id,
      event: 'result:f1',
      kind: 'result',
      message: 'First report',
    }),
    two = store.enqueue({
      project: p.id,
      event: 'result:f2',
      kind: 'result',
      message: 'Second report',
    });
  await rt.processCopies(one);
  await rt.processCopies(one);
  await rt.processCopies(two);
  assert.equal(store.all("SELECT * FROM deliveries WHERE kind='copy'").length, 2);
});

test('repository-less intake persists one native Feature and full conversation identity prevents message-ID collisions', async () => {
  const boards = [],
    cards = [];
  let creates = 0;
  const { store, p, rt } = fixture(async (m, args) => {
    if (m === 'workboard.boards.list') return { boards };
    if (m === 'workboard.boards.upsert') {
      boards.push({ id: args.id, total: 0 });
      return { board: boards.at(-1) };
    }
    if (m === 'workboard.cards.list')
      return structuredClone({
        cards,
        boards: boards.map((b) => ({
          ...b,
          total: cards.filter((c) => c.metadata.automation.boardId === b.id).length,
        })),
      });
    if (m === 'workboard.cards.create') {
      const id = `40000000-0000-4000-8000-${String(++creates).padStart(12, '0')}`;
      const c = {
        ...args,
        id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {
          automation: {
            boardId: args.boardId,
            tenant: args.tenant,
            idempotencyKey: args.idempotencyKey,
            workspace: args.workspace,
            maxRuntimeSeconds: args.maxRuntimeSeconds,
            maxRetries: args.maxRetries,
          },
        },
      };
      cards.push(c);
      return { card: structuredClone(c) };
    }
    throw Error(m);
  });
  const input = {
    title: 'Build after repository setup',
    scope: 'Implement after the repository scope is selected.',
  };
  const one = await rt.intake(p, input, { route: a, messageId: '42' }),
    retry = await rt.intake(store.project(p.id), input, { route: a, messageId: '42' }),
    other = await rt.intake(store.project(p.id), input, { route: b, messageId: '42' });
  assert.deepEqual(one.features, retry.features);
  assert.notDeepEqual(one.features, other.features);
  assert.equal(creates, 2);
  assert(cards.every((c) => c.notes.includes('Repository scope: pending')));
  assert.equal(store.project(p.id).productConversation.conversationRef, a.conversationRef);
  await assert.rejects(
    rt.operation(
      'intake',
      { projectId: p.id, ...input, implementationIntent: false },
      { agentId: 'main', operator: true },
    ),
  );
  assert.equal(creates, 2);
});

test('source serialization accommodates supported channel punctuation without delimiter collisions', () => {
  const one = sourceString({
      channel: 'matrix',
      accountId: 'main',
      target: '!room:example.org',
      threadId: 'a/b',
    }),
    two = sourceString({
      channel: 'matrix',
      accountId: 'main',
      target: '%21room:example.org',
      threadId: 'a/b',
    });
  assert(one.includes('recipient=%21room:example.org'));
  assert(one.endsWith('thread=a%2Fb'));
  assert.notEqual(one, two);
});

test('explicit recovery resets closed and open retry budgets without directly reopening execution', async () => {
  const { store, p, rt } = fixture();
  const closed = store.exchange(p.id, 'closed-scope', 'engineering');
  const open = store.exchange(p.id, 'open-scope', 'product');
  store.run(
    'UPDATE exchanges SET attempts=3,lastDispatch=?,closed=? WHERE id=?',
    20,
    30,
    closed.id,
  );
  store.run('UPDATE exchanges SET attempts=2,lastDispatch=? WHERE id=?', 20, open.id);
  const result = await rt.operation(
    'recover',
    { projectId: p.id },
    { agentId: 'main', operator: true },
  );
  assert.equal(result.executionRestarted, false);
  const rows = store.all('SELECT id,attempts,lastDispatch,closed FROM exchanges ORDER BY id');
  assert(rows.every((row) => row.attempts === 0 && row.lastDispatch === 0));
  assert(rows.find((row) => row.id === closed.id).closed);
});

test('temporary context cleanup preserves durable conclusions and retry budget across context recreation', async () => {
  const { store, p, rt } = fixture(async (m, args) =>
    m === 'sessions.list'
      ? {
          sessions: [{ key: args.search, sessionId: 'session-id', hasActiveRun: false }],
          hasMore: false,
        }
      : m === 'jarvis-gilfoyle.session.cleanup'
        ? { removedEntries: 1, archivedTranscriptArtifacts: 0 }
        : Promise.reject(Error(m)),
  );
  const e = store.exchange(p.id, 'feature', 'engineering');
  store.run('UPDATE exchanges SET attempts=2 WHERE id=?', e.id);
  await rt.operation(
    'conclude',
    {
      projectId: p.id,
      conclusion: 'The native obligation and decision remain recorded; await the next checkpoint.',
    },
    { agentId: 'gilfoyle', sessionKey: e.session },
  );
  await rt.cleanup(p, [
    { id: 'feature', notes: 'Type: feature', status: 'todo', metadata: { automation: {} } },
  ]);
  assert(store.get('SELECT closed FROM exchanges WHERE id=?', e.id).closed);
  const next = store.exchange(p.id, 'feature', 'engineering');
  assert.equal(next.attempts, 2);
  assert.equal(next.conclusion, null);
  assert.equal(store.all("SELECT * FROM receipts WHERE key LIKE 'conclusion:%'").length, 1);
});

test('visible context projects only actual sent receipts for the requested conversation', () => {
  const { store, p, rt } = fixture();
  for (const [event, route, status, messageId] of [
    ['one', a, 'sent', '1'],
    ['batch-member', a, 'sent', '1'],
    ['other-chat', b, 'sent', '2'],
    ['unknown', a, 'unknown', '3'],
  ]) {
    const d = store.enqueue({ project: p.id, event, message: `Visible ${event}` });
    store.run(
      'UPDATE deliveries SET status=?,route=?,receipt=? WHERE id=?',
      status,
      JSON.stringify(route),
      JSON.stringify({ status, messageId }),
      d.id,
    );
  }
  const view = rt.visibleContext('main', a.conversationRef);
  assert.equal(view.messages.length, 1);
  assert.equal(view.messages[0].messageId, '1');
  assert(view.coverage.includes('not complete channel history'));
});

for (const [channel, target, inbound, threadId] of [
  ['telegram', 'telegram:100', 'telegram:100:topic:77', '77'],
  ['discord', 'channel:100', 'discord:channel:100', undefined],
  ['matrix', 'matrix:!room:example.org', '!room:example.org', undefined],
])
  test(`first ${channel} source retains message identity while native route registration catches up`, async () => {
    const route = { ...a, channel, target, ...(threadId ? { threadId } : {}) },
      session = `agent:main:${channel}:test`;
    const { store, rt } = fixture(async () => ({ conversations: [route] }));
    const source = {
      sessionKey: session,
      sourceToken: 'first',
      senderId: 'owner',
      messageId: '401',
      raw: { channel, accountId: 'default', conversationId: inbound, threadId },
    };
    store.source('token:first', source);
    const result = await rt.current({
      agentId: 'main',
      sessionKey: session,
      sourceToken: 'first',
      requesterSenderId: 'owner',
    });
    assert.equal(result.messageId, '401');
    assert.equal(result.route.target, target);
    await assert.rejects(
      rt.current({
        agentId: 'main',
        sessionKey: session,
        sourceToken: 'first',
        requesterSenderId: 'other',
      }),
      /different sender/,
    );
  });

test('supported hooks suppress internal transport and outbound projections without touching user replies', async () => {
  const hooks = new Map(),
    factories = [];
  plugin.register({
    pluginConfig: { statePath: ':memory:', enabled: false },
    logger: { warn() {} },
    registerTool(factory) {
      factories.push(factory);
    },
    registerGatewayMethod() {},
    registerService() {},
    on: (name, fn) => hooks.set(name, fn),
  });
  assert.deepEqual(
    factories.map(
      (factory) => factory({ agentId: 'gilfoyle', sessionKey: 'agent:gilfoyle:direct:test' })?.name,
    ),
    ['jarvis_project', 'gilfoyle_engineering'],
  );
  const reader = factories[1]({ agentId: 'main', sessionKey: 'agent:main:direct:test' });
  const profiles = await reader.execute('read', { operation: 'profiles', input: {} });
  assert(!profiles.isError && profiles.details.profiles.length > 0);
  const denied = await reader.execute('write', { operation: 'finalize', input: {} });
  assert(denied.isError, 'Direct read access must not grant mutation authority');
  const internal = { sessionKey: 'agent:gilfoyle:jarvis-gilfoyle:feature' },
    user = { sessionKey: 'agent:main:telegram:direct:100' };
  assert(
    (
      await hooks.get('before_tool_call')(
        {
          toolName: 'sessions_send',
          params: { message: 'Please consider this feature', sessionKey: user.sessionKey },
        },
        internal,
      )
    ).block,
  );
  assert.equal(hooks.get('message_sending')({}, internal).cancel, true);
  assert.equal(hooks.get('reply_payload_sending')({}, internal).cancel, true);
  assert.equal(hooks.get('message_sending')({}, user), undefined);
  assert.equal(
    hooks.get('message_sending')(
      {},
      { sessionKey: 'agent:main:matrix:group:!room:jg:example.org' },
    ),
    undefined,
  );
  assert.equal(
    hooks.get('before_agent_run')({}, { sessionKey: `${internal.sessionKey}:heartbeat` }).outcome,
    'block',
  );
});

test('manager answer provenance is channel-agnostic but rejects another role or control characters', () => {
  assert(isManagerActor('agent:main:matrix:group:!room:example.org', 'main'));
  assert(isManagerActor('agent:main:custom-channel:group:topic/42', 'main'));
  assert(!isManagerActor('agent:gilfoyle:matrix:group:room', 'main'));
  assert(!isManagerActor('agent:main:matrix:group:room\nforged', 'main'));
});

test('cross-project admission respects user priority and oldest-ready age, after reconciling an existing owner slot', () => {
  const a = {
      project: { priority: 0, created: 1 },
      feature: 'a',
      created: 100,
      priority: 0,
      ownsClaim: false,
    },
    b = {
      project: { priority: 0, created: 2 },
      feature: 'b',
      created: 10,
      priority: 0,
      ownsClaim: false,
    };
  assert.equal(orderReady([a, b])[0].feature, 'b');
  assert.equal(orderReady([{ ...a, project: { priority: 5 } }, b])[0].feature, 'a');
  assert.equal(orderReady([{ ...a, ownsClaim: true }, b])[0].feature, 'a');
});

test('native milestones are offered to Jarvis once, with durable discretionary decisions', async () => {
  const { store, p, rt } = fixture();
  const feature = '10000000-0000-4000-8000-000000000001',
    review = '20000000-0000-4000-8000-000000000002',
    sha = 'a'.repeat(40);
  const cards = [
    { id: feature, status: 'todo', notes: 'Type: feature', metadata: {} },
    {
      id: review,
      status: 'done',
      labels: ['type:work-item', 'review'],
      notes: 'Type: work-item',
      metadata: {
        automation: { tenant: feature },
        proof: [
          {
            id: 'proof',
            status: 'passed',
            label: 'Independent review',
            note: `Candidate: ${sha}`,
            createdAt: 1,
          },
        ],
      },
    },
  ];
  rt.cards = async () => cards;
  const candidate = rt.milestoneCandidates(p, cards)[0];
  assert.equal(candidate.kind, 'review-passed');
  const e = store.exchange(p.id, feature, 'product');
  const input = {
    projectId: p.id,
    event: candidate.event,
    notify: true,
    reason: 'A material reviewed candidate',
    message: 'Independent review passed.',
  };
  const one = await rt.operation('milestone-decision', input, {
    agentId: 'main',
    sessionKey: e.session,
  });
  await rt.operation('milestone-decision', input, { agentId: 'main', sessionKey: e.session });
  assert(one.notified);
  assert.equal(store.all('SELECT * FROM deliveries').length, 1);
  assert.equal(rt.milestoneCandidates(p, cards).length, 0);
});

test('terminal results supersede undecided progress and coalesce already-selected nearby progress', async () => {
  const { store, p, rt } = fixture();
  const feature = '10000000-0000-4000-8000-000000000001',
    sha = 'a'.repeat(40),
    cards = [
      { id: feature, status: 'done', notes: 'Type: feature', metadata: {} },
      {
        id: 'review',
        status: 'done',
        labels: ['review'],
        notes: 'Type: work-item',
        metadata: {
          automation: { tenant: feature },
          proof: [{ status: 'passed', label: 'Independent review', note: `Candidate: ${sha}` }],
        },
      },
    ];
  rt.cards = async () => cards;
  const e = store.exchange(p.id, feature, 'product');
  const result = await rt.operation(
    'milestone-decision',
    { projectId: p.id, event: `review:${feature}:${sha}`, notify: true, message: 'Old progress' },
    { agentId: 'main', sessionKey: e.session },
  );
  assert.equal(result.notified, false);
  assert.equal(store.all('SELECT * FROM deliveries').length, 0);
  store.enqueue({
    project: p.id,
    event: 'start',
    kind: 'milestone',
    message: 'Started',
    due: rt.now() + 45000,
  });
  store.enqueue({ project: p.id, event: 'result', kind: 'result', message: 'Completed' });
  rt.batchMilestones(p);
  assert.equal(store.all("SELECT * FROM deliveries WHERE kind='milestone-batch'").length, 1);
  assert.equal(store.all("SELECT * FROM deliveries WHERE status='batched'").length, 2);
});

test('internal project tools cannot accidentally read or notify a different project', async () => {
  const { store, p, rt } = fixture(),
    other = store.declare({
      key: 'other',
      name: 'Other',
      purpose: 'Separate',
      route: b,
      productFallback: a,
    }),
    e = store.exchange(p.id, 'scope', 'product');
  await assert.rejects(
    rt.operation('summary', { projectId: other.id }, { agentId: 'main', sessionKey: e.session }),
    /cross project/,
  );
  assert.equal(
    (await rt.operation('list', {}, { agentId: 'main', sessionKey: e.session })).length,
    1,
  );
});
