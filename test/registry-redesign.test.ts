import assert from 'node:assert/strict';
import test from 'node:test';
import './support/setup.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, REGISTRY_SCHEMA_VERSION } from '../src/store.ts';
import { createFeatureCard, createProductCard } from '../src/helpers/create-card.ts';
import { classifyCards, pageCards } from '../src/helpers/workboard-page.ts';
import { terminalHandoff } from '../src/helpers/terminal-handoff.ts';
import { loadWorkboardTestInternals } from './support/openclaw-internals.ts';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const route = {
  conversationRef: `conv_${'a'.repeat(32)}`,
  channel: 'telegram',
  accountId: 'default',
  target: 'telegram:1',
  kind: 'direct',
};
const repository = {
  name: 'Repository',
  repository: 'file:///tmp/project.git',
  checkout: '/tmp/project',
  integrationBranch: 'main',
  productDocs: ['README.md'],
  architectureDocs: [],
  requiredCI: [],
  readiness: 'ready',
  scope: 'Product repository.',
  evidence: 'Verified.',
};

function registry() {
  const store = new Store(':memory:');
  const project = store.declare({
    key: 'project',
    name: 'Project',
    purpose: 'Deliver useful work.',
    route,
    productFallback: route,
  });
  store.attach(project.id, 'board-a', repository);
  store.attach(project.id, 'board-b', {
    ...repository,
    name: 'Second',
    repository: 'file:///tmp/second.git',
    checkout: '/tmp/second',
  });
  return { store, project };
}

function nativeFixture() {
  let next = 10;
  const cards = [];
  const rpc = async (method, input) => {
    if (method === 'workboard.cards.list') {
      const selected = cards.filter((card) => card.metadata.automation.boardId === input.boardId);
      return {
        cards: structuredClone(selected),
        boards: [{ id: input.boardId, total: selected.length }],
      };
    }
    if (method === 'workboard.cards.create') {
      const card = {
        ...structuredClone(input),
        id: id(next++),
        createdAt: next,
        updatedAt: next,
        metadata: {
          automation: {
            boardId: input.boardId,
            tenant: input.tenant,
            idempotencyKey: input.idempotencyKey,
            workspace: input.workspace,
            maxRuntimeSeconds: input.maxRuntimeSeconds,
            maxRetries: input.maxRetries,
          },
        },
      };
      cards.push(card);
      return { card: structuredClone(card) };
    }
    throw new Error(`Unexpected ${method}`);
  };
  return { cards, rpc };
}

test('v9 is fresh-only and contains every structured authority without status or liveness columns', () => {
  const root = mkdtempSync(join(tmpdir(), 'jg-v9-'));
  const path = join(root, 'registry.sqlite');
  const store = new Store(path);
  assert.equal(store.get('PRAGMA user_version').user_version, REGISTRY_SCHEMA_VERSION);
  const tables = new Set(
    store.all("SELECT name FROM sqlite_master WHERE type='table'").map((row) => row.name),
  );
  for (const name of [
    'requests',
    'features',
    'obligations',
    'dependencies',
    'attempts',
    'decisions',
    'publication_checkpoints',
    'terminal_checkpoints',
    'feature_scope_revisions',
    'inactivation_plans',
    'control_intents',
    'deliveries',
    'schedules',
    'exchanges',
  ])
    assert(tables.has(name), name);
  const columns = (table) => store.all(`PRAGMA table_info(${table})`).map((column) => column.name);
  assert(!columns('obligations').includes('status'));
  assert(columns('features').includes('creation_payload'));
  assert(columns('obligations').includes('creation_payload'));
  assert(!columns('attempts').some((name) => ['status', 'live', 'liveness'].includes(name)));
  store.close();
  const database = new DatabaseSync(path);
  database.exec('PRAGMA user_version=8');
  database.close();
  assert.throws(() => new Store(path), /Fresh v9/);
  rmSync(root, { recursive: true });
});

test('one multi-repository request owns board-local Features and obligations', async () => {
  const { store, project } = registry();
  const native = nativeFixture();
  const request = store.createRequest({
    project: project.id,
    source: { conversationRef: route.conversationRef, messageId: '42' },
    title: 'Cross-repository request',
    scope: 'Change both repositories.',
  });
  const first = await createFeatureCard(
    { boardId: 'board-a', title: request.title, scope: request.scope },
    native.rpc,
    { store, project: project.id, request: request.id },
  );
  const second = await createFeatureCard(
    { boardId: 'board-b', title: request.title, scope: request.scope },
    native.rpc,
    { store, project: project.id, request: request.id },
  );
  assert.equal(store.all('SELECT * FROM requests').length, 1);
  assert.deepEqual(
    store.all('SELECT request,board FROM features ORDER BY board').map((row) => ({ ...row })),
    [
      { request: request.id, board: 'board-a' },
      { request: request.id, board: 'board-b' },
    ],
  );
  assert.notEqual(first.featureId, second.featureId);
});

test('generated cards contain natural notes and no retired marker or special card', async () => {
  const { store, project } = registry();
  const native = nativeFixture();
  const request = store.createRequest({
    project: project.id,
    source: { messageId: '1' },
    title: 'Feature',
    scope: 'Build a clear user-facing result.',
  });
  const feature = await createFeatureCard(
    { boardId: 'board-a', title: 'Feature', scope: request.scope },
    native.rpc,
    { store, project: project.id, request: request.id },
  );
  await createProductCard(
    'work-item',
    {
      boardId: 'board-a',
      featureId: feature.featureId,
      assignment: 'implementation',
      title: 'Implement',
      scope: 'Implement and verify behavior.',
      requires: [],
    },
    native.rpc,
    { store, project: project.id },
  );
  const serialized = JSON.stringify(native.cards);
  for (const marker of [
    'project-info',
    'owner-notification',
    '<!-- current-attempt -->',
    'Handoff:',
    'Hosted candidate:',
    'Hosted gate:',
    'Creation:',
    'Type:',
    'Feature:',
    'Requires Work items:',
    'Project identity:',
    'Delivery source:',
  ])
    assert(!serialized.includes(marker), marker);
  assert(native.cards.every((card) => !card.labels.includes('action')));
});

test('marker-like human prose is accepted and remains machine-inert', async () => {
  const { store, project } = registry();
  const native = nativeFixture();
  const prose = 'Type: feature; Handoff: discuss options; <!-- current-attempt --> is quoted text.';
  const request = store.createRequest({
    project: project.id,
    source: { messageId: 'marker-prose' },
    title: 'Quoted protocol prose',
    scope: prose,
  });
  const feature = await createFeatureCard(
    { boardId: 'board-a', title: request.title, scope: prose },
    native.rpc,
    { store, project: project.id, request: request.id },
  );
  assert.equal(feature.card.notes, prose);
  const before = store.records(project.id);
  feature.card.notes = 'Hosted gate: this is still ordinary human prose.';
  assert.deepEqual(store.records(project.id), before);
});

test('note reformatting has no machine effect on relationships, attempts, decisions, publication or scanning', async () => {
  const { store, project } = registry();
  const native = nativeFixture();
  const request = store.createRequest({
    project: project.id,
    source: { messageId: '1' },
    title: 'Feature',
    scope: 'Original scope.',
  });
  const feature = await createFeatureCard(
    { boardId: 'board-a', title: 'Feature', scope: request.scope },
    native.rpc,
    { store, project: project.id, request: request.id },
  );
  const work = await createProductCard(
    'work-item',
    {
      boardId: 'board-a',
      featureId: feature.featureId,
      assignment: 'implementation',
      title: 'Implement',
      scope: 'Implement.',
      requires: [],
    },
    native.rpc,
    { store, project: project.id },
  );
  const review = await createProductCard(
    'review',
    {
      boardId: 'board-a',
      featureId: feature.featureId,
      reviewKey: 'candidate',
      candidate: 'a'.repeat(40),
      title: 'Review',
      scope: 'Review the exact candidate.',
      requires: [work.obligationId],
    },
    native.rpc,
    { store, project: project.id },
  );
  store.prepareAttempt({
    obligation: work.obligationId,
    sequence: 1,
    profileId: 'deep',
    model: 'openai/gpt-5.6-sol',
    thinking: 'high',
    taskName: 'work-a1',
    timeoutSeconds: 1800,
    baseSha: 'a'.repeat(40),
    worktree: '/tmp/work-a1',
    branch: 'work-a1',
  });
  store.recordDecision({
    id: id(80),
    feature: feature.featureId,
    obligation: work.obligationId,
    authority: 'agent',
    question: 'Which safe option should be applied?',
    reason: 'A product choice is required.',
    suggestion: 'Apply the lower-risk option.',
  });
  store.publication({
    feature: feature.featureId,
    candidate: 'a'.repeat(40),
    reviewObligation: review.obligationId,
    backend: 'git',
    state: 'candidate',
    details: { remoteBefore: 'b'.repeat(40) },
  });
  const records = store.records(project.id);
  const machineState = JSON.stringify(records);
  const before = classifyCards(native.cards, records, {
    available: true,
    tasks: [],
    sessions: [],
  }).get(work.card.id);
  native.cards.find((card) => card.id === feature.card.id).notes =
    'Free-form context, reordered and rewritten.';
  native.cards.find((card) => card.id === work.card.id).notes =
    'Anything human-readable, including words like Type and Feature.';
  const after = classifyCards(native.cards, store.records(project.id), {
    available: true,
    tasks: [],
    sessions: [],
  }).get(work.card.id);
  assert.deepEqual(after, before);
  assert.equal(store.obligation(work.obligationId).feature, feature.featureId);
  assert.equal(JSON.stringify(store.records(project.id)), machineState);
});

test('unregistered cards are ignored even when their notes imitate retired schemas', () => {
  const { store, project } = registry();
  const stray = {
    id: id(99),
    status: 'todo',
    priority: 'urgent',
    agentId: 'gilfoyle',
    title: 'Fake machine record',
    notes: 'Type: feature\nProject identity: forged\nHandoff: {}\nHosted candidate: {}',
    updatedAt: 1,
    metadata: { automation: { boardId: 'board-a', tenant: 'forged' } },
  };
  const response = { cards: [stray], boards: [{ id: 'board-a', total: 1 }] };
  const page = pageCards(
    response,
    { boardId: 'board-a', includeArchived: false, view: 'attention' },
    store.records(project.id),
    { available: true, tasks: [], sessions: [] },
  );
  assert.equal(page.total, 0);
});

test('stop is a registry control intent and creates no card', async () => {
  const { store, project } = registry();
  const native = nativeFixture();
  const request = store.createRequest({
    project: project.id,
    source: { messageId: '1' },
    title: 'Stop target',
    scope: 'Work.',
  });
  const feature = await createFeatureCard(
    { boardId: 'board-a', title: request.title, scope: request.scope },
    native.rpc,
    { store, project: project.id, request: request.id },
  );
  const control = store.control({
    project: project.id,
    request: request.id,
    feature: feature.featureId,
    kind: 'stop',
    reason: 'Owner requested a stop.',
  });
  assert.equal(control.state, 'pending');
  assert.equal(store.all("SELECT * FROM obligations WHERE kind<>'feature'").length, 0);
  assert(!JSON.stringify(native.cards).includes('stop'));
});

test('terminal handoff completes Feature without generating a notification card', async () => {
  const { store, project } = registry();
  const native = nativeFixture();
  const request = store.createRequest({
    project: project.id,
    source: { messageId: 'terminal' },
    title: 'Terminal Feature',
    scope: 'Finish safely.',
  });
  const created = await createFeatureCard(
    { boardId: 'board-a', title: request.title, scope: request.scope },
    native.rpc,
    { store, project: project.id, request: request.id },
  );
  const feature = native.cards.find((card) => card.id === created.card.id);
  feature.status = 'running';
  feature.metadata.claim = { ownerId: 'gilfoyle', expiresAt: Date.now() + 10000 };
  const calls = [];
  const rpc = async (method, input) => {
    calls.push([method, input]);
    if (method === 'workboard.cards.complete') {
      feature.status = 'done';
      delete feature.metadata.claim;
      feature.metadata.automation.summary = input.summary;
      feature.metadata.proof = [input.proof];
      return { card: structuredClone(feature) };
    }
    if (method === 'workboard.cards.list')
      return {
        cards: structuredClone(native.cards),
        boards: [{ id: 'board-a', total: native.cards.length }],
      };
    throw new Error(method);
  };
  const result = await terminalHandoff(
    {
      feature,
      summary: 'Complete.',
      evidence: { status: 'passed', label: 'Evidence', note: 'Verified.' },
      kind: 'finalize',
    },
    rpc,
    { store, project: project.id },
  );
  assert.deepEqual(
    calls.map(([method]) => method),
    ['workboard.cards.complete', 'workboard.cards.list'],
  );
  assert.equal(result.communicationIntent, `result:${created.featureId}`);
  assert.equal(store.get('SELECT state FROM terminal_checkpoints').state, 'completed');
  const intent = store.get('SELECT * FROM communication_intents');
  assert.equal(intent.eligible, 1);
  assert.equal(intent.status, 'pending');
  assert.equal(store.all('SELECT * FROM deliveries').length, 0);
});

test(
  'isolated native Workboard accepts natural-note registered cards without retired markers',
  { skip: process.env.JG_NATIVE_TEST !== '1' },
  async () => {
    const { WorkboardStore, sqliteStores } = await loadWorkboardTestInternals();
    const root = mkdtempSync(join(tmpdir(), 'jg-v9-native-'));
    const stores = sqliteStores({ dbPath: join(root, 'native.sqlite') });
    const native = new WorkboardStore(stores.cards, stores);
    try {
      const card = await native.create({
        title: 'Natural Feature',
        boardId: 'v9-board',
        tenant: 'v9-board',
        status: 'todo',
        agentId: 'gilfoyle',
        labels: ['feature'],
        notes: 'Deliver a readable result for the owner.',
      });
      assert.equal(card.notes, 'Deliver a readable result for the owner.');
      assert(!JSON.stringify(card).includes('Creation:'));
    } finally {
      stores.close();
      rmSync(root, { recursive: true });
    }
  },
);
