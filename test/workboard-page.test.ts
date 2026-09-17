import assert from 'node:assert/strict';
import test from 'node:test';
import './support/setup.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PAGE_CANDIDATE_LIMIT,
  PAGE_OUTPUT_BYTES,
  pageCards,
  validateQuery,
} from '../src/helpers/workboard-page.ts';
import { loadWorkboardTestInternals } from './support/openclaw-internals.ts';

const query = { agentId: 'gilfoyle', includeArchived: false };
const value = (page, row, field) => row[page.fields.indexOf(field)];
function fixture(count) {
  return {
    boards: [{ id: 'first', total: count }],
    cards: Array.from({ length: count }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      title: i === 200 ? 'Cancellation beyond the old limit' : 'Pending work',
      status: 'todo',
      priority: i === 200 ? 'urgent' : 'normal',
      agentId: 'gilfoyle',
      updatedAt: 1,
      metadata: { automation: { boardId: 'first', tenant: 'feature-one' } },
    })).reverse(),
  };
}

for (const count of [0, 32, 96, 199, 200, 201, 1001]) {
  test(`enumerates all ${count} cards with truthful continuation`, () => {
    const response = fixture(count);
    const before = JSON.stringify(response);
    const seen = [];
    let q = query;
    for (;;) {
      const page = pageCards(response, q);
      assert.equal(page.total, count);
      assert(page.cards.length <= PAGE_CANDIDATE_LIMIT);
      assert(Buffer.byteLength(`${JSON.stringify(page)}\n`) <= PAGE_OUTPUT_BYTES);
      assert.deepEqual(
        page.cards.map((row) => value(page, row, 'id')),
        response.cards
          .map((card) => card.id)
          .sort()
          .slice(seen.length, seen.length + page.cards.length),
      );
      seen.push(...page.cards.map((row) => value(page, row, 'id')));
      if (!page.hasMore) {
        assert.equal(page.nextAfter, null);
        break;
      }
      assert.equal(page.nextAfter, seen.at(-1));
      q = { ...query, after: page.nextAfter, membership: page.membership };
    }
    assert.equal(seen.length, count);
    assert.equal(new Set(seen).size, count);
    assert.deepEqual(seen, response.cards.map((card) => card.id).sort());
    const membership = q.membership ?? pageCards(response, query).membership;
    assert.equal(typeof membership, 'string');
    assert(membership.length > 0);
    assert.equal(JSON.stringify(response), before);
  });
}

test('filters across boards and includes archived required evidence when requested', () => {
  const response = fixture(201);
  response.cards[0].metadata.archivedAt = 2;
  response.cards[1].agentId = 'main';
  response.cards[2].metadata.automation.boardId = 'second';
  response.boards = [
    { id: 'first', total: 200 },
    { id: 'second', total: 1 },
  ];
  assert.equal(pageCards(response, query).total, 199);
  assert.equal(pageCards(response, { ...query, includeArchived: true }).total, 200);
  const scoped = {
    cards: response.cards.filter((c) => c.metadata.automation.boardId === 'first'),
    boards: response.boards,
  };
  assert.equal(
    pageCards(scoped, { boardId: 'first', tenant: 'feature-one', includeArchived: true }).total,
    200,
  );
});

test('membership changes invalidate a continuation, content changes do not hide cards', () => {
  const response = fixture(201);
  const page = pageCards(response, query);
  const next = { ...query, after: page.nextAfter, membership: page.membership };
  response.cards[0].updatedAt++;
  assert.equal(pageCards(response, next).total, 201);
  response.cards[0].metadata.archivedAt = 2;
  assert.throws(() => pageCards(response, next), /membership changed/);
});

test('non-view pages admit 96 candidates and include the console newline in the bound', () => {
  const response = fixture(96);
  for (const card of response.cards) card.title = '\u0000'.repeat(200);
  const page = pageCards(response, query);
  assert.equal(page.cards.length, 96);
  assert(Buffer.byteLength(`${JSON.stringify(page)}\n`) <= 12000);
});

test('an urgent card beyond the old first200 is discovered across bounded ticks', () => {
  const response = fixture(201);
  response.cards.reverse();
  const urgent = response.cards[200];
  assert.equal(urgent.priority, 'urgent');
  assert(!response.cards.slice(0, 200).some((card) => card.id === urgent.id));
  let q = query;
  const seen = [];
  let ticks = 0;
  let complete = false;
  while (!complete) {
    ticks++;
    for (let budget = 0; budget < 4; budget++) {
      const page = pageCards(response, q);
      seen.push(...page.cards.map((row) => value(page, row, 'id')));
      if (!page.hasMore) {
        complete = true;
        break;
      }
      q = { ...query, after: page.nextAfter, membership: page.membership };
    }
    if (!complete) {
      // Serialize only existing-footer continuation, not the cards or a new ledger.
      assert(Buffer.byteLength(JSON.stringify(q)) < 1000);
      q = JSON.parse(JSON.stringify(q));
      response.cards[0].updatedAt++;
    }
    assert(ticks < 3);
  }
  assert.equal(ticks, 1);
  assert(seen.includes(urgent.id));
  assert.equal(new Set(seen).size, 201);
  assert.equal(response.cards[200].id, urgent.id);
});

test('fails closed for truncation, duplicate cards, malformed data and invalid scope', () => {
  const response = fixture(201);
  response.cards.pop();
  assert.throws(() => pageCards(response, query), /truncated/);
  response.cards.push(response.cards[0]);
  assert.throws(() => pageCards(response, query), /duplicate/);
  assert.throws(() => pageCards({}, query), /Incomplete/);
  for (const q of [
    {},
    { ...query, after: 'invalid' },
    { ...query, ownerId: 'fake' },
    { ...query, boardId: "x'; shell" },
    { ...query, agentId: 'opencode' },
  ]) {
    assert.throws(() => validateQuery(q));
  }
  assert.throws(() => pageCards(fixture(1), { ...query, boardId: 'second' }), /scope mismatch/);
});

test(
  'isolated native 201-card enumeration preserves every card',
  { skip: process.env.JG_NATIVE_TEST !== '1' },
  async (t) => {
    const { WorkboardStore, sqliteStores } = await loadWorkboardTestInternals();
    const root = mkdtempSync(join(tmpdir(), 'project-page-201-')),
      stores = sqliteStores({ dbPath: `${root}/native.sqlite` }),
      store = new WorkboardStore(stores.cards, stores),
      boardId = 'isolated-page-201',
      tenant = 'saturation-fixture';
    try {
      for (let index = 0; index < 201; index++)
        await store.create({
          title: `Fixture ${index}`,
          boardId,
          tenant,
          status: 'todo',
          agentId: 'gilfoyle',
        });
      const before = await store.list({ boardId }),
        rpc = async (method, p) => {
          assert.equal(method, 'workboard.cards.list');
          const cards = await store.list(p);
          return { cards, boards: [{ id: boardId, total: cards.length }] };
        };
      const scope = { boardId, tenant, includeArchived: true },
        seen = [],
        lengths = [];
      let query = scope,
        pages = 0;
      for (;;) {
        const response = await rpc('workboard.cards.list', { boardId }),
          page = pageCards(response, query);
        pages++;
        lengths.push(page.cards.length);
        seen.push(...page.cards.map((row) => value(page, row, 'id')));
        if (!page.hasMore) break;
        query = { ...scope, after: page.nextAfter, membership: page.membership };
      }
      assert.equal(pages, 3);
      assert.deepEqual(lengths, [96, 96, 9]);
      assert.equal(new Set(seen).size, 201);
      assert.deepEqual(seen, before.map((card) => card.id).sort());
      assert.deepEqual(await store.list({ boardId }), before);
      t.diagnostic(`Only isolated SQLite store mutated: ${root}`);
    } finally {
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'installed owner slot spans boards and includes unclaimed running cards',
  { skip: process.env.JG_NATIVE_TEST !== '1' },
  async (t) => {
    const { WorkboardStore, sqliteStores } = await loadWorkboardTestInternals();
    const root = mkdtempSync(join(tmpdir(), 'project-owner-scope-'));
    const stores = sqliteStores({ dbPath: `${root}/workboard.sqlite` });
    const store = new WorkboardStore(stores.cards, stores);
    try {
      const first = await store.create({
        title: 'First assignment',
        boardId: 'first',
        status: 'todo',
        agentId: 'gilfoyle',
      });
      const second = await store.create({
        title: 'Independent assignment',
        boardId: 'second',
        status: 'todo',
        agentId: 'gilfoyle',
      });
      await store.claim(first.id, { ownerId: 'gilfoyle', ttlSeconds: 3600 });
      await assert.rejects(
        store.claim(second.id, { ownerId: 'gilfoyle' }),
        /active Workboard work/,
      );
      await store.releaseClaim(first.id, { ownerId: 'gilfoyle', status: 'running' });
      assert.equal((await store.get(first.id)).metadata?.claim, undefined);
      await assert.rejects(
        store.claim(second.id, { ownerId: 'gilfoyle' }),
        /active Workboard work/,
      );
      await store.releaseClaim(first.id, { ownerId: 'gilfoyle', status: 'todo' });
      await store.claim(second.id, { ownerId: 'gilfoyle' });
      await store.releaseClaim(second.id, { ownerId: 'gilfoyle', status: 'todo' });
      const before = await store.get(first.id);
      const notes =
        'Type: Work item\nDelegated attempt: ' +
        first.id +
        '-a1\nTask name: independent-a\nTask ID: 00000000-0000-4000-8000-000000000001\nRun ID: 00000000-0000-4000-8000-000000000002\nChild session: agent:opencode:acp:00000000-0000-4000-8000-000000000003\nWorktree: /tmp/isolated-test';
      await store.specify(first.id, { notes }, { ownerId: 'gilfoyle' });
      const delegated = await store.get(first.id);
      assert.equal(delegated.notes, notes);
      assert.equal(delegated.status, 'todo');
      assert.equal(delegated.agentId, before.agentId);
      assert.deepEqual(delegated.metadata?.automation, before.metadata?.automation);
      assert.equal(delegated.metadata?.claim, undefined);
      assert.equal(delegated.execution, undefined);
      assert.equal(delegated.sessionKey, undefined);
      await store.claim(second.id, { ownerId: 'gilfoyle' });
      assert.equal((await store.get(first.id)).notes, notes);
      await store.releaseClaim(second.id, { ownerId: 'gilfoyle', status: 'todo' });
      await store.claim(first.id, { ownerId: 'gilfoyle' });
      await assert.rejects(
        store.specify(first.id, { notes }, { ownerId: 'gilfoyle' }),
        /only triage, backlog, or todo/,
      );
      await store.releaseClaim(first.id, { ownerId: 'gilfoyle', status: 'todo' });
      t.diagnostic(
        'Current notes preserve attempt references without occupying the native owner slot; running specify still rejects',
      );
      t.diagnostic(`Isolated native store only: ${root}; live runtime unchanged`);
    } finally {
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'isolated native neutral blocked handoff CAS preserves failures, scope and owner slot',
  { skip: process.env.JG_NATIVE_TEST !== '1' },
  async (t) => {
    const { WorkboardStore, sqliteStores } = await loadWorkboardTestInternals();
    const root = mkdtempSync(join(tmpdir(), 'project-neutral-handoff-'));
    const stores = sqliteStores({ dbPath: `${root}/workboard.sqlite` });
    const store = new WorkboardStore(stores.cards, stores);
    try {
      const card = await store.create({
        title: 'Existing Work item',
        boardId: 'isolated-handoff',
        tenant: 'feature-fixture',
        idempotencyKey: 'work-item:fixture:scope',
        notes: 'Type: work-item\nScope: retain',
        status: 'todo',
        agentId: 'gilfoyle',
      });
      await store.block(card.id, { reason: 'Real prior failure' });
      await store.unblock(card.id);
      await store.claim(card.id, { ownerId: 'gilfoyle' });
      await store.releaseClaim(card.id, { ownerId: 'gilfoyle', status: 'blocked' });
      const before = await store.get(card.id);
      assert.equal(before.metadata.failureCount, 1);
      assert(!before.metadata.claim);
      const transferred = await store.update(
        card.id,
        { agentId: 'main', status: 'blocked', notes: before.notes },
        { expectedUpdatedAt: before.updatedAt },
      );
      assert.equal(transferred.metadata.failureCount, 1);
      assert.deepEqual(transferred.metadata.automation, before.metadata.automation);
      assert.deepEqual(transferred.metadata.comments, before.metadata.comments);
      await assert.rejects(
        store.update(card.id, { status: 'todo' }, { expectedUpdatedAt: before.updatedAt }),
        /changed|conflict/i,
      );
      const other = await store.create({
        title: 'Sibling remains eligible',
        boardId: 'isolated-handoff',
        agentId: 'gilfoyle',
        status: 'todo',
      });
      await store.claim(other.id, { ownerId: 'gilfoyle' });
      const returned = await store.update(
        card.id,
        { agentId: 'gilfoyle', status: 'blocked' },
        { expectedUpdatedAt: transferred.updatedAt },
      );
      assert.equal(returned.metadata.failureCount, 1);
      assert(!returned.metadata.claim);
      const { handoffCard } = await import('../src/helpers/handoff-card.ts');
      const source = 'channel=internal-ui;account=local;recipient=fixture;thread=none';
      const feature = await store.create({
        title: 'Human question',
        boardId: 'isolated-handoff',
        tenant: 'project:isolated-handoff',
        idempotencyKey: 'feature:isolated-handoff:question',
        agentId: 'gilfoyle',
        status: 'todo',
        notes: `Type: Feature\nDelivery: ${source}\nScope: original requested outcome`,
      });
      const rpc = async (method, p) => {
        if (method === 'workboard.cards.list')
          return { cards: await store.list(p), boards: (await store.listBoards()).boards };
        if (method === 'tasks.list') return { tasks: [] };
        if (method === 'workboard.cards.comment')
          return { card: await store.addComment(p.id, { body: p.body }) };
        if (method === 'workboard.cards.update')
          return {
            card: await store.update(p.id, p.patch, { expectedUpdatedAt: p.expectedUpdatedAt }),
          };
        throw Error(`Unexpected isolated call ${method}`);
      };
      const common = {
        boardId: 'isolated-handoff',
        id: feature.id,
        checkpoint: '00000000-0000-4000-8000-000000000070',
      };
      await handoffCard(
        'handoff',
        {
          ...common,
          actor: 'agent:gilfoyle:main',
          reason: 'retained-user-decision',
          question: 'Which approved scope?',
          resolution: 'Owner selects scope.',
        },
        rpc,
      );
      await handoffCard(
        'handoff-receipt',
        {
          ...common,
          actor: 'agent:main:main',
          delivery: 'sent',
          channel: source,
          message: 'sent-1',
        },
        rpc,
      );
      await handoffCard(
        'handoff-answer',
        {
          ...common,
          actor: 'agent:main:main',
          channel: source,
          replyTo: 'sent-1',
          message: 'answer-1',
          answer: 'Original scope.',
        },
        rpc,
      );
      assert.equal((await store.get(feature.id)).status, 'blocked');
      await handoffCard(
        'handoff-apply',
        {
          ...common,
          actor: 'agent:gilfoyle:main',
          application: 'Retained original scope.',
          replacementRequired: false,
        },
        rpc,
      );
      const final = await store.get(feature.id);
      assert.equal(final.status, 'todo');
      assert.equal(final.agentId, 'gilfoyle');
      assert.equal(final.metadata.comments.length, 4);
      assert.deepEqual(final.metadata.automation, feature.metadata.automation);
      assert.match(final.notes, /Scope: original requested outcome/);
      t.diagnostic(`Only isolated SQLite store mutated: ${root}`);
    } finally {
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'isolated native same-card replacement retains real committed Git effects and records attempt 2',
  { skip: process.env.JG_NATIVE_TEST !== '1' },
  async (t) => {
    const { WorkboardStore, sqliteStores } = await loadWorkboardTestInternals();
    const { operate } = await import('../src/helpers/native-operation.ts');
    const { currentAttempt, reconciledAttempts } = await import('../src/helpers/workboard-page.ts');
    const root = mkdtempSync(join(tmpdir(), 'project-replacement-')),
      checkout = `${root}/repo`,
      first = `${root}/a1`,
      second = `${root}/a2`;
    const git = (cwd, args) =>
      execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    execFileSync('git', ['init', '--initial-branch=main', checkout], { stdio: 'pipe' });
    writeFileSync(`${checkout}/parser.js`, 'export const parsed = "base";\n');
    git(checkout, ['add', '--', 'parser.js']);
    git(checkout, [
      '-c',
      'user.name=Isolated Test',
      '-c',
      'user.email=isolated@example.invalid',
      'commit',
      '-m',
      'Initial fixture',
    ]);
    const base = git(checkout, ['rev-parse', 'HEAD']);
    let head;
    git(checkout, ['worktree', 'add', '-b', 'work-a1', first, base]);
    const stores = sqliteStores({ dbPath: `${root}/native.sqlite` }),
      store = new WorkboardStore(stores.cards, stores);
    try {
      const boardId = 'isolated-replacement',
        source = 'channel=internal-ui;account=local;recipient=fixture;thread=none';
      await store.create({
        title: 'Project information',
        boardId,
        tenant: `project:${boardId}`,
        idempotencyKey: `project-info:${boardId}`,
        labels: ['type:project-info'],
        status: 'todo',
        notes: `Type: project-info\nReadiness: ready\nCheckout: ${checkout}\nRepository: file://${root}/selected.git\nIntegration branch: main`,
      });
      const feature = await store.create({
        title: 'Feature',
        boardId,
        tenant: `project:${boardId}`,
        idempotencyKey: `feature:${boardId}:fixture`,
        agentId: 'gilfoyle',
        status: 'todo',
        notes: `Type: feature\nDelivery: ${source}`,
      });
      const item = await store.create({
        title: 'Worker card',
        boardId,
        tenant: feature.id,
        idempotencyKey: `work-item:${feature.id}:parser`,
        agentId: 'gilfoyle',
        status: 'todo',
        notes: `Type: work-item\nFeature: ${feature.id}\nRequires Work items: none\nAssignment: implementation`,
      });
      const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
        tasks = [],
        calls = [];
      let failArchive = false;
      const rpc = async (method, p) => {
        calls.push(method);
        if (method === 'workboard.cards.list')
          return { cards: await store.list(p), boards: (await store.listBoards()).boards };
        if (method === 'tasks.list')
          return {
            tasks: tasks
              .map(({ prompt, ...row }) => row)
              .sort((a, b) => b.updatedAt - a.updatedAt || a.taskId.localeCompare(b.taskId)),
          };
        if (method === 'tasks.get') return { task: tasks.find((x) => x.taskId === p.taskId) };
        if (method === 'sessions.list')
          return {
            sessions: [
              ...new Map(
                tasks.map((x) => [
                  x.childSessionKey,
                  {
                    key: x.childSessionKey,
                    lastRunId: x.runId,
                    hasActiveRun: false,
                    hasActiveSubagentRun: false,
                  },
                ]),
              ).values(),
            ],
            hasMore: false,
          };
        if (method === 'workboard.cards.comment') {
          const card = await store.addComment(p.id, { body: p.body });
          if (failArchive && p.body.startsWith('Reconciled attempt:')) {
            failArchive = false;
            throw Error('Ambiguous native archive write');
          }
          return { card };
        }
        if (method === 'workboard.cards.update')
          return {
            card: await store.update(p.id, p.patch, { expectedUpdatedAt: p.expectedUpdatedAt }),
          };
        if (method === 'workboard.cards.release')
          return { card: await store.releaseClaim(p.id, { ownerId: p.ownerId, status: p.status }) };
        throw Error(`Unexpected isolated RPC ${method}`);
      };
      const p1 = {
        boardId,
        id: item.id,
        attempt: 1,
        taskName: 'isolated-parser-a1',
        profileId: 'deep',
        timeoutSeconds: 1800,
        baseSha: base,
        worktree: first,
        branch: 'work-a1',
      };
      const prepared = await operate('prepare', p1, rpc, git);
      writeFileSync(`${first}/parser.js`, 'export const parsed = "retained implementation";\n');
      git(first, ['add', '--', 'parser.js']);
      git(first, [
        '-c',
        'user.name=Isolated Test',
        '-c',
        'user.email=isolated@example.invalid',
        'commit',
        '-m',
        'Retained partial implementation',
      ]);
      head = git(first, ['rev-parse', 'HEAD']);
      git(checkout, ['worktree', 'add', '-b', 'work-a2', second, head]);
      await store.claim(item.id, { ownerId: 'gilfoyle' });
      const addTasks = (n, prompt, status) =>
        tasks.push(
          ...['acp', 'subagent'].map((runtime, i) => ({
            taskId: uuid(n + i),
            runtime,
            agentId: 'opencode',
            runId: uuid(n + 2),
            childSessionKey: `agent:opencode:acp:${uuid(n + 3)}`,
            sessionKey: 'agent:gilfoyle:main',
            ownerKey: 'agent:gilfoyle:main',
            createdAt: item.createdAt,
            updatedAt: Date.now(),
            endedAt: Date.now(),
            status,
            prompt,
          })),
        );
      addTasks(10, prepared.taskPrefix, 'failed');
      await operate(
        'record',
        {
          boardId,
          id: item.id,
          runId: uuid(12),
          childSessionKey: `agent:opencode:acp:${uuid(13)}`,
          taskId: uuid(10),
          wrapperTaskId: uuid(11),
        },
        rpc,
        git,
      );
      await store.block(item.id, { reason: 'Remaining validation needs an owner answer.' });
      await store.addProof(item.id, {
        status: 'passed',
        label: 'Retained parser',
        note: `Inspected retained parser commit ${head}`,
      });
      const before = await store.get(item.id),
        a = currentAttempt(before),
        common = { boardId, id: item.id, checkpoint: uuid(70) };
      await operate(
        'handoff',
        {
          ...common,
          actor: 'agent:gilfoyle:main',
          reason: 'retained-user-decision',
          question: 'Which validation remains?',
          resolution: 'Owner confirms remaining validation.',
        },
        rpc,
      );
      await operate(
        'handoff-receipt',
        {
          ...common,
          actor: 'agent:main:main',
          delivery: 'sent',
          channel: source,
          message: 'fixture-sent',
        },
        rpc,
      );
      await operate(
        'handoff-answer',
        {
          ...common,
          actor: 'agent:main:main',
          channel: source,
          replyTo: 'fixture-sent',
          message: 'fixture-answer',
          answer: 'Add remaining validation; keep the parser.',
        },
        rpc,
      );
      await operate(
        'handoff-apply',
        {
          ...common,
          actor: 'agent:gilfoyle:main',
          application: 'Preserve the accepted parser and implement the remaining validation.',
          replacementRequired: true,
        },
        rpc,
      );
      const remaining = 'Add remaining validation; preserve the accepted parser.';
      const p2 = {
        ...p1,
        attempt: 2,
        taskName: `wi-${item.id}-a2`,
        worktree: second,
        branch: 'work-a2',
        baseSha: head,
        inspectedHead: head,
        remaining,
        reconciliation: `Inspected ${head}; retained parser implementation. Remaining: ${remaining}`,
        replaces: Object.fromEntries(
          ['attempt', 'taskId', 'wrapperTaskId', 'runId', 'childSessionKey', 'commentId'].map(
            (k) => [k, a[k]],
          ),
        ),
      };
      failArchive = true;
      await assert.rejects(operate('prepare', p2, rpc, git), /Ambiguous/);
      const next = await operate('prepare', p2, rpc, git);
      assert.equal((await operate('prepare', p2, rpc, git)).reused, true);
      await store.claim(item.id, { ownerId: 'gilfoyle' });
      addTasks(20, next.taskPrefix, 'completed');
      await operate(
        'record',
        {
          boardId,
          id: item.id,
          attempt: 2,
          runId: uuid(22),
          childSessionKey: `agent:opencode:acp:${uuid(23)}`,
          taskId: uuid(20),
          wrapperTaskId: uuid(21),
        },
        rpc,
        git,
      );
      const final = await store.get(item.id);
      assert.equal(currentAttempt(final).taskId, uuid(20));
      assert.equal(reconciledAttempts(final).length, 1);
      assert.deepEqual(final.metadata.automation, before.metadata.automation);
      assert.deepEqual(final.metadata.proof, before.metadata.proof);
      assert.equal(final.metadata.failureCount, 1);
      assert(final.metadata.comments.some((x) => x.id === a.commentId));
      assert.equal(tasks[0].status, 'failed');
      assert.equal((await store.list({ boardId })).length, 3);
      assert.equal(git(first, ['rev-parse', 'HEAD']), head);
      assert.equal(git(second, ['rev-parse', 'HEAD']), head);
      assert.equal(
        readFileSync(`${second}/parser.js`, 'utf8'),
        readFileSync(`${first}/parser.js`, 'utf8'),
      );
      assert(!calls.includes('workboard.cards.create'));
      t.diagnostic(
        `Only disposable Git worktrees and isolated native SQLite mutated: ${root}; task/session evidence simulated, no worker launched`,
      );
    } finally {
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'isolated native in-memory metadata preflight prevents proof, artifact and comment eviction before any write',
  { skip: process.env.JG_NATIVE_TEST !== '1' },
  async (t) => {
    const { WorkboardStore } = await loadWorkboardTestInternals();
    const { operate } = await import('../src/helpers/native-operation.ts');
    const { currentAttempt } = await import('../src/helpers/workboard-page.ts');
    const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    for (const target of ['question', 'archive']) {
      const rows = new Map(),
        memory = {
          register: async (key, value) => {
            rows.set(key, structuredClone(value));
          },
          lookup: async (key) => structuredClone(rows.get(key)),
          delete: async (key) => rows.delete(key),
          entries: async () =>
            [...rows].map(([key, value]) => ({ key, value: structuredClone(value) })),
        };
      const store = new WorkboardStore(memory);
      try {
        const boardId = 'metadata-fixture',
          source = 'channel=internal-ui;account=local;recipient=fixture;thread=none',
          base = 'a'.repeat(40),
          head = 'b'.repeat(40);
        await store.create({
          title: 'Information',
          boardId,
          tenant: `project:${boardId}`,
          idempotencyKey: `project-info:${boardId}`,
          labels: ['type:project-info'],
          status: 'todo',
          notes:
            'Type: project-info\nReadiness: ready\nCheckout: /fixture/repo\nIntegration branch: main',
        });
        const feature = await store.create({
          title: 'Feature',
          boardId,
          agentId: 'gilfoyle',
          status: 'todo',
          notes: `Type: feature\nDelivery: ${source}`,
        });
        let card = feature;
        const tasks = [],
          calls = [];
        const rpc = async (method, p) => {
          calls.push(method);
          if (method === 'workboard.cards.list')
            return { cards: await store.list(p), boards: (await store.listBoards()).boards };
          if (method === 'tasks.list')
            return {
              tasks: tasks
                .map(({ prompt, ...row }) => row)
                .sort((a, b) => b.updatedAt - a.updatedAt || a.taskId.localeCompare(b.taskId)),
            };
          if (method === 'tasks.get') return { task: tasks.find((t) => t.taskId === p.taskId) };
          if (method === 'sessions.list')
            return {
              sessions: [
                {
                  key: `agent:opencode:acp:${uuid(13)}`,
                  lastRunId: uuid(12),
                  hasActiveRun: false,
                  hasActiveSubagentRun: false,
                },
              ],
              hasMore: false,
            };
          if (method === 'workboard.cards.comment')
            return { card: await store.addComment(p.id, { body: p.body }) };
          if (method === 'workboard.cards.update')
            return {
              card: await store.update(p.id, p.patch, { expectedUpdatedAt: p.expectedUpdatedAt }),
            };
          if (method === 'workboard.cards.release')
            return {
              card: await store.releaseClaim(p.id, { ownerId: p.ownerId, status: p.status }),
            };
          throw Error(`Unexpected isolated metadata RPC ${method}`);
        };
        let oldHead = base;
        const git = (cwd, args) => {
          if (args[0] === 'worktree')
            return `worktree /fixture/old\nHEAD ${base}\nbranch refs/heads/work-a1\n\nworktree /fixture/new\nHEAD ${head}\nbranch refs/heads/work-a2`;
          if (args.includes('--git-common-dir')) return '/fixture/repo/.git';
          if (args.includes('--show-toplevel')) return cwd;
          if (args[0] === 'symbolic-ref') return cwd === '/fixture/old' ? 'work-a1' : 'work-a2';
          if (args[0] === 'rev-parse' && args[1] === 'HEAD')
            return cwd === '/fixture/old' ? oldHead : head;
          if (args[0] === 'status' || args[0] === 'merge-base') return '';
          throw Error('Unexpected mock Git inspection');
        };
        let input;
        if (target === 'archive') {
          card = await store.create({
            title: 'Work item',
            boardId,
            tenant: feature.id,
            agentId: 'gilfoyle',
            status: 'todo',
            notes: `Type: work-item\nFeature: ${feature.id}\nRequires Work items: none`,
          });
          const p = {
            boardId,
            id: card.id,
            attempt: 1,
            taskName: 'metadata-a1',
            profileId: 'deep',
            timeoutSeconds: 1800,
            baseSha: base,
            worktree: '/fixture/old',
            branch: 'work-a1',
          };
          const prepared = await operate('prepare', p, rpc, git);
          await store.claim(card.id, { ownerId: 'gilfoyle' });
          tasks.push(
            ...['acp', 'subagent'].map((runtime, n) => ({
              taskId: uuid(10 + n),
              runtime,
              agentId: 'opencode',
              sessionKey: 'agent:gilfoyle:main',
              ownerKey: 'agent:gilfoyle:main',
              runId: uuid(12),
              childSessionKey: `agent:opencode:acp:${uuid(13)}`,
              status: 'failed',
              createdAt: card.createdAt,
              updatedAt: Date.now(),
              endedAt: Date.now(),
              prompt: prepared.taskPrefix,
            })),
          );
          await operate(
            'record',
            {
              boardId,
              id: card.id,
              taskId: uuid(10),
              wrapperTaskId: uuid(11),
              runId: uuid(12),
              childSessionKey: `agent:opencode:acp:${uuid(13)}`,
            },
            rpc,
            git,
          );
          oldHead = head;
          const a = currentAttempt(await store.get(card.id)),
            remaining = 'Complete only the remaining validation.';
          input = {
            ...p,
            attempt: 2,
            taskName: `wi-${card.id}-a2`,
            baseSha: head,
            worktree: '/fixture/new',
            branch: 'work-a2',
            inspectedHead: head,
            remaining,
            reconciliation: `Inspected ${head}; retain the accepted parser. Remaining: ${remaining}`,
            replaces: Object.fromEntries(
              ['attempt', 'taskId', 'wrapperTaskId', 'runId', 'childSessionKey', 'commentId'].map(
                (k) => [k, a[k]],
              ),
            ),
          };
        } else
          input = {
            boardId,
            id: card.id,
            checkpoint: uuid(70),
            actor: 'agent:gilfoyle:main',
            reason: 'retained-user-decision',
            question: 'Which approved scope should continue?',
            resolution: 'Owner selects the remaining scope.',
          };
        await store.addProof(card.id, {
          status: 'passed',
          label: 'Retained proof',
          note: 'Never evict this accepted result.',
        });
        await store.addArtifact(card.id, {
          label: 'Retained artifact',
          path: '/fixture/retained-result',
        });
        card = await store.get(card.id);
        const metadata = structuredClone(card.metadata),
          extra = Array.from({ length: 12 }, (_, i) => ({
            id: uuid(800 + i),
            body: 'x',
            createdAt: card.createdAt,
          }));
        (metadata.comments ??= []).push(...extra);
        let remaining = 24500 - Buffer.byteLength(JSON.stringify(metadata));
        for (const comment of extra) {
          const add = Math.min(1999, remaining);
          comment.body += 'x'.repeat(add);
          remaining -= add;
        }
        assert.equal(remaining, 0);
        await store.update(card.id, { metadata }, { expectedUpdatedAt: card.updatedAt });
        const before = await store.get(card.id);
        assert.equal(Buffer.byteLength(JSON.stringify(before.metadata)), 24500);
        assert.deepEqual(before.metadata, metadata);
        calls.length = 0;
        await assert.rejects(
          operate(target === 'archive' ? 'prepare' : 'handoff', input, rpc, git),
          /metadata byte capacity/,
        );
        assert(
          !calls.some((m) => ['workboard.cards.comment', 'workboard.cards.update'].includes(m)),
        );
        assert.deepEqual(
          await store.get(card.id),
          before,
          'Rejection must preserve the entire original native record',
        );
        // Negative control invokes the installed sanitizer on a separate in-memory
        // copy, proving this fixture really loses evidence without the preflight.
        const controlId = uuid(999);
        await memory.register(controlId, { version: 1, card: { ...before, id: controlId } });
        const trimmed = await store.addComment(controlId, { body: 'Unsafe mutation '.repeat(120) });
        assert.equal(trimmed.metadata.proof, undefined);
        assert.equal(trimmed.metadata.artifacts, undefined);
        assert(trimmed.metadata.comments.length < before.metadata.comments.length + 1);
        assert.deepEqual(await store.get(card.id), before);
        t.diagnostic(
          `${target}: installed native metadata at 24500 bytes rejects without a write; isolated unsafe control evicts proof/artifacts/comments`,
        );
      } finally {
        await store.close();
      }
    }
  },
);
