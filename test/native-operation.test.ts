import assert from 'node:assert/strict';
import test from 'node:test';
import './support/setup.ts';
import { operate } from '../src/helpers/native-operation.ts';
import {
  currentAttempt,
  classifyCards,
  readView,
  reconciledAttempts,
} from '../src/helpers/workboard-page.ts';
import { githubFixture } from './github-fixture.ts';
import { assertCommentCapacity, handoffError, handoffMarker } from '../src/helpers/handoff-card.ts';
import { createProductCard, sealCreationPayload } from '../src/helpers/create-card.ts';
import { delegationError } from '../src/helpers/record-delegation.ts';
import { finalizeFeature } from '../src/helpers/finalize-feature.ts';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = 'a'.repeat(40);
const route = 'channel=telegram;account=default;recipient=owner;thread=none';
const stopCard = (n) => {
  const payload = sealCreationPayload({
    boardId: 'project',
    tenant: id(2),
    idempotencyKey: `action:${id(2)}:cancellation:stop`,
    title: 'Stop requested',
    agentId: 'gilfoyle',
    status: 'todo',
    priority: 'urgent',
    labels: ['type:action', 'cancellation', 'stop'],
    workspace: { kind: 'scratch' },
    maxRuntimeSeconds: 1,
    maxRetries: 1,
    notes: `Type: action\nKind: cancellation\nFeature: ${id(2)}\nReason: Owner requested cancellation.`,
  });
  return {
    ...payload,
    id: id(n),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {
      automation: {
        boardId: payload.boardId,
        tenant: payload.tenant,
        idempotencyKey: payload.idempotencyKey,
        workspace: payload.workspace,
        maxRuntimeSeconds: 1,
        maxRetries: 1,
      },
    },
  };
};
function fixture() {
  let tick = Date.now(),
    fail,
    nextCard = 90;
  const cards = [
    {
      id: id(1),
      status: 'todo',
      labels: ['type:project-info'],
      updatedAt: tick,
      notes:
        'Type: project-info\nReadiness: ready\nCheckout: /tmp/repo\nRepository: file:///tmp/remote.git\nIntegration branch: main',
      metadata: {
        automation: {
          boardId: 'project',
          tenant: 'project:project',
          idempotencyKey: 'project-info:project',
        },
      },
    },
    {
      id: id(2),
      agentId: 'gilfoyle',
      status: 'todo',
      createdAt: tick,
      updatedAt: tick,
      notes: `Type: feature\nDelivery: ${route}`,
      metadata: { automation: { boardId: 'project' } },
    },
    {
      id: id(3),
      agentId: 'gilfoyle',
      status: 'todo',
      createdAt: tick,
      updatedAt: tick,
      notes: `Type: work-item\nFeature: ${id(2)}\nRequires Work items: none\nAssignment: implementation`,
      metadata: {
        automation: {
          boardId: 'project',
          tenant: id(2),
          idempotencyKey: `work-item:${id(2)}:implementation`,
        },
      },
    },
  ];
  const calls = [],
    tasks = [];
  const taskRow = (t) => ({
    createdAt: cards[2]?.createdAt ?? tick,
    updatedAt: t.endedAt ?? tick,
    ...t,
  });
  const rpc = async (method, p) => {
    calls.push({ method, p: structuredClone(p) });
    if (method === 'workboard.cards.list')
      return structuredClone({ cards, boards: [{ id: 'project', total: cards.length }] });
    if (method === 'tasks.list')
      return {
        tasks: structuredClone(
          tasks
            .map(taskRow)
            .map(({ prompt, ...row }) => row)
            .sort((a, b) => b.updatedAt - a.updatedAt || a.taskId.localeCompare(b.taskId)),
        ),
      };
    if (method === 'tasks.get') {
      const t = tasks.find((t) => t.taskId === p.taskId);
      return { task: t ? structuredClone(taskRow(t)) : undefined };
    }
    if (method === 'sessions.list')
      return {
        sessions: [13, 23].map((n) => ({
          key: `agent:opencode:acp:${id(n)}`,
          hasActiveRun: false,
          hasActiveSubagentRun: false,
          lastRunId: id(n - 1),
        })),
        hasMore: false,
      };
    let c = cards.find((c) => c.id === p.id);
    if (method === 'workboard.cards.update') {
      if (p.patch.notes !== undefined)
        assert(p.patch.notes.length <= 4000, 'Native notes limit: 4000');
      assert.equal(p.expectedUpdatedAt, c.updatedAt, 'CAS');
      Object.assign(c, p.patch);
      c.updatedAt = ++tick;
    } else if (method === 'workboard.cards.comment') {
      (c.metadata.comments ??= []).push({
        id: id(++tick % 1000000),
        body: p.body,
        createdAt: ++tick,
      });
      c.updatedAt = tick;
    } else if (method === 'workboard.cards.release') {
      assert.equal(p.ownerId, 'gilfoyle');
      delete c.metadata.claim;
      c.status = p.status;
      c.updatedAt = ++tick;
    } else if (method === 'workboard.cards.create') {
      assert(p.notes.length <= 4000, 'Native notes limit: 4000');
      c = {
        ...p,
        id: id(nextCard++),
        updatedAt: ++tick,
        createdAt: tick,
        metadata: {
          automation: {
            boardId: p.boardId,
            tenant: p.tenant,
            idempotencyKey: p.idempotencyKey,
            workspace: p.workspace,
            maxRuntimeSeconds: p.maxRuntimeSeconds,
            maxRetries: p.maxRetries,
          },
        },
      };
      cards.push(c);
    } else if (method === 'workboard.cards.complete') {
      c.status = 'done';
      c.completedAt = ++tick;
      delete c.metadata.claim;
      c.metadata.automation.summary = p.summary;
      c.metadata.proof = [p.proof];
      c.updatedAt = tick;
    } else if (method === 'workboard.cards.reassign') {
      assert.equal(p.resetFailures, false);
      c.agentId = p.agentId;
      c.updatedAt = ++tick;
    } else throw Error(`Unexpected method ${method}`);
    if (fail === method) {
      fail = undefined;
      throw Error('Ambiguous accepted operation');
    }
    return structuredClone({ card: c });
  };
  const claim = (c) => {
    c.metadata.claim = { ownerId: 'gilfoyle', expiresAt: Date.now() + 3600000 };
    c.status = 'running';
  };
  const git = (cwd, args) => {
    if (args[0] === 'worktree')
      return `worktree /tmp/repo\nHEAD ${sha}\nbranch refs/heads/main\n\nworktree /tmp/repo-worktree\nHEAD ${sha}\nbranch refs/heads/work-a1\n\nworktree /tmp/review-worktree\nHEAD ${sha}\nbranch refs/heads/review-a1\n\nworktree /tmp/other-worktree\nHEAD ${sha}\nbranch refs/heads/other-a1\n\nworktree /tmp/sibling-worktree\nHEAD ${sha}\nbranch refs/heads/sibling-a1`;
    if (args[0] === 'remote') return 'file:///tmp/remote.git';
    if (args.includes('--git-common-dir') || args.includes('--absolute-git-dir'))
      return '/tmp/repo/.git';
    if (args.includes('--show-toplevel')) return cwd;
    if (args[0] === 'symbolic-ref')
      return cwd === '/tmp/review-worktree'
        ? 'review-a1'
        : cwd === '/tmp/repo-worktree'
          ? 'work-a1'
          : cwd === '/tmp/other-worktree'
            ? 'other-a1'
            : cwd === '/tmp/sibling-worktree'
              ? 'sibling-a1'
              : 'main';
    if (args[0] === 'status' || args[0] === 'merge-base') return '';
    if (args[0] === 'rev-parse') return sha;
    throw Error('Unexpected Git operation');
  };
  const prepare = {
    boardId: 'project',
    id: id(3),
    attempt: 1,
    taskName: 'wi-test-a1',
    profileId: 'deep',
    timeoutSeconds: 1800,
    baseSha: sha,
    worktree: '/tmp/repo-worktree',
    branch: 'work-a1',
  };
  const record = {
    boardId: 'project',
    id: id(3),
    runId: id(12),
    childSessionKey: `agent:opencode:acp:${id(13)}`,
  };
  const finish = {
    boardId: 'project',
    id: id(2),
    sha,
    reviewId: id(3),
    summary: 'Requested conditions verified.',
  };
  const delegate = async () => {
    await operate('prepare', prepare, rpc, git);
    claim(cards[2]);
    tasks.push(
      ...['acp', 'subagent'].map((runtime, n) => ({
        taskId: id(10 + n),
        runtime,
        agentId: 'opencode',
        runId: record.runId,
        childSessionKey: record.childSessionKey,
        sessionKey: 'agent:gilfoyle:main',
        ownerKey: 'agent:gilfoyle:main',
        status: 'completed',
        endedAt: ++tick,
        prompt: `Work item: ${id(3)} Task name: wi-test-a1 Assignment`,
      })),
    );
    await operate('record', record, rpc, git);
  };
  let context;
  const ready = async () => {
    await delegate();
    cards[2].status = 'done';
    cards[2].metadata.proof = [{ status: 'passed', note: `Implemented ${sha}` }];
    claim(cards[1]);
    const review = await addCanonicalReview(context);
    finish.reviewId = review.id;
    return review;
  };
  context = {
    cards,
    tasks,
    calls,
    rpc,
    git,
    prepare,
    record,
    finish,
    claim,
    delegate,
    ready,
    failAfter: (method) => {
      fail = method;
    },
  };
  return context;
}

test('prepare/record preserve native identity, release the owner slot and bind the current receipt', async () => {
  const f = fixture(),
    prepared = await operate('prepare', f.prepare, f.rpc, f.git);
  assert.deepEqual(prepared.taskPrefix, `Work item: ${id(3)}\nTask name: wi-test-a1\n`);
  assert.deepEqual(prepared.profile, { id: 'deep', model: 'openai/gpt-5.6-sol', thinking: 'high' });
  assert.equal(prepared.spawnArgs.model, 'openai/gpt-5.6-sol');
  assert.equal(prepared.spawnArgs.thinking, 'high');
  assert.equal(prepared.spawnArgs.cwd, f.prepare.worktree);
  assert(!Object.hasOwn(prepared.spawnArgs, 'task'));
  assert(!Object.hasOwn(prepared, 'reviewProof'));
  f.claim(f.cards[2]);
  f.tasks.push(
    ...['acp', 'subagent'].map((runtime, n) => ({
      taskId: id(10 + n),
      runtime,
      agentId: 'opencode',
      runId: f.record.runId,
      childSessionKey: f.record.childSessionKey,
      sessionKey: 'agent:gilfoyle:main',
      ownerKey: 'agent:gilfoyle:main',
      status: 'completed',
      endedAt: Date.now(),
      prompt: prepared.taskPrefix,
    })),
  );
  await operate('record', f.record, f.rpc, f.git);
  const c = f.cards[2],
    a = currentAttempt(c);
  assert.equal(a.taskId, id(10));
  assert.equal(a.wrapperTaskId, id(11));
  assert.equal(a.profileId, 'deep');
  assert.equal(a.model, 'openai/gpt-5.6-sol');
  assert.equal(a.thinking, 'high');
  assert(a.commentId);
  assert.equal(c.status, 'todo');
  assert(!c.metadata.claim && !c.execution && !c.sessionKey && !c.runId);
  const writes = f.calls.filter(
    (c) => !c.method.endsWith('.list') && c.method !== 'tasks.get',
  ).length;
  await operate('record', f.record, f.rpc, f.git);
  assert.equal(
    f.calls.filter((c) => !c.method.endsWith('.list') && c.method !== 'tasks.get').length,
    writes,
  );
  await assert.rejects(
    operate('record', { ...f.record, runId: id(99) }, f.rpc, f.git),
    /Immutable/,
  );
});

test('prepare selects only a configured worker profile', async () => {
  const expert = fixture(),
    prepared = await operate(
      'prepare',
      { ...expert.prepare, profileId: 'expert' },
      expert.rpc,
      expert.git,
    );
  assert.deepEqual(prepared.profile, {
    id: 'expert',
    model: 'openai/gpt-6-astra',
    thinking: 'low',
  });
  assert.equal(prepared.spawnArgs.model, 'openai/gpt-6-astra');
  const unknown = fixture();
  await assert.rejects(
    operate('prepare', { ...unknown.prepare, profileId: 'missing' }, unknown.rpc, unknown.git),
    /Unknown worker profile/,
  );
  assert(!unknown.calls.some((call) => call.method === 'workboard.cards.update'));
});

for (const fault of [
  'unregistered',
  'branch-registration',
  'checkout-reuse',
  'integration-branch',
  'wrong-repo',
  'wrong-root',
  'wrong-head',
  'dirty',
])
  test(`attempt 1 rejects ${fault} worktree before durable preparation`, async () => {
    const f = fixture(),
      p = { ...f.prepare };
    if (fault === 'checkout-reuse') p.worktree = '/tmp/repo';
    if (fault === 'integration-branch') p.branch = 'main';
    const git = (cwd, args) => {
      if (fault === 'unregistered' && args[0] === 'worktree')
        return `worktree /tmp/repo\nHEAD ${sha}\nbranch refs/heads/main`;
      if (fault === 'branch-registration' && args[0] === 'worktree')
        return f.git(cwd, args).replace('branch refs/heads/work-a1', 'branch refs/heads/other');
      if (fault === 'wrong-repo' && cwd === p.worktree && args.includes('--git-common-dir'))
        return '/tmp/other/.git';
      if (fault === 'wrong-root' && cwd === p.worktree && args.includes('--show-toplevel'))
        return '/tmp/repo-worktree/subdirectory';
      if (
        fault === 'wrong-head' &&
        cwd === p.worktree &&
        args[0] === 'rev-parse' &&
        args[1] === 'HEAD'
      )
        return 'b'.repeat(40);
      if (fault === 'dirty' && cwd === p.worktree && args[0] === 'status')
        return ' M implementation.ts';
      return f.git(cwd, args);
    };
    await assert.rejects(
      operate('prepare', p, f.rpc, git),
      /worktree|branch|repository|root|HEAD|Dirty/i,
    );
    assert(!f.calls.some((call) => call.method === 'workboard.cards.update'));
  });

test('attempt 1 rejects another Work item durable branch and worktree identity', async () => {
  const f = fixture();
  await f.delegate();
  const sibling = {
    ...structuredClone(f.cards[2]),
    id: id(4),
    status: 'todo',
    notes: `Type: work-item\nFeature: ${id(2)}\nRequires Work items: none\nAssignment: sibling`,
    metadata: {
      automation: {
        boardId: 'project',
        tenant: id(2),
        idempotencyKey: `work-item:${id(2)}:sibling`,
      },
    },
  };
  f.cards.push(sibling);
  await assert.rejects(
    operate('prepare', { ...f.prepare, id: sibling.id, taskName: 'sibling-a1' }, f.rpc, f.git),
    /branch and worktree must be new/,
  );
  assert(!/^Immutable base:/m.test(sibling.notes));
});

test('conversation-aware delegation binds the exact Feature controller instead of canonical main', async () => {
  const f = fixture();
  f.cards[1].notes += `\nProject identity: ${id(200)}`;
  const controller = `agent:gilfoyle:jarvis-gilfoyle:${id(2)}`,
    rpc = (m, p) =>
      m === 'jarvis-gilfoyle.projects.guard' ? Promise.resolve({ active: true }) : f.rpc(m, p);
  const prepared = await operate('prepare', f.prepare, rpc, f.git);
  f.claim(f.cards[2]);
  f.tasks.push(
    ...['acp', 'subagent'].map((runtime, n) => ({
      taskId: id(10 + n),
      runtime,
      agentId: 'opencode',
      runId: f.record.runId,
      childSessionKey: f.record.childSessionKey,
      sessionKey: controller,
      ownerKey: controller,
      status: 'completed',
      endedAt: Date.now(),
      prompt: prepared.taskPrefix,
    })),
  );
  await operate('record', f.record, rpc, f.git);
  assert.equal(currentAttempt(f.cards[2]).taskId, id(10));
  f.tasks[0].ownerKey = 'agent:gilfoyle:main';
  await assert.rejects(operate('record', f.record, rpc, f.git));
});

test('inactive project guard prevents worker preparation before native mutation', async () => {
  const f = fixture();
  f.cards[1].notes += `\nProject identity: ${id(200)}`;
  await assert.rejects(
    operate(
      'prepare',
      f.prepare,
      (m, p) =>
        m === 'jarvis-gilfoyle.projects.guard' ? Promise.resolve({ active: false }) : f.rpc(m, p),
      f.git,
    ),
    /inactive/,
  );
  assert(!f.calls.some((c) => c.method === 'workboard.cards.update'));
});

test('current-route question receipt and explicit cross-conversation answer survive on the same card', async () => {
  const f = fixture();
  f.cards.splice(2);
  f.cards[1].notes += `\nProject identity: ${id(200)}`;
  const base = { boardId: 'project', id: id(2), checkpoint: id(201) },
    engine = `agent:gilfoyle:jarvis-gilfoyle:${id(2)}`,
    jarvis = `agent:main:jarvis-gilfoyle:${id(2)}`;
  await operate(
    'handoff',
    {
      ...base,
      actor: engine,
      reason: 'retained-user-decision',
      question: 'Which scope?',
      resolution: 'Wait for explicit project answer',
    },
    f.rpc,
  );
  const newRoute = 'channel=discord;account=main;recipient=channel:200;thread=201';
  await operate(
    'handoff-receipt',
    { ...base, actor: jarvis, delivery: 'sent', channel: newRoute, message: '500' },
    f.rpc,
  );
  await operate(
    'handoff-correlated-answer',
    {
      ...base,
      actor: 'agent:main:matrix:group:!room:jg:example.org',
      channel: 'channel=matrix;account=main;recipient=%21room:jg:example.org;thread=none',
      questionMessage: '500',
      message: '501',
      answer: 'Use the current statistics scope.',
    },
    f.rpc,
  );
  assert.equal(f.cards[1].agentId, 'gilfoyle');
  assert(f.cards[1].metadata.comments.some((c) => c.body.includes('explicit-project-answer')));
  assert(!f.cards[1].metadata.comments.some((c) => c.body.includes('"replyTo"')));
  await operate(
    'handoff-apply',
    {
      ...base,
      actor: engine,
      application: 'The authenticated explicit answer resolves the existing scope decision.',
      replacementRequired: false,
    },
    f.rpc,
  );
  assert.equal(f.cards[1].status, 'todo');
});

test('settled work finalizes with unchanged Git proof and one native notification', async () => {
  const f = fixture();
  f.cards.splice(2);
  f.cards[1].notes += '\nScope: Read-only report of current test status';
  f.claim(f.cards[1]);
  const input = {
    boardId: 'project',
    id: id(2),
    sha,
    summary: 'Current tests pass.',
    evidence: 'Observed npm test with three passing checks and unchanged HEAD.',
  };
  const result = await finalizeFeature(input, f.rpc, f.git);
  assert.equal(f.cards[1].status, 'done');
  assert.equal(f.cards.find((c) => c.id === result.notificationId).agentId, 'main');
  await finalizeFeature(input, f.rpc, f.git);
  assert.equal(
    f.cards.filter(
      (c) => c.metadata.automation.idempotencyKey === `action:${id(2)}:owner-notification`,
    ).length,
    1,
  );
});

test('finalization rejects a changed checkout before creating a notification', async () => {
  const f = fixture();
  f.cards.splice(2);
  f.cards[1].notes += '\nScope: Read-only report';
  f.claim(f.cards[1]);
  await assert.rejects(
    finalizeFeature(
      { boardId: 'project', id: id(2), sha, summary: 'Findings', evidence: 'Checked' },
      f.rpc,
      (cwd, args) => (args[0] === 'status' ? ' M stats.mjs' : f.git(cwd, args)),
    ),
    /clean/,
  );
  assert.equal(f.cards.length, 2);
});

test('finalization repairs an already-completed Feature without changing its outcome', async () => {
  const f = fixture();
  f.cards.splice(2);
  f.cards[1].status = 'done';
  f.cards[1].completedAt = Date.now();
  f.cards[1].metadata.automation.summary = 'The requested behavior was already available.';
  f.cards[1].metadata.proof = [
    { status: 'passed', label: 'Existing behavior', note: 'Verified on repository main.' },
  ];
  const result = await finalizeFeature(
    {
      boardId: 'project',
      id: id(2),
      summary: 'The requested behavior was already available.',
      evidence: 'Verified the existing behavior and retained prior delivery evidence.',
    },
    f.rpc,
    f.git,
  );
  assert.equal(result.status, 'finalized');
  assert.equal(
    f.cards[1].metadata.automation.summary,
    'The requested behavior was already available.',
  );
  assert.equal(
    f.cards.filter(
      (card) => card.metadata.automation.idempotencyKey === `action:${id(2)}:owner-notification`,
    ).length,
    1,
  );
});

test('finalization validates an existing terminal outcome before staging its notice', async () => {
  const f = fixture();
  f.cards.splice(2);
  f.cards[1].status = 'done';
  f.cards[1].completedAt = Date.now();
  f.cards[1].metadata.automation.summary = 'Existing outcome';
  f.cards[1].metadata.proof = [{ status: 'passed', note: 'Existing proof' }];
  await assert.rejects(
    finalizeFeature(
      {
        boardId: 'project',
        id: id(2),
        sha,
        summary: 'Changed outcome',
        evidence: 'New claim',
      },
      f.rpc,
      f.git,
    ),
    /Terminal Feature evidence mismatch/,
  );
  assert.equal(f.cards.length, 2);
});

test('finalization rejects malformed related children before staging a notice', async () => {
  const f = fixture();
  f.cards[2].status = 'done';
  f.cards[2].metadata.proof = [{ status: 'passed', note: 'Claimed complete' }];
  f.cards[2].metadata.automation.tenant = id(99);
  f.claim(f.cards[1]);
  await assert.rejects(
    finalizeFeature(
      {
        boardId: 'project',
        id: id(2),
        sha,
        summary: 'No change required.',
        evidence: 'Checked current state.',
      },
      f.rpc,
      f.git,
    ),
    /Malformed Feature child/,
  );
  assert.equal(f.cards.length, 3);
});

test('finalization rejects linked or unsealed relevant children', async () => {
  const f = fixture();
  f.cards[2].status = 'done';
  f.cards[2].metadata.proof = [{ status: 'passed', note: 'Claimed complete' }];
  f.cards[2].notes += `\nCreation: sha256:${'b'.repeat(64)}`;
  f.cards[2].metadata.links = [{ type: 'parent', targetCardId: id(2) }];
  f.claim(f.cards[1]);
  await assert.rejects(
    finalizeFeature(
      {
        boardId: 'project',
        id: id(2),
        sha,
        summary: 'No change required.',
        evidence: 'Checked current state.',
      },
      f.rpc,
      f.git,
    ),
    /Native dependency links/,
  );
  assert.equal(f.cards.length, 3);
});

test('internal operational recovery preserves failed execution without inventing a user answer', async () => {
  const f = fixture();
  await f.delegate();
  f.tasks.forEach((t) => (t.status = 'failed'));
  const base = { boardId: 'project', id: id(3), checkpoint: id(220), actor: 'agent:gilfoyle:main' };
  await operate(
    'handoff',
    {
      ...base,
      reason: 'operational-blocker',
      question: 'Worker disconnected before review.',
      resolution: 'Reconcile exact failed native execution.',
    },
    f.rpc,
  );
  const r = await operate(
    'handoff-resolve-internal',
    {
      ...base,
      application:
        'Both native execution tasks are terminal failed and their exact child session is inactive. The unchanged candidate is retained for bounded review recovery.',
      replacementRequired: true,
    },
    f.rpc,
  );
  assert.equal(r.phase, 'resolved-internally');
  assert.equal(f.cards[2].status, 'todo');
  assert.equal(f.cards[2].agentId, 'gilfoyle');
  assert(f.tasks.every((t) => t.status === 'failed'));
  assert(!f.cards[2].metadata.comments.some((c) => c.body.includes('"kind":"answer"')));
  await operate(
    'handoff-resolve-internal',
    {
      ...base,
      application:
        'Both native execution tasks are terminal failed and their exact child session is inactive. The unchanged candidate is retained for bounded review recovery.',
      replacementRequired: true,
    },
    f.rpc,
  );
});

test('internal resolution cannot bypass a retained human product decision', async () => {
  const f = fixture();
  f.cards.splice(2);
  const base = { boardId: 'project', id: id(2), checkpoint: id(221), actor: 'agent:gilfoyle:main' };
  await operate(
    'handoff',
    {
      ...base,
      reason: 'retained-user-decision',
      question: 'Choose product behavior.',
      resolution: 'Wait for user choice.',
    },
    f.rpc,
  );
  await assert.rejects(
    operate(
      'handoff-resolve-internal',
      { ...base, application: 'I guessed.', replacementRequired: false },
      f.rpc,
    ),
    /Only an operational/,
  );
  assert.equal(f.cards[1].status, 'blocked');
});

test('Jarvis can durably answer an established product question without impersonating the user', async () => {
  const f = fixture();
  f.cards.splice(2);
  f.cards[1].notes += `\nProject identity: ${id(200)}`;
  const base = { boardId: 'project', id: id(2), checkpoint: id(230) },
    gilfoyle = `agent:gilfoyle:jarvis-gilfoyle:${id(2)}`,
    jarvis = `agent:main:jarvis-gilfoyle:${id(2)}`;
  await operate(
    'handoff',
    {
      ...base,
      actor: gilfoyle,
      reason: 'product-question',
      question: 'Should this remain local-only?',
      resolution: 'Use established project direction if it is explicit.',
    },
    f.rpc,
  );
  const decision = {
    ...base,
    actor: jarvis,
    decision: 'Keep the feature local-only.',
    evidence:
      'Project context revision 7 and README Local-only section both explicitly retain local-only scope.',
  };
  const result = await operate('handoff-product-decision', decision, f.rpc);
  assert.equal(result.phase, 'answer-ready');
  assert(!result.receipt);
  assert.equal(f.cards[1].agentId, 'gilfoyle');
  const answer = JSON.parse(f.cards[1].metadata.comments.find((c) => c.id === result.answer).body);
  assert.equal(answer.data.correlation, 'product-agent-decision');
  assert(
    !Object.hasOwn(answer.data, 'channel') &&
      !Object.hasOwn(answer.data, 'message') &&
      !Object.hasOwn(answer.data, 'replyTo'),
  );
  await operate('handoff-product-decision', decision, f.rpc);
  await operate(
    'handoff-apply',
    {
      ...base,
      actor: gilfoyle,
      application: 'Applied the recorded Jarvis product decision to the Feature scope.',
      replacementRequired: false,
    },
    f.rpc,
  );
  assert.equal(f.cards[1].status, 'todo');
});

for (const reason of ['engineering-question', 'retained-user-decision'])
  test(`Jarvis cannot answer ${reason} without the user`, async () => {
    const f = fixture();
    f.cards.splice(2);
    f.cards[1].notes += `\nProject identity: ${id(200)}`;
    const base = { boardId: 'project', id: id(2), checkpoint: id(231) },
      gilfoyle = `agent:gilfoyle:jarvis-gilfoyle:${id(2)}`,
      jarvis = `agent:main:jarvis-gilfoyle:${id(2)}`;
    await operate(
      'handoff',
      {
        ...base,
        actor: gilfoyle,
        reason,
        question: 'A retained decision is required.',
        resolution: 'Ask the user.',
      },
      f.rpc,
    );
    await assert.rejects(
      operate(
        'handoff-product-decision',
        { ...base, actor: jarvis, decision: 'Do it.', evidence: 'No user evidence.' },
        f.rpc,
      ),
      /Only an undelivered product/,
    );
    assert.equal(f.cards[1].agentId, 'main');
    assert.equal(f.cards[1].status, 'blocked');
  });

test('native intake creates a same-tenant Feature then prepares its Work item without replacing identity', async () => {
  const f = fixture();
  f.cards.splice(1);
  const created = await f.rpc('workboard.cards.create', {
    boardId: 'project',
    tenant: 'project:project',
    idempotencyKey: 'feature:project:request-1',
    agentId: 'gilfoyle',
    status: 'todo',
    notes: 'Type: feature',
    labels: ['type:feature'],
  });
  const feature = structuredClone(created.card);
  f.cards.push({
    id: id(3),
    agentId: 'gilfoyle',
    status: 'todo',
    updatedAt: Date.now(),
    notes: `Type: work-item\nFeature: ${feature.id}\nRequires Work items: none`,
    metadata: {
      automation: {
        boardId: 'project',
        tenant: feature.id,
        idempotencyKey: `work-item:${feature.id}:implementation`,
      },
    },
  });
  await operate('prepare', f.prepare, f.rpc, f.git);
  assert.deepEqual(f.cards[1], feature);
});

for (const malformed of ['tenant-only', 'duplicate', 'archived', 'namespace', 'label'])
  test(`project information rejects ${malformed}`, async () => {
    const f = fixture();
    if (malformed === 'archived') f.cards[0].metadata.archivedAt = 1;
    else if (malformed === 'namespace') f.cards[0].metadata.automation.tenant = 'wrong';
    else
      f.cards.push({
        ...structuredClone(f.cards[0]),
        id: id(88),
        notes: malformed === 'duplicate' ? f.cards[0].notes : 'Malformed',
        labels: malformed === 'label' ? ['type:project-info'] : [],
        metadata: {
          automation: {
            boardId: 'project',
            tenant: 'project:project',
            idempotencyKey: malformed === 'duplicate' ? 'project-info:project' : 'other',
          },
        },
      });
    await assert.rejects(operate('prepare', f.prepare, f.rpc));
  });

const question = (idValue = id(2), checkpoint = id(70)) => ({
  boardId: 'project',
  id: idValue,
  checkpoint,
  actor: 'agent:gilfoyle:main',
  reason: 'operational-blocker',
  question: 'Which approved scope should continue?',
  resolution: 'Owner selects scope and manager applies it.',
});
const receipt = (q) => ({
  boardId: q.boardId,
  id: q.id,
  checkpoint: q.checkpoint,
  actor: 'agent:main:main',
  delivery: 'sent',
  channel: route,
  message: `sent-${q.checkpoint}`,
});
const answer = (q) => ({
  boardId: q.boardId,
  id: q.id,
  checkpoint: q.checkpoint,
  actor: 'agent:main:main',
  channel: route,
  replyTo: `sent-${q.checkpoint}`,
  message: `reply-${q.checkpoint}`,
  answer: 'Continue the approved scope.',
});
const confirmation = (q, decision = 'affirm') => ({
  boardId: q.boardId,
  id: q.id,
  checkpoint: q.checkpoint,
  actor: 'agent:main:main',
  channel: route,
  previousMessage: `sent-${q.checkpoint}`,
  message: `adjacent-${q.checkpoint}`,
  answer: decision === 'affirm' ? 'Yes, please do.' : 'No, cancel that.',
  decision,
});
const application = (q) => ({
  boardId: q.boardId,
  id: q.id,
  checkpoint: q.checkpoint,
  actor: 'agent:gilfoyle:main',
  application: 'Applied selected scope; existing accepted output retained.',
  replacementRequired: false,
});

function fillMetadata(card, bytes) {
  const extra = Array.from({ length: 12 }, (_, i) => ({
    id: id(800 + i),
    body: 'x',
    createdAt: 1,
  }));
  (card.metadata.comments ??= []).push(...extra);
  let remaining = bytes - Buffer.byteLength(JSON.stringify(card.metadata));
  assert(remaining >= 0);
  for (const comment of extra) {
    const add = Math.min(1999, remaining);
    comment.body += 'x'.repeat(add);
    remaining -= add;
  }
  assert.equal(remaining, 0);
  assert.equal(Buffer.byteLength(JSON.stringify(card.metadata)), bytes);
}

for (const target of ['question', 'archive'])
  test(`metadata byte preflight rejects ${target} before native-style trimming can delete evidence`, async () => {
    const f = target === 'archive' ? await replacementFixture() : fixture(),
      c = f.cards[target === 'archive' ? 2 : 1];
    c.metadata.proof = [{ id: id(700), status: 'passed', note: 'Retain the whole proof.' }];
    c.metadata.artifacts = [
      { id: id(701), path: '/retained/artifact', label: 'Retain the whole artifact.' },
    ];
    fillMetadata(c, 24500);
    const before = structuredClone(c);
    let mutations = 0;
    const rpc = async (method, p) => {
      if (['workboard.cards.comment', 'workboard.cards.update'].includes(method)) mutations++;
      const result = await f.rpc(method, p);
      if (method === 'workboard.cards.comment') {
        while (Buffer.byteLength(JSON.stringify(c.metadata)) > 24576) {
          const key = ['proof', 'artifacts', 'comments'].find((k) => c.metadata[k]?.length);
          c.metadata[key].shift();
          if (!c.metadata[key].length) delete c.metadata[key];
        }
      }
      return result;
    };
    await assert.rejects(
      operate(
        target === 'archive' ? 'prepare' : 'handoff',
        target === 'archive' ? f.replacement(2) : question(),
        rpc,
        f.git,
      ),
      /metadata byte capacity/,
    );
    assert.equal(mutations, 0);
    assert.deepEqual(c, before);
  });

test('question preflight reserves remaining required phases even when its immediate comment fits', async () => {
  const f = fixture(),
    c = f.cards[1],
    q = question();
  fillMetadata(c, 22000);
  const body = JSON.stringify({
    card: c.id,
    checkpoint: q.checkpoint,
    kind: 'question',
    actor: q.actor,
    data: { reason: q.reason, question: q.question, resolution: q.resolution, source: route },
  });
  assertCommentCapacity(c, [body]);
  const before = structuredClone(c);
  await assert.rejects(operate('handoff', q, f.rpc), /metadata byte capacity/);
  assert.deepEqual(c, before);
});

test('metadata preflight counts UTF-8 and nested JSON escaping, including native comment overhead', () => {
  const c = { metadata: { proof: [{ note: 'retained' }], artifacts: [{ path: '/retained' }] } };
  const body = JSON.stringify({ answer: '\uffff'.repeat(600) + '\u0000'.repeat(100) });
  assert(body.length < 2000);
  assert(Buffer.byteLength(JSON.stringify(body)) > body.length);
  const size = assertCommentCapacity(c, [body]);
  const exact = {
    ...c.metadata,
    comments: [{ id: id(0), body, createdAt: Number.MAX_SAFE_INTEGER }],
  };
  assert.equal(size, Buffer.byteLength(JSON.stringify(exact)));
  fillMetadata(c, 24576 - (size - Buffer.byteLength(JSON.stringify(c.metadata))) - 1); // Existing array adds one comma, not a new property.
  const at = assertCommentCapacity(c, [body]);
  assert(at <= 24576);
  c.metadata.comments.at(-1).body += 'x'.repeat(24577 - at);
  assert.throws(() => assertCommentCapacity(c, [body]), /metadata byte capacity/);
  const skeleton = JSON.stringify({ answer: '' });
  assert(
    assertCommentCapacity({ metadata: {} }, [], [{ body: skeleton, textLimit: 700 }]) >=
      assertCommentCapacity({ metadata: {} }, [body]),
  );
});

test('a final application comment already persisted can finish its missing marker at the byte limit', async () => {
  const f = fixture(),
    q = question(),
    c = f.cards[1];
  c.metadata.proof = [{ id: id(700), status: 'passed', note: 'Keep proof' }];
  c.metadata.artifacts = [{ id: id(701), path: '/retained' }];
  await operate('handoff', q, f.rpc);
  await operate('handoff-receipt', receipt(q), f.rpc);
  await operate('handoff-answer', answer(q), f.rpc);
  f.failAfter('workboard.cards.comment');
  await assert.rejects(operate('handoff-apply', application(q), f.rpc), /Ambiguous/);
  fillMetadata(c, 24576);
  const before = structuredClone(c.metadata),
    comments = f.calls.filter((x) => x.method === 'workboard.cards.comment').length;
  await operate('handoff-apply', application(q), f.rpc);
  assert.deepEqual(c.metadata, before);
  assert.equal(f.calls.filter((x) => x.method === 'workboard.cards.comment').length, comments);
  assert.equal(c.status, 'todo');
});

test('an existing replacement archive is not charged twice during byte-tight CAS recovery', async () => {
  const f = await replacementFixture(),
    p = f.replacement(2),
    c = f.cards[2];
  f.failAfter('workboard.cards.comment');
  await assert.rejects(operate('prepare', p, f.rpc, f.git), /Ambiguous/);
  const claim = {
    ownerId: 'gilfoyle',
    token: c.id,
    claimedAt: Number.MAX_SAFE_INTEGER,
    lastHeartbeatAt: Number.MAX_SAFE_INTEGER,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  const acceptance = `Accepted delegation ${c.id}-a2: ${JSON.stringify({ taskId: c.id, wrapperTaskId: c.id, runId: c.id, childSessionKey: `agent:opencode:acp:${c.id}` })}`;
  const current = Buffer.byteLength(JSON.stringify(c.metadata)),
    reserved = assertCommentCapacity(
      { ...c, metadata: { ...c.metadata, claim } },
      [],
      [{ body: acceptance, textLimit: 0 }],
    );
  fillMetadata(c, current + 24576 - reserved);
  const before = structuredClone(c.metadata);
  await operate('prepare', p, f.rpc, f.git);
  assert.deepEqual(c.metadata, before);
  assert.equal(reconciledAttempts(c).length, 1);
});

test('an accepted delegation comment can finish its missing marker without reserving another receipt', async () => {
  const f = fixture(),
    c = f.cards[2];
  await operate('prepare', f.prepare, f.rpc, f.git);
  f.claim(c);
  f.tasks.push(
    ...['acp', 'subagent'].map((runtime, n) => ({
      taskId: id(10 + n),
      runtime,
      agentId: 'opencode',
      runId: f.record.runId,
      childSessionKey: f.record.childSessionKey,
      sessionKey: 'agent:gilfoyle:main',
      ownerKey: 'agent:gilfoyle:main',
      status: 'completed',
      endedAt: Date.now() + 100,
      prompt: `Work item: ${c.id} Task name: wi-test-a1`,
    })),
  );
  f.failAfter('workboard.cards.comment');
  await assert.rejects(operate('record', f.record, f.rpc), /Ambiguous/);
  c.metadata.proof = [{ status: 'passed', note: 'Retain proof' }];
  c.metadata.artifacts = [{ path: '/retained' }];
  fillMetadata(c, 24576);
  const before = structuredClone(c.metadata);
  delete before.claim;
  const comments = f.calls.filter((x) => x.method === 'workboard.cards.comment').length;
  await operate('record', f.record, f.rpc);
  assert.deepEqual(c.metadata, before);
  assert.equal(currentAttempt(c).taskId, id(10));
  assert.equal(f.calls.filter((x) => x.method === 'workboard.cards.comment').length, comments);
});

for (const mode of ['truncated', 'stripped', 'unbound-prefix'])
  test(`bounded ${mode} prompt cannot prove an unknown active worker unrelated`, async () => {
    const f = fixture(),
      c = f.cards[2];
    const prompt =
      mode === 'truncated'
        ? 'x'.repeat(3999) + '\u2026'
        : mode === 'stripped'
          ? 'Unrelated planning'
          : `Work item: ${id(999)}\nUnbound task provenance`;
    if (mode === 'truncated') {
      assert.equal(prompt.length, 4000);
      assert(prompt.endsWith('\u2026'));
    }
    assert(!prompt.includes(c.id));
    f.tasks.push({
      taskId: id(90),
      runtime: 'acp',
      status: 'running',
      prompt,
      createdAt: c.createdAt,
      updatedAt: c.createdAt,
    });
    const before = structuredClone(c);
    await assert.rejects(operate('handoff', question(c.id), f.rpc), /Unbound worker scope/);
    assert.deepEqual(c, before);
    assert(!f.calls.some((x) => x.method === 'workboard.cards.comment'));
  });

async function replacementFixture(status = 'failed') {
  const f = fixture();
  await f.delegate();
  f.tasks.forEach((t) => (t.status = status));
  const head = 'b'.repeat(40),
    remaining = 'Implement only the remaining export validation.';
  const replacement = (attempt) => ({
    ...f.prepare,
    attempt,
    taskName: `wi-${f.prepare.id}-a${attempt}`,
    worktree: `/tmp/repo-worktree-a${attempt}`,
    branch: `work-a${attempt}`,
    baseSha: head,
    inspectedHead: head,
    remaining,
    reconciliation: `Inspected ${head}; retained implementation and passing parser tests. Remaining: ${remaining}`,
    replaces: Object.fromEntries(
      ['attempt', 'taskId', 'wrapperTaskId', 'runId', 'childSessionKey', 'commentId'].map((k) => [
        k,
        currentAttempt(f.cards[2])[k],
      ]),
    ),
  });
  const gitCalls = [];
  const git = (cwd, args) => {
    gitCalls.push({ cwd, args });
    if (args[0] === 'worktree')
      return [2, 3, 4]
        .map((n) => `worktree /tmp/repo-worktree-a${n}\nHEAD ${head}\nbranch refs/heads/work-a${n}`)
        .join('\n\n');
    if (args.includes('--absolute-git-dir') || args.includes('--git-common-dir'))
      return '/tmp/repo/.git';
    if (args.includes('--show-toplevel')) return cwd;
    if (args[0] === 'symbolic-ref')
      return cwd === f.prepare.worktree ? f.prepare.branch : `work-a${cwd.split('-a').at(-1)}`;
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return head;
    if (args[0] === 'status' || args[0] === 'merge-base') return '';
    throw Error(`Unexpected replacement Git inspection ${args}`);
  };
  const rpc = async (method, p) =>
    method === 'sessions.list'
      ? {
          sessions: [
            ...new Map(
              f.tasks
                .filter((t) => t.childSessionKey)
                .map((t) => [
                  t.childSessionKey,
                  {
                    key: t.childSessionKey,
                    hasActiveRun: false,
                    hasActiveSubagentRun: false,
                    lastRunId: t.runId,
                  },
                ]),
            ).values(),
          ],
          hasMore: false,
        }
      : f.rpc(method, p);
  return { ...f, replacement, git, gitCalls, rpc };
}

for (const outcome of ['failed', 'cancelled', 'completed'])
  test(`same Work item resumes after ${outcome} through reconciled attempt 2 and retains accepted history`, async () => {
    const f = await replacementFixture(outcome),
      c = f.cards[2],
      q = question(c.id);
    c.metadata.failureCount = 3;
    c.metadata.proof = [
      { status: 'passed', note: 'Prior parser accepted; retain its implementation.' },
    ];
    const prior = currentAttempt(c),
      priorTasks = structuredClone(f.tasks),
      proof = structuredClone(c.metadata.proof),
      identity = structuredClone(c.metadata.automation);
    await operate('handoff', q, f.rpc);
    await operate('handoff-receipt', receipt(q), f.rpc);
    await operate('handoff-answer', answer(q), f.rpc);
    const applied = await operate(
      'handoff-apply',
      { ...application(q), replacementRequired: true },
      f.rpc,
    );
    assert.equal(applied.replacementPreparationRequired, true);
    assert.equal(applied.executionAuthorized, false);
    assert.equal(currentAttempt(c).taskId, prior.taskId);
    assert.equal(c.status, 'todo');
    const p = f.replacement(2),
      prepared = await operate('prepare', p, f.rpc, f.git);
    assert.equal(prepared.attempt, `${c.id}-a2`);
    assert.equal(prepared.executionAccepted, false);
    assert(prepared.taskPrefix.includes(p.remaining));
    assert.equal(currentAttempt(c).taskId, undefined);
    assert.equal(
      classifyCards(f.cards, { available: true, tasks: f.tasks }).get(c.id).stage,
      'acceptance-uncertain',
    );
    const archive = reconciledAttempts(c)[0];
    assert.deepEqual(archive.prior, {
      ...prior,
      baseSha: f.prepare.baseSha,
      worktree: f.prepare.worktree,
      branch: f.prepare.branch,
    });
    assert.deepEqual(archive.next, {
      ...Object.fromEntries(Object.entries(p).filter(([k]) => !['boardId', 'id'].includes(k))),
      model: prepared.profile.model,
      thinking: prepared.profile.thinking,
    });
    assert(c.metadata.comments.some((x) => x.id === prior.commentId));
    assert.deepEqual(f.tasks, priorTasks);
    assert.deepEqual(c.metadata.proof, proof);
    assert.deepEqual(c.metadata.automation, identity);
    assert.equal(c.metadata.failureCount, 3);
    const comments = c.metadata.comments.length;
    assert.equal((await operate('prepare', p, f.rpc, f.git)).reused, true);
    assert.equal(c.metadata.comments.length, comments);
    await assert.rejects(operate('record', f.record, f.rpc), /Prior execution/);
    f.claim(c);
    const refs = {
      boardId: p.boardId,
      id: c.id,
      attempt: 2,
      runId: id(22),
      childSessionKey: `agent:opencode:acp:${id(23)}`,
      taskId: id(20),
      wrapperTaskId: id(21),
    };
    f.tasks.push(
      ...['acp', 'subagent'].map((runtime, n) => ({
        taskId: id(20 + n),
        runtime,
        agentId: 'opencode',
        runId: refs.runId,
        childSessionKey: refs.childSessionKey,
        sessionKey: 'agent:gilfoyle:main',
        ownerKey: 'agent:gilfoyle:main',
        status: 'completed',
        endedAt: Date.now() + 100,
        prompt: prepared.taskPrefix,
      })),
    );
    await operate('record', refs, f.rpc);
    assert.equal(currentAttempt(c).taskId, id(20));
    assert.equal(currentAttempt(c).attempt, `${c.id}-a2`);
    assert.deepEqual(f.tasks.slice(0, 2), priorTasks);
    assert.equal(c.metadata.failureCount, 3);
    assert.deepEqual(c.metadata.proof, proof);
    await assert.rejects(operate('prepare', p, f.rpc, f.git), /already accepted/);
    const q2 = question(c.id, id(71));
    await operate('handoff', q2, f.rpc);
    await operate('handoff-receipt', receipt(q2), f.rpc);
    await operate('handoff-answer', answer(q2), f.rpc);
    await operate('handoff-apply', { ...application(q2), replacementRequired: true }, f.rpc);
    await operate('prepare', f.replacement(3), f.rpc, f.git);
    assert.equal(currentAttempt(c).attempt, `${c.id}-a3`);
    assert.equal(reconciledAttempts(c).length, 2);
    assert.equal(f.cards.length, 3);
    assert(
      !f.calls.some((x) =>
        ['workboard.cards.create', 'workboard.cards.block', 'workboard.cards.reassign'].includes(
          x.method,
        ),
      ),
    );
    assert(
      f.gitCalls.every((x) =>
        ['rev-parse', 'symbolic-ref', 'status', 'merge-base', 'worktree'].includes(x.args[0]),
      ),
    );
  });

for (const method of ['workboard.cards.comment', 'workboard.cards.update'])
  test(`replacement preparation recovers ambiguous ${method} without another archive or attempt`, async () => {
    const f = await replacementFixture(),
      p = f.replacement(2);
    f.failAfter(method);
    await assert.rejects(operate('prepare', p, f.rpc, f.git));
    await assert.rejects(operate('prepare', { ...p, remaining: 'Changed scope' }, f.rpc, f.git));
    await operate(
      'prepare',
      { ...p, replaces: Object.fromEntries(Object.entries(p.replaces).reverse()) },
      f.rpc,
      f.git,
    );
    await operate('prepare', p, f.rpc, f.git);
    assert.equal(reconciledAttempts(f.cards[2]).length, 1);
    assert.equal(currentAttempt(f.cards[2]).attempt, `${p.id}-a2`);
    assert.equal(
      f.cards[2].metadata.comments.filter((x) => x.body.startsWith('Reconciled attempt:')).length,
      1,
    );
  });

for (const fault of [
  'running-task',
  'active-session',
  'active-subagent',
  'unknown-session',
  'missing-session',
  'unresolved',
  'wrong-prior',
  'skip-attempt',
  'reused-name',
  'reused-worktree',
  'reused-branch',
  'dirty-old',
  'dirty-new',
  'head-drift',
  'wrong-repo',
  'discarded-head',
])
  test(`replacement rejects ${fault} before archiving`, async () => {
    const f = await replacementFixture(),
      p = f.replacement(2);
    let rpc = f.rpc,
      git = f.git;
    if (fault === 'running-task') f.tasks[0].status = 'running';
    if (['active-session', 'active-subagent', 'unknown-session', 'missing-session'].includes(fault))
      rpc = async (method, args) => {
        const r = await f.rpc(method, args);
        if (method === 'sessions.list') {
          if (fault === 'missing-session') r.sessions = [];
          else if (fault === 'unknown-session') delete r.sessions[0].hasActiveRun;
          else if (fault === 'active-subagent') r.sessions[0].hasActiveSubagentRun = true;
          else r.sessions[0].hasActiveRun = true;
        }
        return r;
      };
    if (fault === 'unresolved')
      f.cards[2].notes = f.cards[2].notes.replace(
        `Task ID: ${id(10)}`,
        'Task ID: unresolved acceptance',
      );
    if (fault === 'wrong-prior') p.replaces.runId = id(88);
    if (fault === 'skip-attempt') {
      p.attempt = 3;
      p.taskName = `wi-${p.id}-a3`;
    }
    if (fault === 'reused-name') p.taskName = f.prepare.taskName;
    if (fault === 'reused-worktree') p.worktree = f.prepare.worktree;
    if (fault === 'reused-branch') p.branch = f.prepare.branch;
    if (['dirty-old', 'dirty-new', 'head-drift', 'wrong-repo', 'discarded-head'].includes(fault))
      git = (cwd, args) => {
        if (
          args[0] === 'status' &&
          ((fault === 'dirty-old' && cwd === f.prepare.worktree) ||
            (fault === 'dirty-new' && cwd === p.worktree))
        )
          return ' M retained.js';
        if (fault === 'head-drift' && args[0] === 'rev-parse' && args[1] === 'HEAD')
          return 'c'.repeat(40);
        if (fault === 'wrong-repo' && cwd !== '/tmp/repo' && args.includes('--git-common-dir'))
          return '/tmp/wrong/.git';
        if (fault === 'discarded-head' && cwd === p.worktree && args[0] === 'merge-base')
          throw Error('Surviving commit not retained');
        return f.git(cwd, args);
      };
    await assert.rejects(operate('prepare', p, rpc, git));
    assert.equal(
      f.cards[2].metadata.comments.filter((x) => x.body.startsWith('Reconciled attempt:')).length,
      0,
    );
  });

for (const race of ['cas', 'stop', 'held-parent', 'git-drift', 'duplicate-comment'])
  test(`replacement ${race} race keeps prior native identity and archive recoverable`, async () => {
    const f = await replacementFixture(),
      p = f.replacement(2),
      prior = currentAttempt(f.cards[2]);
    let drift = false;
    const rpc = async (method, args) => {
      if (race === 'cas' && method === 'workboard.cards.update') f.cards[2].updatedAt++;
      const r = await f.rpc(method, args);
      if (method === 'workboard.cards.comment') {
        if (race === 'stop')
          f.cards.push({
            id: id(88),
            status: 'todo',
            updatedAt: 1,
            notes: 'Type: action',
            metadata: { automation: { boardId: 'project', tenant: id(2) } },
          });
        if (race === 'held-parent') f.cards[1].status = 'blocked';
        if (race === 'git-drift') drift = true;
        if (race === 'duplicate-comment')
          f.cards[2].metadata.comments.push({ ...f.cards[2].metadata.comments.at(-1), id: id(89) });
      }
      return r;
    };
    await assert.rejects(
      operate('prepare', p, rpc, (cwd, args) =>
        drift && args[0] === 'status' ? '?? uninspected.txt' : f.git(cwd, args),
      ),
    );
    assert.deepEqual(currentAttempt(f.cards[2]), prior);
    assert.equal(f.cards.length, race === 'stop' ? 4 : 3);
  });

for (const method of [
  'workboard.cards.comment',
  'workboard.cards.release',
  'workboard.cards.update',
])
  test(`attempt 2 record recovers ambiguous ${method} with exact new scope and receipts`, async () => {
    const f = await replacementFixture(),
      p = f.replacement(2),
      prepared = await operate('prepare', p, f.rpc, f.git);
    f.claim(f.cards[2]);
    const r = {
      boardId: p.boardId,
      id: p.id,
      attempt: 2,
      runId: id(22),
      childSessionKey: `agent:opencode:acp:${id(23)}`,
      taskId: id(20),
      wrapperTaskId: id(21),
    };
    f.tasks.push(
      ...['acp', 'subagent'].map((runtime, n) => ({
        taskId: id(20 + n),
        runtime,
        agentId: 'opencode',
        runId: r.runId,
        childSessionKey: r.childSessionKey,
        sessionKey: 'agent:gilfoyle:main',
        ownerKey: 'agent:gilfoyle:main',
        status: 'completed',
        endedAt: Date.now() + 100,
        prompt: prepared.taskPrefix,
      })),
    );
    f.failAfter(method);
    await assert.rejects(operate('record', r, f.rpc));
    await operate('record', r, f.rpc);
    assert.equal(currentAttempt(f.cards[2]).taskId, id(20));
    assert.equal(reconciledAttempts(f.cards[2]).length, 1);
    assert.equal(
      f.cards[2].metadata.comments.filter((x) =>
        x.body.startsWith(`Accepted delegation ${p.id}-a2:`),
      ).length,
      1,
    );
  });

test('long native task history stops at a proved older-than-card boundary without cursor pagination', async () => {
  const f = await replacementFixture(),
    created = f.cards[2].createdAt;
  f.tasks.push(
    ...Array.from({ length: 650 }, (_, i) => ({
      taskId: id(1000 + i),
      runtime: 'acp',
      createdAt: created - 100,
      updatedAt: created - 50,
      status: 'completed',
    })),
  );
  const rpc = async (method, p) => {
    const r = await f.rpc(method, p);
    if (method === 'tasks.list') {
      assert.equal(p.limit, 500);
      assert.equal(p.sortBy, 'updatedAt');
      assert(!p.cursor);
      return { tasks: r.tasks.slice(0, 500), nextCursor: 'connection-bound-older-history' };
    }
    return r;
  };
  await operate('handoff', question(id(3)), rpc);
  const q = question(id(3));
  await operate('handoff-receipt', receipt(q), rpc);
  await operate('handoff-answer', answer(q), rpc);
  await operate('handoff-apply', { ...application(q), replacementRequired: true }, rpc);
  await operate('prepare', f.replacement(2), rpc, f.git);
  assert.equal(currentAttempt(f.cards[2]).attempt, `${id(3)}-a2`);
  assert(
    f.calls
      .filter((x) => x.method === 'tasks.get')
      .every((x) => [id(10), id(11)].includes(x.p.taskId)),
  );
});

for (const fault of [
  'incomplete',
  'unsorted',
  'duplicate',
  'missing-time',
  'unbound-no-summary-prompt',
  'missing-exact-prompt',
])
  test(`handoff relevant task window rejects ${fault}`, async () => {
    const f = fixture(),
      q = question(id(3));
    f.tasks.push({
      taskId: id(80),
      runtime: 'acp',
      createdAt: f.cards[2].createdAt,
      updatedAt: f.cards[2].createdAt,
      prompt: fault === 'missing-exact-prompt' ? undefined : `Work item: ${id(3)}`,
      status: 'completed',
    });
    const rpc = async (method, p) => {
      const r = await f.rpc(method, p);
      if (method === 'tasks.list') {
        if (fault === 'incomplete') r.nextCursor = 'more';
        if (fault === 'unsorted')
          r.tasks.push({ ...r.tasks[0], taskId: id(81), updatedAt: r.tasks[0].updatedAt + 1 });
        if (fault === 'duplicate') r.tasks.push(r.tasks[0]);
        if (fault === 'missing-time') delete r.tasks[0].updatedAt;
        assert(
          r.tasks.every((t) => t.prompt === undefined),
          'Native list does not include prompts',
        );
      }
      return r;
    };
    await assert.rejects(operate('handoff', q, rpc));
    assert.equal(f.cards[2].agentId, 'gilfoyle');
  });

test('3300-character Feature scope fits all handoff phases without truncation', async () => {
  const f = fixture(),
    q = question();
  f.cards[1].notes += '\nScope: ' + 'x'.repeat(3300 - f.cards[1].notes.length - 8);
  const scope = f.cards[1].notes;
  assert.equal(scope.length, 3300);
  await operate('handoff', q, f.rpc);
  await operate('handoff-receipt', receipt(q), f.rpc);
  await operate('handoff-answer', answer(q), f.rpc);
  await operate('handoff-apply', application(q), f.rpc);
  assert(f.cards[1].notes.startsWith(scope + '\nHandoff: '));
  assert(f.cards[1].notes.length < 3600);
});

test('handoff reserves the exact full marker at the native notes boundary', async () => {
  for (const over of [false, true]) {
    const f = fixture(),
      q = question();
    const reserve =
      `\nHandoff: ${JSON.stringify({ checkpoint: q.checkpoint, phase: 'applied', question: q.checkpoint, receipt: q.checkpoint, answer: q.checkpoint, application: q.checkpoint })}`
        .length;
    f.cards[1].notes +=
      '\nScope: ' + 'x'.repeat(4000 - reserve - f.cards[1].notes.length - 8 + (over ? 1 : 0));
    if (over) {
      await assert.rejects(operate('handoff', q, f.rpc), /capacity/);
      assert(!f.cards[1].metadata.comments);
    } else {
      await operate('handoff', q, f.rpc);
      await operate('handoff-receipt', receipt(q), f.rpc);
      await operate('handoff-answer', answer(q), f.rpc);
      await operate('handoff-apply', application(q), f.rpc);
      assert.equal(f.cards[1].notes.length, 4000);
    }
  }
});

for (const part of ['channel', 'account', 'recipient', 'thread'])
  test(`receipt cannot change retained delivery ${part}`, async () => {
    const f = fixture(),
      q = question();
    await operate('handoff', q, f.rpc);
    const wrong = route.replace(new RegExp(`${part}=[^;]+`), `${part}=other`);
    await assert.rejects(
      operate('handoff-receipt', { ...receipt(q), channel: wrong }, f.rpc),
      /source mismatch/,
    );
    assert.equal(f.cards[1].metadata.comments.length, 1);
  });

test('retained source ambiguity, contradiction and post-send drift never authorize guessed replies', async () => {
  for (const delivery of [
    'Delivery: Telegram default to other',
    'Delivery: current-source internal-ui',
    'Delivery: ambiguous owner route\nDelivery source: ' + route,
  ]) {
    const f = fixture();
    f.cards[1].notes = 'Type: feature\n' + delivery;
    if (delivery.startsWith('Delivery: Telegram')) {
      await operate('handoff', question(), f.rpc);
      await assert.rejects(
        operate('handoff-receipt', receipt(question()), f.rpc),
        /source mismatch/,
      );
    } else await assert.rejects(operate('handoff', question(), f.rpc), /source|context/);
  }
  const f = fixture(),
    q = question();
  await operate('handoff', q, f.rpc);
  await operate('handoff-receipt', receipt(q), f.rpc);
  await assert.rejects(
    operate('handoff-answer', { ...answer(q), replyTo: undefined }, f.rpc),
    /correlation/,
  );
  f.cards[1].notes = f.cards[1].notes.replace(route, route.replace('thread=none', 'thread=other'));
  assert.equal(classifyCards(f.cards).get(id(2)).stage, 'handoff-uncertain');
  await assert.rejects(operate('handoff-answer', answer(q), f.rpc), /source changed/);
  assert.equal(f.cards[1].agentId, 'main');
  assert.equal(f.cards[1].status, 'blocked');
});

test('adjacent affirmative confirmation records truthful answer evidence without reply metadata', async () => {
  const decision = 'affirm';
  const f = fixture(),
    q = question();
  await operate('handoff', q, f.rpc);
  await operate('handoff-receipt', receipt(q), f.rpc);
  const result = await operate('handoff-confirm', confirmation(q, decision), f.rpc);
  assert.equal(result.phase, 'answer-ready');
  assert.equal(f.cards[1].agentId, 'gilfoyle');
  assert.equal(f.cards[1].status, 'blocked');
  const comment = f.cards[1].metadata.comments.find((row) => {
      try {
        return JSON.parse(row.body).kind === 'answer';
      } catch {
        return false;
      }
    }),
    data = JSON.parse(comment.body).data;
  assert.deepEqual(data, {
    correlation: 'adjacent-confirmation',
    channel: route,
    previousMessage: `sent-${q.checkpoint}`,
    message: `adjacent-${q.checkpoint}`,
    answer: decision === 'affirm' ? 'Yes, please do.' : 'No, cancel that.',
    decision,
  });
  assert(!Object.hasOwn(data, 'replyTo'));
  assert(!Object.hasOwn(result, 'replyTo'));
  const count = f.cards[1].metadata.comments.length;
  await operate('handoff-confirm', confirmation(q, decision), f.rpc);
  assert.equal(f.cards[1].metadata.comments.length, count);
});

test('adjacent negative confirmation is rejected before mutation', async () => {
  const f = fixture(),
    q = question();
  await operate('handoff', q, f.rpc);
  await operate('handoff-receipt', receipt(q), f.rpc);
  const before = structuredClone(f.cards),
    writes = f.calls.length;
  await assert.rejects(operate('handoff-confirm', confirmation(q, 'deny'), f.rpc), /affirmative/);
  assert.deepEqual(f.cards, before);
  assert.equal(f.calls.length, writes);
});

test('handoff error output does not expose mismatched private payloads', async () => {
  const f = fixture(),
    q = question();
  await operate('handoff', q, f.rpc);
  await operate('handoff-receipt', receipt(q), f.rpc);
  await operate('handoff-confirm', confirmation(q), f.rpc);
  const secret = 'PRIVATE application and question content';
  let error;
  try {
    await operate('handoff-apply', { ...application(q), application: secret }, f.rpc);
    await operate(
      'handoff-apply',
      { ...application(q), application: 'different ' + secret },
      f.rpc,
    );
  } catch (e) {
    error = e;
  }
  const output = handoffError(error);
  assert.deepEqual(output, {
    complete: false,
    code: 'validation-failed',
    error: 'Handoff validation failed; native state was not safely reconciled.',
  });
  assert(!JSON.stringify(output).includes(secret));
});

test('adjacent confirmation requires exactly one sent handoff on the source and exact source/message binding', async () => {
  for (const fault of ['multiple', 'source', 'previous', 'schema']) {
    const f = fixture(),
      q = question();
    await operate('handoff', q, f.rpc);
    await operate('handoff-receipt', receipt(q), f.rpc);
    if (fault === 'multiple') {
      const other = {
        ...structuredClone(f.cards[1]),
        id: id(4),
        metadata: structuredClone(f.cards[1].metadata),
      };
      other.metadata.comments = other.metadata.comments.map((row) => ({
        ...row,
        id: row.id === q.checkpoint ? id(72) : row.id,
        body: row.body.replaceAll(f.cards[1].id, id(4)),
      }));
      f.cards.push(other);
    }
    const input = { ...confirmation(q) };
    if (fault === 'source') input.channel = route.replace('recipient=owner', 'recipient=other');
    if (fault === 'previous') input.previousMessage = 'different-message';
    if (fault === 'schema') input.replyTo = input.previousMessage;
    const before = structuredClone(f.cards);
    await assert.rejects(operate('handoff-confirm', input, f.rpc));
    assert.deepEqual(f.cards, before);
  }
});

test('source-less handoff evidence is invalid at every phase', async () => {
  const f = fixture(),
    q = { ...question(id(3)), question: 'Which task name should this attempt use?' };
  await operate('handoff', q, f.rpc);
  await operate('handoff-receipt', receipt(q), f.rpc);
  await operate('handoff-answer', answer(q), f.rpc);
  await operate('handoff-apply', application(q), f.rpc);
  const comment = f.cards[2].metadata.comments[0],
    old = JSON.parse(comment.body);
  delete old.data.source;
  comment.body = JSON.stringify(old);
  assert.equal(handoffMarker(f.cards[2]).uncertain, true);
  await assert.rejects(operate('prepare', f.prepare, f.rpc), /held/);
  const active = fixture();
  await operate('handoff', question(), active.rpc);
  const e = JSON.parse(active.cards[1].metadata.comments[0].body);
  delete e.data.source;
  active.cards[1].metadata.comments[0].body = JSON.stringify(e);
  assert.equal(classifyCards(active.cards).get(id(2)).stage, 'handoff-uncertain');
  await assert.rejects(operate('handoff-receipt', receipt(question()), active.rpc), /Malformed/);
});

test('an accepted active sibling may mention the blocked card without blocking its handoff or replacement', async () => {
  const f = await replacementFixture();
  const sibling = {
    id: id(4),
    agentId: 'gilfoyle',
    status: 'todo',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    notes: `Type: work-item\nFeature: ${id(2)}\nRequires Work items: none`,
    metadata: { automation: { boardId: 'project', tenant: id(2) } },
  };
  f.cards.push(sibling);
  const p = {
    ...f.prepare,
    id: sibling.id,
    taskName: 'sibling-a1',
    worktree: '/tmp/other-worktree',
    branch: 'other-a1',
  };
  const git = (cwd, args) => {
    if (args[0] === 'worktree')
      return `${f.git(cwd, args)}\n\nworktree ${p.worktree}\nHEAD ${p.baseSha}\nbranch refs/heads/${p.branch}`;
    if (cwd === p.worktree && args[0] === 'symbolic-ref') return p.branch;
    if (cwd === p.worktree && args[0] === 'rev-parse' && args[1] === 'HEAD') return p.baseSha;
    return f.git(cwd, args);
  };
  const prepared = await operate('prepare', p, f.rpc, git);
  f.claim(sibling);
  const boundedPrompt = (prepared.taskPrefix + 'x'.repeat(4100)).slice(0, 3999) + '\u2026';
  f.tasks.push(
    ...['acp', 'subagent'].map((runtime, n) => ({
      taskId: id(30 + n),
      runtime,
      agentId: 'opencode',
      runId: id(32),
      childSessionKey: `agent:opencode:acp:${id(33)}`,
      sessionKey: 'agent:gilfoyle:main',
      ownerKey: 'agent:gilfoyle:main',
      status: 'running',
      createdAt: sibling.createdAt,
      updatedAt: sibling.createdAt + 100,
      prompt: boundedPrompt,
    })),
  );
  await operate(
    'record',
    {
      boardId: 'project',
      id: sibling.id,
      runId: id(32),
      childSessionKey: `agent:opencode:acp:${id(33)}`,
      taskId: id(30),
      wrapperTaskId: id(31),
    },
    f.rpc,
  );
  const before = structuredClone(sibling),
    rpc = async (method, args) => {
      const r = await f.rpc(method, args);
      if (method === 'sessions.list') {
        const s = r.sessions.find((x) => x.key === `agent:opencode:acp:${id(33)}`);
        s.hasActiveRun = true;
        s.hasActiveSubagentRun = true;
      }
      return r;
    };
  await assert.rejects(operate('handoff', question(), rpc), /not settled|terminal/);
  const q = question(id(3));
  await operate('handoff', q, rpc);
  await operate('handoff-receipt', receipt(q), rpc);
  await operate('handoff-answer', answer(q), rpc);
  await operate('handoff-apply', { ...application(q), replacementRequired: true }, rpc);
  await operate('prepare', f.replacement(2), rpc, f.git);
  assert.deepEqual(sibling, before);
  assert(f.tasks.slice(2).every((t) => t.status === 'running'));
});

for (const hold of ['parent', 'target', 'wait', 'dependency', 'stop'])
  test(`replacement preparation preserves the ${hold} admission guard`, async () => {
    const f = await replacementFixture(),
      p = f.replacement(2);
    if (hold === 'parent') f.cards[1].labels = ['user-held'];
    if (hold === 'target') f.cards[2].status = 'blocked';
    if (hold === 'wait') f.cards[2].notes += '\nWait: external';
    if (hold === 'dependency') {
      f.cards.push({
        id: id(88),
        agentId: 'gilfoyle',
        status: 'blocked',
        updatedAt: 1,
        notes: `Type: work-item\nFeature: ${id(2)}`,
        metadata: { automation: { boardId: 'project', tenant: id(2) } },
      });
      f.cards[2].notes = f.cards[2].notes.replace(
        'Requires Work items: none',
        `Requires Work items: ${id(88)}`,
      );
    }
    if (hold === 'stop')
      f.cards.push({
        id: id(89),
        status: 'todo',
        updatedAt: 1,
        notes: 'Type: action',
        metadata: { automation: { boardId: 'project', tenant: id(2) } },
      });
    await assert.rejects(operate('prepare', p, f.rpc, f.git));
    assert.equal(reconciledAttempts(f.cards[2]).length, 0);
  });

test('attempt 2 cannot record a blind rerun or accept a corrupted archive', async () => {
  const f = await replacementFixture(),
    p = f.replacement(2),
    prepared = await operate('prepare', p, f.rpc, f.git);
  f.claim(f.cards[2]);
  const r = {
    boardId: p.boardId,
    id: p.id,
    runId: id(22),
    childSessionKey: `agent:opencode:acp:${id(23)}`,
    taskId: id(20),
    wrapperTaskId: id(21),
  };
  f.tasks.push(
    ...['acp', 'subagent'].map((runtime, n) => ({
      taskId: id(20 + n),
      runtime,
      agentId: 'opencode',
      runId: r.runId,
      childSessionKey: r.childSessionKey,
      sessionKey: 'agent:gilfoyle:main',
      ownerKey: 'agent:gilfoyle:main',
      status: 'running',
      prompt: prepared.taskPrefix.replace(
        `Remaining assignment: ${p.remaining}\n`,
        'Repeat the previous implementation.',
      ),
    })),
  );
  await assert.rejects(operate('record', r, f.rpc), /remaining assignment/);
  const comment = f.cards[2].metadata.comments.find((x) =>
    x.body.startsWith('Reconciled attempt: '),
  );
  const data = JSON.parse(comment.body.slice(20));
  data.prior.runId = id(99);
  comment.body = 'Reconciled attempt: ' + JSON.stringify(data);
  await assert.rejects(operate('record', r, f.rpc));
  assert(currentAttempt(f.cards[2]).uncertain);
  assert(
    !f.cards[2].metadata.comments.some((x) => x.body.startsWith(`Accepted delegation ${p.id}-a2:`)),
  );
});

test('native omitted descendant flag is valid only with explicit aggregate inactivity', async () => {
  const f = await replacementFixture(),
    p = f.replacement(2);
  const rpc = async (method, args) => {
    const r = await f.rpc(method, args);
    if (method === 'sessions.list') r.sessions.forEach((s) => delete s.hasActiveSubagentRun);
    return r;
  };
  await operate('prepare', p, rpc, f.git);
  assert.equal(currentAttempt(f.cards[2]).attempt, `${p.id}-a2`);
});

test('an accepted but unrecorded new spawn blocks preparation reuse instead of offering a second launch', async () => {
  const f = await replacementFixture(),
    p = f.replacement(2),
    prepared = await operate('prepare', p, f.rpc, f.git);
  f.tasks.push({
    taskId: id(20),
    runtime: 'acp',
    agentId: 'opencode',
    runId: id(22),
    childSessionKey: `agent:opencode:acp:${id(23)}`,
    sessionKey: 'agent:gilfoyle:main',
    ownerKey: 'agent:gilfoyle:main',
    status: 'queued',
    prompt: prepared.taskPrefix,
  });
  await assert.rejects(operate('prepare', p, f.rpc, f.git), /Unbound worker/);
  assert.equal(reconciledAttempts(f.cards[2]).length, 1);
  assert.equal(currentAttempt(f.cards[2]).taskId, undefined);
});

for (const workItem of [false, true])
  test(`same-card ${workItem ? 'Work item' : 'Feature'} handoff preserves identity, failures and terminal references through two checkpoints`, async () => {
    const f = fixture();
    await f.delegate();
    const c = f.cards[workItem ? 2 : 1];
    c.metadata.failureCount = 2;
    c.metadata.proof = [{ status: 'failed', note: 'Retained history' }];
    const before = structuredClone(c.metadata),
      attempt = currentAttempt(f.cards[2]);
    for (const checkpoint of [id(70), id(71)]) {
      const q = question(c.id, checkpoint);
      assert.equal((await operate('handoff', q, f.rpc)).sendRequired, true);
      assert.equal(c.status, 'blocked');
      assert.equal(c.agentId, 'main');
      assert(!c.metadata.claim);
      const view = await readView(
        { boardId: 'project', agentId: 'main', includeArchived: false, view: 'attention' },
        async (method, p) => {
          assert.equal(method, 'workboard.cards.list');
          return f.rpc(method, p);
        },
      );
      assert.equal(view.total, 1);
      await assert.rejects(operate('handoff-answer', answer(q), f.rpc));
      await operate('handoff-receipt', receipt(q), f.rpc);
      const count = c.metadata.comments.length;
      await operate('handoff-receipt', receipt(q), f.rpc);
      assert.equal(c.metadata.comments.length, count);
      assert.equal((await operate('handoff', q, f.rpc)).sendRequired, false);
      assert.equal(classifyCards(f.cards).get(c.id).stage, 'handoff-waiting-answer');
      if (workItem) {
        assert.equal(classifyCards(f.cards).get(id(2)).stage, 'child-handoff-reconciliation');
        assert.equal(classifyCards(f.cards).get(c.id).controller, 'agent:gilfoyle:main');
        const record = await operate('record', f.record, f.rpc);
        assert.equal(record.status, 'reconciled');
        assert.equal(record.executionAuthorized, false);
      }
      await assert.rejects(
        operate('handoff-answer', { ...answer(q), replyTo: 'wrong' }, f.rpc),
        /correlation/,
      );
      await operate('handoff-answer', answer(q), f.rpc);
      assert.equal(c.agentId, 'gilfoyle');
      assert.equal(c.status, 'blocked');
      await assert.rejects(operate('prepare', f.prepare, f.rpc));
      if (!workItem)
        await assert.rejects(
          operate('handoff-apply', { ...application(q), replacementRequired: true }, f.rpc),
          /Replacement requires/,
        );
      await operate('handoff-apply', { ...application(q), replacementRequired: workItem }, f.rpc);
      assert.equal(c.status, 'todo');
    }
    assert.deepEqual(c.metadata.automation, before.automation);
    assert.deepEqual(c.metadata.proof, before.proof);
    assert.equal(c.metadata.failureCount, before.failureCount);
    assert.deepEqual(currentAttempt(f.cards[2]), attempt);
    assert(
      !f.calls.some((x) =>
        ['workboard.cards.block', 'workboard.cards.reassign', 'workboard.cards.create'].includes(
          x.method,
        ),
      ),
    );
    await assert.rejects(
      operate('handoff-receipt', receipt(question(c.id, id(70))), f.rpc),
      /Stale/,
    );
  });

for (const mutation of ['live', 'claim', 'unresolved', 'duplicate'])
  test(`handoff rejects ${mutation} worker`, async () => {
    const f = fixture();
    await f.delegate();
    if (mutation === 'live') f.tasks[0].status = 'running';
    if (mutation === 'claim') f.claim(f.cards[2]);
    if (mutation === 'unresolved')
      f.cards[2].notes = f.cards[2].notes.replace(
        `Task ID: ${id(10)}`,
        'Task ID: unresolved acceptance',
      );
    if (mutation === 'duplicate')
      f.cards.push({
        ...structuredClone(f.cards[2]),
        id: id(99),
        notes: f.cards[2].notes.replaceAll(id(3), id(99)),
      });
    await assert.rejects(operate('handoff', question(), f.rpc));
    assert(!f.calls.some((x) => x.p.patch?.agentId === 'main'));
  });

for (const method of ['workboard.cards.comment', 'workboard.cards.update'])
  test(`handoff retries ambiguous ${method} without duplicate evidence or send obligation`, async () => {
    const f = fixture(),
      q = question();
    f.failAfter(method);
    await assert.rejects(operate('handoff', q, f.rpc));
    await operate('handoff', q, f.rpc);
    assert.equal(f.cards[1].metadata.comments.length, 1);
    f.failAfter(method);
    await assert.rejects(operate('handoff-receipt', receipt(q), f.rpc));
    assert.equal(
      (await operate('handoff', q, f.rpc)).sendRequired,
      false,
      'Accepted receipt comment suppresses send even before marker reconciliation',
    );
    await operate('handoff-receipt', receipt(q), f.rpc);
    assert.equal(f.cards[1].metadata.comments.length, 2);
    assert.equal((await operate('handoff', q, f.rpc)).sendRequired, false);
  });

test('one waiting child does not stop sibling admission; parent wait and stop do', async () => {
  const f = fixture();
  await f.delegate();
  f.cards.push({
    ...structuredClone(f.cards[2]),
    id: id(4),
    notes: `Type: work-item\nFeature: ${id(2)}\nRequires Work items: none`,
    metadata: { automation: { boardId: 'project', tenant: id(2) } },
  });
  await operate('handoff', question(id(3)), f.rpc);
  const sibling = {
    ...f.prepare,
    id: id(4),
    taskName: 'sibling-a1',
    worktree: '/tmp/sibling-worktree',
    branch: 'sibling-a1',
  };
  await operate('prepare', sibling, f.rpc, f.git);
  f.cards[1].status = 'blocked';
  await assert.rejects(operate('prepare', sibling, f.rpc, f.git), /held/);
  f.cards[1].status = 'todo';
  f.cards.push({
    id: id(66),
    status: 'todo',
    updatedAt: 1,
    notes: 'Type: action',
    metadata: { automation: { boardId: 'project', tenant: id(2) } },
  });
  await assert.rejects(operate('prepare', sibling, f.rpc, f.git), /stop/);
});

test('stop race and terminal cancellation preserve source and never auto-resume', async () => {
  const f = fixture(),
    q = question();
  await operate('handoff', q, f.rpc);
  await operate('handoff-receipt', receipt(q), f.rpc);
  await operate('handoff-answer', answer(q), f.rpc);
  const before = f.cards[1].notes;
  const rpc = async (method, p) => {
    const r = await f.rpc(method, p);
    if (method === 'workboard.cards.comment')
      f.cards.push({
        id: id(66),
        status: 'todo',
        updatedAt: 1,
        notes: 'Type: action',
        metadata: { automation: { boardId: 'project', tenant: id(2) } },
      });
    return r;
  };
  await assert.rejects(operate('handoff-apply', application(q), rpc), /stop/);
  assert.equal(f.cards[1].notes, before);
  f.cards[1].status = 'done';
  await assert.rejects(operate('handoff-apply', application(q), f.rpc));
  assert.equal(f.cards[1].notes, before);
});

test('zero accepted workers never classify as a healthy worker wait', async () => {
  const f = fixture();
  assert.equal(
    classifyCards(f.cards, { available: true, tasks: [] }).get(id(2)).stage,
    'orchestration',
  );
  await operate('prepare', f.prepare, f.rpc, f.git);
  const rows = classifyCards(f.cards, { available: true, tasks: [] });
  assert.equal(rows.get(id(3)).stage, 'acceptance-uncertain');
  assert.equal(rows.get(id(2)).stage, 'orchestration');
});

test('uncertain delivery is actionable, can reconcile exact sent source, and never requests another send', async () => {
  const f = fixture(),
    q = question();
  await operate('handoff', q, f.rpc);
  await assert.rejects(
    operate('handoff-receipt', { ...receipt(q), message: undefined }, f.rpc),
    /receipt/,
  );
  await operate('handoff-receipt', { ...receipt(q), delivery: 'uncertain' }, f.rpc);
  assert.equal(classifyCards(f.cards).get(q.id).stage, 'handoff-uncertain');
  assert.equal((await operate('handoff', q, f.rpc)).sendRequired, false);
  await assert.rejects(operate('handoff-answer', answer(q), f.rpc));
  await assert.rejects(
    operate('handoff-receipt', { ...receipt(q), message: 'another-send' }, f.rpc),
    /Conflicting/,
  );
  await operate('handoff-receipt', receipt(q), f.rpc);
  await operate('handoff-answer', answer(q), f.rpc);
  f.failAfter('workboard.cards.update');
  await assert.rejects(operate('handoff-apply', application(q), f.rpc));
  assert.equal((await operate('handoff-apply', application(q), f.rpc)).reused, true);
});

test('duplicate sent receipt cannot be a quiet human wait', async () => {
  const f = fixture(),
    q = question();
  await operate('handoff', q, f.rpc);
  await operate('handoff-receipt', receipt(q), f.rpc);
  f.cards[1].metadata.comments.push({ ...f.cards[1].metadata.comments.at(-1), id: id(68) });
  assert.equal(classifyCards(f.cards).get(q.id).stage, 'handoff-uncertain');
  await assert.rejects(operate('handoff-answer', answer(q), f.rpc), /Malformed/);
});

test('ambiguous send without a returned message ID is actionable without inventing a receipt', async () => {
  const f = fixture(),
    q = question();
  await operate('handoff', q, f.rpc);
  await operate(
    'handoff-receipt',
    { ...receipt(q), delivery: 'uncertain', message: undefined },
    f.rpc,
  );
  assert.equal((await operate('handoff', q, f.rpc)).sendRequired, false);
  assert.equal(classifyCards(f.cards).get(q.id).stage, 'handoff-uncertain');
  await assert.rejects(operate('handoff-answer', answer(q), f.rpc));
  await operate('handoff-receipt', receipt(q), f.rpc);
  await operate('handoff-answer', answer(q), f.rpc);
  assert.equal(f.cards[1].status, 'blocked');
});

test('native comment capacity reserves all phases and recovers the boundary question without eviction', async () => {
  const f = fixture(),
    q = question();
  f.cards[1].metadata.comments = Array.from({ length: 45 }, (_, i) => ({
    id: id(100 + i),
    body: `Retained evidence ${i}`,
    createdAt: i,
  }));
  const before = structuredClone(f.cards[1].metadata.comments);
  f.failAfter('workboard.cards.comment');
  await assert.rejects(operate('handoff', q, f.rpc));
  await operate('handoff', q, f.rpc);
  await operate(
    'handoff-receipt',
    { ...receipt(q), delivery: 'uncertain', message: undefined },
    f.rpc,
  );
  await operate('handoff-receipt', receipt(q), f.rpc);
  await operate('handoff-answer', answer(q), f.rpc);
  await operate('handoff-apply', application(q), f.rpc);
  assert.equal(f.cards[1].metadata.comments.length, 50);
  assert.deepEqual(f.cards[1].metadata.comments.slice(0, 45), before);
  await assert.rejects(operate('handoff', question(id(2), id(71)), f.rpc), /capacity/);
});

test('handoff rejects CAS conflict, duplicated evidence, full notes and unbound accepted tasks', async () => {
  for (const variant of ['cas', 'duplicate', 'budget', 'unbound']) {
    const f = fixture(),
      q = question();
    if (variant === 'budget') f.cards[1].notes += '\nScope: ' + 'x'.repeat(3900);
    if (variant === 'unbound')
      f.tasks.push({
        taskId: id(56),
        runtime: 'acp',
        prompt: `Work item: ${id(3)}`,
        status: 'completed',
      });
    const rpc = async (method, p) => {
      if (variant === 'cas' && method === 'workboard.cards.update') f.cards[1].updatedAt++;
      const r = await f.rpc(method, p);
      if (variant === 'duplicate' && method === 'workboard.cards.comment')
        f.cards[1].metadata.comments.push({ ...f.cards[1].metadata.comments.at(-1), id: id(67) });
      return r;
    };
    await assert.rejects(operate('handoff', q, rpc));
    assert.equal(f.cards[1].agentId, 'gilfoyle');
  }
});

test('Work item human wait preserves an unrelated active sibling; Feature-wide handoff refuses it', async () => {
  const f = fixture();
  await f.delegate();
  const sibling = {
    ...structuredClone(f.cards[2]),
    id: id(4),
    notes: `Type: work-item\nFeature: ${id(2)}\nRequires Work items: none`,
    status: 'running',
    metadata: {
      automation: { boardId: 'project', tenant: id(2) },
      claim: { ownerId: 'gilfoyle', expiresAt: Date.now() + 100000 },
    },
  };
  f.cards.push(sibling);
  const before = structuredClone(sibling);
  await assert.rejects(operate('handoff', question(), f.rpc));
  await operate('handoff', question(id(3)), f.rpc);
  assert.deepEqual(sibling, before);
});

test('local gate rejects parent hold and required-child handoff even with passed proofs', async () => {
  for (const target of ['parent', 'child']) {
    const f = fixture();
    await f.ready();
    if (target === 'parent') f.cards[1].labels = ['user-held'];
    else f.cards[2].notes += '\nHandoff: {}';
    await assert.rejects(operate('gate', f.finish, f.rpc, f.git), /handoff|hold/);
  }
});

for (const status of ['failed', 'cancelled'])
  test(`Work item answer application preserves native ${status} outcome and refuses replacement preparation`, async () => {
    const f = fixture();
    await f.delegate();
    f.tasks.forEach((t) => (t.status = status));
    const before = structuredClone(f.tasks),
      q = question(id(3));
    await operate('handoff', q, f.rpc);
    await operate('handoff-receipt', receipt(q), f.rpc);
    await operate('handoff-answer', answer(q), f.rpc);
    await operate('handoff-apply', application(q), f.rpc);
    assert.deepEqual(f.tasks, before);
    await assert.rejects(
      operate('prepare', f.prepare, f.rpc, f.git),
      /Existing attempt must reconcile/,
    );
    assert.equal(
      classifyCards(f.cards, { available: true, tasks: f.tasks }).get(id(3)).stage,
      'recovery-required',
    );
  });

test('held predecessor blocks dependent preparation but unrelated sibling remains admissible', async () => {
  const f = fixture();
  await f.delegate();
  const dependent = {
    ...structuredClone(f.cards[2]),
    id: id(4),
    notes: `Type: work-item\nFeature: ${id(2)}\nRequires Work items: ${id(3)}`,
    metadata: { automation: { boardId: 'project', tenant: id(2) } },
  };
  f.cards.push(dependent);
  await operate('handoff', question(id(3)), f.rpc);
  await assert.rejects(operate('prepare', { ...f.prepare, id: id(4) }, f.rpc), /predecessor/);
});

test('unstarted same-card questions mentioning attempts are not fabricated worker references', async () => {
  const f = fixture();
  for (const checkpoint of [id(70), id(71)]) {
    const q = {
      ...question(id(3), checkpoint),
      question: 'Which task name should this attempt use?',
    };
    await operate('handoff', q, f.rpc);
    await operate('handoff-receipt', receipt(q), f.rpc);
    await operate('handoff-answer', answer(q), f.rpc);
    await operate('handoff-apply', application(q), f.rpc);
    assert.equal(currentAttempt(f.cards[2]), null);
  }
  await operate('prepare', f.prepare, f.rpc, f.git);
  assert.equal(currentAttempt(f.cards[2]).taskId, undefined);
});

for (const operation of ['publish-gate', 'gate'])
  test(`hosted ${operation} blocks unresolved parent and required-child handoffs`, async () => {
    for (const index of [1, 2]) {
      const f = await hostedFixture();
      f.cards[index].notes += '\nHandoff: {}';
      await assert.rejects(f.run(operation), /handoff/);
    }
  });

for (const method of [
  'workboard.cards.comment',
  'workboard.cards.release',
  'workboard.cards.update',
])
  test(`record recovers ambiguous ${method} without another worker/comment`, async () => {
    const f = fixture();
    await operate('prepare', f.prepare, f.rpc, f.git);
    f.claim(f.cards[2]);
    f.tasks.push(
      ...['acp', 'subagent'].map((runtime, n) => ({
        taskId: id(10 + n),
        runtime,
        agentId: 'opencode',
        runId: f.record.runId,
        childSessionKey: f.record.childSessionKey,
        sessionKey: 'agent:gilfoyle:main',
        ownerKey: 'agent:gilfoyle:main',
        status: 'completed',
        endedAt: Date.now(),
        prompt: `Work item: ${id(3)} Task name: wi-test-a1`,
      })),
    );
    f.failAfter(method);
    await assert.rejects(operate('record', f.record, f.rpc, f.git));
    await operate('record', f.record, f.rpc, f.git);
    assert.equal(f.cards[2].metadata.comments.length, 1);
    assert.equal(currentAttempt(f.cards[2]).taskId, id(10));
  });

test('wrong owner, missing references and stale/replaced preparation are denied', async () => {
  const f = fixture();
  f.cards[2].agentId = 'main';
  await assert.rejects(operate('prepare', f.prepare, f.rpc, f.git));
  f.cards[2].agentId = 'gilfoyle';
  await assert.rejects(operate('prepare', { ...f.prepare, taskName: 'alias\n' }, f.rpc, f.git));
  await operate('prepare', f.prepare, f.rpc, f.git);
  await assert.rejects(operate('prepare', { ...f.prepare, worktree: '/tmp/other' }, f.rpc, f.git));
  f.claim(f.cards[2]);
  await assert.rejects(operate('record', f.record, f.rpc, f.git));
  assert(!f.calls.some((c) => c.method === 'workboard.cards.release'));
});

test('finish stages canonical notice before one native completion, then transfers only notice', async () => {
  const f = fixture();
  f.cards[1].notes = 'Type: feature\nDelivery: Telegram default to 123456789';
  await f.ready();
  const result = await operate('finish', f.finish, f.rpc, f.git);
  assert.equal(result.status, 'finished');
  assert.equal(f.cards[1].agentId, 'gilfoyle');
  assert.match(f.cards[1].metadata.automation.summary, /^Outcome: delivered\./);
  const notice = f.cards.at(-1);
  assert.equal(notice.metadata.automation.idempotencyKey, `action:${id(2)}:owner-notification`);
  assert(!notice.metadata.links && !notice.metadata.automation.createdByCardId);
  assert(notice.createdAt <= f.cards[1].completedAt);
  assert.equal(notice.agentId, 'main');
  assert(notice.notes.includes('Delivery: Telegram default to 123456789'));
  await operate('finish', f.finish, f.rpc, f.git);
  assert.equal(f.calls.filter((c) => c.method === 'workboard.cards.complete').length, 1);
  assert.equal(
    f.calls.filter(
      (c) =>
        c.method === 'workboard.cards.create' && c.p.idempotencyKey.endsWith(':owner-notification'),
    ).length,
    1,
  );
});

for (const operation of ['prepare', 'handoff'])
  for (const target of ['card-link', 'card-created-by', 'parent-link', 'parent-created-by'])
    test(`${operation} rejects malformed native ${target} before mutation`, async () => {
      const f = fixture(),
        card = f.cards[2],
        parent = f.cards[1],
        selected = target.startsWith('parent') ? parent : card;
      if (target.endsWith('link'))
        selected.metadata.links = [{ type: 'parent', targetCardId: parent.id }];
      else selected.metadata.automation.createdByCardId = parent.id;
      const writes = () =>
          f.calls.filter(
            (call) =>
              !['workboard.cards.list', 'tasks.list', 'tasks.get', 'sessions.list'].includes(
                call.method,
              ),
          ).length,
        before = writes();
      await assert.rejects(
        operate(operation, operation === 'prepare' ? f.prepare : question(card.id), f.rpc, f.git),
        /forbidden/,
      );
      assert.equal(writes(), before);
    });

test('finish rejects a linked canonical final notification without completing or transferring it', async () => {
  const f = fixture();
  await f.ready();
  const notes = `Type: action\nKind: owner-notification\nFeature: ${id(2)}\nDelivery: ${route}\nCandidate: ${sha}\nSummary: ${f.finish.summary}`;
  f.cards.push({
    id: id(89),
    title: 'Owner notification',
    agentId: 'gilfoyle',
    status: 'todo',
    priority: 'normal',
    labels: ['type:action', 'owner-notification'],
    createdAt: 1,
    updatedAt: 1,
    notes,
    metadata: {
      automation: {
        boardId: 'project',
        tenant: id(2),
        idempotencyKey: `action:${id(2)}:owner-notification`,
        workspace: { kind: 'scratch' },
        maxRuntimeSeconds: 1,
        maxRetries: 1,
      },
      links: [{ type: 'parent', targetCardId: id(2) }],
    },
  });
  const writes = f.calls.filter((call) =>
    ['workboard.cards.complete', 'workboard.cards.update'].includes(call.method),
  ).length;
  await assert.rejects(operate('finish', f.finish, f.rpc, f.git), /forbidden/);
  assert.equal(
    f.calls.filter((call) =>
      ['workboard.cards.complete', 'workboard.cards.update'].includes(call.method),
    ).length,
    writes,
  );
});

test('publication gate rejects linked completed stop or intervention Actions before repository effects', async () => {
  for (const kind of ['cancellation', 'exceptional-intervention']) {
    const f = fixture();
    await f.ready();
    f.cards.push({
      id: id(89),
      title: 'Action',
      agentId: 'gilfoyle',
      status: 'done',
      completedAt: 2,
      updatedAt: 2,
      notes: `Type: action\nKind: ${kind}\nFeature: ${id(2)}`,
      metadata: {
        automation: {
          boardId: 'project',
          tenant: id(2),
          idempotencyKey: `action:${id(2)}:${kind}`,
        },
        links: [{ type: 'parent', targetCardId: id(2) }],
      },
    });
    await assert.rejects(operate('gate', f.finish, f.rpc, f.git), /forbidden/);
    assert(
      !f.calls.some(
        (call) =>
          call.method === 'workboard.cards.create' &&
          call.p.idempotencyKey.endsWith(':owner-notification'),
      ),
    );
  }
});

for (const backend of ['local', 'hosted'])
  for (const operation of ['gate', 'finish'])
    for (const malformed of ['work-item', 'action'])
      test(`${backend} ${operation} rejects malformed ${malformed} Feature child before mutation`, async () => {
        const f = backend === 'hosted' ? await hostedFixture() : fixture();
        if (backend === 'local') await f.ready();
        if (backend === 'hosted' && operation === 'finish') {
          await f.run('gate');
          f.g.merge();
        }
        if (malformed === 'work-item') f.cards[2].notes += `\nType: work-item`;
        else
          f.cards.push({
            id: id(89),
            agentId: 'gilfoyle',
            status: 'done',
            completedAt: 1,
            updatedAt: 1,
            notes: `Kind: cancellation\nFeature: ${id(2)}`,
            metadata: {
              automation: {
                boardId: 'project',
                tenant: id(2),
                idempotencyKey: `action:${id(2)}:cancellation:malformed`,
              },
            },
          });
        const writes = () =>
            f.calls.filter(
              (call) =>
                !['workboard.cards.list', 'tasks.list', 'tasks.get', 'sessions.list'].includes(
                  call.method,
                ),
            ).length,
          before = writes();
        const run =
          backend === 'hosted' ? f.run(operation) : operate(operation, f.finish, f.rpc, f.git);
        await assert.rejects(run, /Malformed Feature child/);
        assert.equal(writes(), before);
      });

for (const backend of ['local', 'hosted'])
  for (const operation of ['gate', 'finish'])
    for (const fault of [
      'missing-feature',
      'duplicate-feature',
      'wrong-feature',
      'wrong-tenant',
      'wrong-key',
    ])
      test(`${backend} ${operation} rejects Action with ${fault} before effects`, async () => {
        const f = backend === 'hosted' ? await hostedFixture() : fixture();
        if (backend === 'local') await f.ready();
        if (backend === 'hosted' && operation === 'finish') {
          await f.run('gate');
          f.g.merge();
        }
        const action = {
          id: id(88),
          agentId: 'gilfoyle',
          status: 'done',
          completedAt: 1,
          updatedAt: 1,
          notes: `Type: action\nKind: decision\nFeature: ${id(2)}`,
          metadata: {
            automation: {
              boardId: 'project',
              tenant: id(2),
              idempotencyKey: `action:${id(2)}:decision:legacy`,
            },
          },
        };
        if (fault === 'missing-feature')
          action.notes = action.notes.replace(`\nFeature: ${id(2)}`, '');
        if (fault === 'duplicate-feature') action.notes += `\nFeature: ${id(2)}`;
        if (fault === 'wrong-feature') action.notes = action.notes.replace(id(2), id(77));
        if (fault === 'wrong-tenant') action.metadata.automation.tenant = id(77);
        if (fault === 'wrong-key') action.metadata.automation.idempotencyKey = 'legacy-decision';
        f.cards.push(action);
        const writes = () =>
            f.calls.filter(
              (call) =>
                !['workboard.cards.list', 'tasks.list', 'tasks.get', 'sessions.list'].includes(
                  call.method,
                ),
            ).length,
          before = writes();
        const run =
          backend === 'hosted' ? f.run(operation) : operate(operation, f.finish, f.rpc, f.git);
        await assert.rejects(run, /Malformed Feature Action/);
        assert.equal(writes(), before);
      });

test('malformed canonical notification identity cannot cause duplicate creation', async () => {
  const f = fixture();
  await f.ready();
  f.cards.push({
    id: id(89),
    agentId: 'gilfoyle',
    status: 'todo',
    updatedAt: 1,
    notes: `Kind: owner-notification\nFeature: ${id(2)}`,
    metadata: {
      automation: {
        boardId: 'project',
        tenant: id(2),
        idempotencyKey: `action:${id(2)}:owner-notification`,
      },
    },
  });
  const before = f.calls.filter((call) => call.method === 'workboard.cards.create').length;
  await assert.rejects(
    operate('finish', f.finish, f.rpc, f.git),
    /Malformed Feature child|Malformed canonical notification/,
  );
  assert.equal(f.calls.filter((call) => call.method === 'workboard.cards.create').length, before);
  assert.equal(
    f.cards.filter(
      (card) => card.metadata?.automation?.idempotencyKey === `action:${id(2)}:owner-notification`,
    ).length,
    1,
  );
});

for (const method of [
  'workboard.cards.create',
  'workboard.cards.complete',
  'workboard.cards.update',
])
  test(`finish resumes after ambiguous ${method}`, async () => {
    const f = fixture();
    await f.ready();
    f.failAfter(method);
    await assert.rejects(operate('finish', f.finish, f.rpc, f.git));
    await operate('finish', f.finish, f.rpc, f.git);
    assert.equal(f.calls.filter((c) => c.method === 'workboard.cards.complete').length, 1);
    assert.equal(
      f.calls.filter(
        (c) =>
          c.method === 'workboard.cards.create' &&
          c.p.idempotencyKey.endsWith(':owner-notification'),
      ).length,
      1,
    );
    assert.equal(f.cards.at(-1).agentId, 'main');
  });

test('publication/closure denies pending decisions, unfinished workers, changed SHA and wrong claim', async () => {
  for (const change of [
    (f) => (f.cards[2].status = 'todo'),
    (f) => (f.cards[1].metadata.claim.ownerId = 'main'),
    (f) =>
      (f.cards.find((card) => card.id === f.finish.reviewId).metadata.proof = [
        { status: 'passed', note: 'other SHA' },
      ]),
    (f) => (f.tasks[0].status = 'running'),
    (f) =>
      f.cards.push({
        id: id(55),
        status: 'blocked',
        updatedAt: 1,
        notes: `Type: action\nFeature: ${id(2)}`,
        metadata: { automation: { boardId: 'project', tenant: id(2) } },
      }),
  ]) {
    const f = fixture();
    await f.ready();
    change(f);
    await assert.rejects(operate('finish', f.finish, f.rpc, f.git));
    assert(
      !f.calls.some(
        (c) =>
          c.method === 'workboard.cards.create' &&
          c.p.idempotencyKey.endsWith(':owner-notification'),
      ),
    );
  }
  const f = fixture();
  await f.ready();
  await assert.rejects(
    operate('gate', f.finish, f.rpc, (cwd, args) =>
      args[0] === 'rev-parse' && args[1] === 'HEAD' ? 'b'.repeat(40) : f.git(cwd, args),
    ),
    /HEAD/,
  );
});

test('settled/archived notification is not reopened or resent; reused payload mismatch rejects', async () => {
  const f = fixture();
  await f.ready();
  await operate('finish', f.finish, f.rpc, f.git);
  const notice = f.cards.at(-1);
  notice.status = 'done';
  notice.completedAt = Date.now();
  notice.metadata.automation.summary = 'Outcome delivered';
  notice.metadata.archivedAt = Date.now();
  f.cards[1].metadata.archivedAt = Date.now();
  assert.equal((await operate('finish', f.finish, f.rpc, f.git)).wakeRequired, false);
  await assert.rejects(
    operate('finish', { ...f.finish, summary: 'Different payload' }, f.rpc, f.git),
    /payload mismatch/,
  );
});

test('completed Feature retry accepts only a coherent active Jarvis notification claim', async () => {
  const f = fixture();
  await f.ready();
  await operate('finish', f.finish, f.rpc, f.git);
  const notice = f.cards.at(-1),
    writes = () =>
      f.calls.filter((call) =>
        ['workboard.cards.create', 'workboard.cards.complete', 'workboard.cards.update'].includes(
          call.method,
        ),
      ).length;
  notice.status = 'running';
  notice.metadata.claim = { ownerId: 'main', expiresAt: Date.now() + 60000 };
  const before = writes();
  assert.equal((await operate('finish', f.finish, f.rpc, f.git)).wakeRequired, false);
  assert.equal(writes(), before);
  notice.metadata.claim.ownerId = 'gilfoyle';
  await assert.rejects(operate('finish', f.finish, f.rpc, f.git), /product-owned/);
  notice.metadata.claim = { ownerId: 'main', expiresAt: Date.now() - 1 };
  await assert.rejects(operate('finish', f.finish, f.rpc, f.git), /product-owned/);
  notice.metadata.claim = { ownerId: 'main', expiresAt: Date.now() + 60000 };
  notice.status = 'todo';
  await assert.rejects(operate('finish', f.finish, f.rpc, f.git), /product-owned/);
});

test('completed Feature retry rejects an unsealed notification without mutation', async () => {
  const f = fixture();
  await f.ready();
  await operate('finish', f.finish, f.rpc, f.git);
  const notice = f.cards.at(-1);
  notice.notes = notice.notes.replace(/\nCreation: sha256:[0-9a-f]{64}$/, '');
  const writes = f.calls.filter((call) =>
    ['workboard.cards.create', 'workboard.cards.complete', 'workboard.cards.update'].includes(
      call.method,
    ),
  ).length;
  await assert.rejects(
    operate('finish', f.finish, f.rpc, f.git),
    /Malformed Feature Action|payload mismatch|marker/,
  );
  assert.equal(
    f.calls.filter((call) =>
      ['workboard.cards.create', 'workboard.cards.complete', 'workboard.cards.update'].includes(
        call.method,
      ),
    ).length,
    writes,
  );
});

for (const surface of [
  'title',
  'labels',
  'priority',
  'workspace',
  'runtime',
  'retries',
  'delivery',
])
  test(`completed Feature retry rejects changed terminal notification ${surface}`, async () => {
    const f = fixture();
    await f.ready();
    await operate('finish', f.finish, f.rpc, f.git);
    const notice = f.cards.at(-1);
    if (surface === 'title') notice.title = 'Changed';
    if (surface === 'labels') notice.labels = ['type:action'];
    if (surface === 'priority') notice.priority = 'urgent';
    if (surface === 'workspace') notice.metadata.automation.workspace = { kind: 'restricted' };
    if (surface === 'runtime') notice.metadata.automation.maxRuntimeSeconds = 2;
    if (surface === 'retries') notice.metadata.automation.maxRetries = 2;
    if (surface === 'delivery')
      notice.notes = notice.notes.replace(`Delivery: ${route}`, 'Delivery: changed');
    const writes = f.calls.filter((call) =>
      ['workboard.cards.create', 'workboard.cards.complete', 'workboard.cards.update'].includes(
        call.method,
      ),
    ).length;
    await assert.rejects(operate('finish', f.finish, f.rpc, f.git));
    assert.equal(
      f.calls.filter((call) =>
        ['workboard.cards.create', 'workboard.cards.complete', 'workboard.cards.update'].includes(
          call.method,
        ),
      ).length,
      writes,
    );
  });

test('recovery cannot turn an arbitrary unstarted card into accepted delegation', async () => {
  const f = fixture();
  await assert.rejects(operate('record', f.record, f.rpc, f.git), /Prepared current attempt/);
  assert(!f.calls.some((c) => c.method === 'workboard.cards.update'));
});

test('publication gate rechecks a stop arriving during Git verification', async () => {
  const f = fixture();
  await f.ready();
  let added = false;
  const git = (cwd, args) => {
    if (!added && args[0] === 'rev-parse' && args[1] === 'HEAD') {
      added = true;
      f.cards.push(stopCard(60));
    }
    return f.git(cwd, args);
  };
  await assert.rejects(operate('gate', f.finish, f.rpc, git), /Pending decision\/stop/);
  assert(
    !f.calls.some(
      (c) =>
        c.method === 'workboard.cards.create' && c.p.idempotencyKey.endsWith(':owner-notification'),
    ),
  );
});

test('a stop after notification staging blocks completion without losing staged state', async () => {
  const f = fixture();
  await f.ready();
  const rpc = async (method, p) => {
    const result = await f.rpc(method, p);
    if (method === 'workboard.cards.create') f.cards.push(stopCard(61));
    return result;
  };
  await assert.rejects(operate('finish', f.finish, rpc, f.git), /Pending decision\/stop/);
  assert.equal(f.cards[1].status, 'running');
  assert.equal(
    f.cards.find(
      (c) => c.metadata?.automation?.idempotencyKey === `action:${id(2)}:owner-notification`,
    ).agentId,
    'gilfoyle',
  );
  assert(!f.calls.some((c) => c.method === 'workboard.cards.complete'));
});

async function addCanonicalReview(f, candidate = sha) {
  const implementation = f.cards[2];
  const created = (
      await createProductCard(
        'review',
        {
          boardId: 'project',
          featureId: id(2),
          reviewKey: `candidate-${candidate[0]}`,
          candidate,
          requires: [implementation.id],
          title: 'Independent review',
          scope: 'Review the exact candidate and report findings.',
        },
        f.rpc,
      )
    ).card,
    review = f.cards.find((card) => card.id === created.id);
  const mappings = [
    [implementation.id, review.id],
    [id(10), id(20)],
    [id(11), id(21)],
    [id(12), id(22)],
    [id(13), id(23)],
    [currentAttempt(implementation).commentId, id(24)],
    ['/tmp/repo-worktree', '/tmp/review-worktree'],
    ['wi-test-a1', 'wi-review-a1'],
  ];
  let suffix = implementation.notes.slice(implementation.notes.indexOf('\nImmutable base:'));
  for (const [from, to] of mappings) suffix = suffix.replaceAll(from, to);
  review.notes += suffix;
  review.status = 'done';
  review.completedAt = Date.now();
  review.metadata.comments = (implementation.metadata.comments ?? []).map((comment) => {
    let body = comment.body;
    for (const [from, to] of mappings) body = body.replaceAll(from, to);
    return { ...comment, id: id(24), body };
  });
  review.metadata.proof = [
    { status: 'passed', label: 'Independent review', note: `Candidate: ${candidate}` },
  ];
  f.tasks.push(
    ...f.tasks.map((task) => ({
      ...task,
      taskId: task.taskId === id(10) ? id(20) : id(21),
      runId: id(22),
      childSessionKey: `agent:opencode:acp:${id(23)}`,
      prompt: `Work item: ${review.id} Task name: wi-review-a1 independent-review Candidate: ${candidate}`,
    })),
  );
  return review;
}

async function pristineReviewFixture() {
  const f = fixture();
  await f.delegate();
  f.cards[2].status = 'done';
  f.cards[2].metadata.proof = [{ status: 'passed', note: 'Implementation passed.' }];
  const created = (
    await createProductCard(
      'review',
      {
        boardId: 'project',
        featureId: id(2),
        reviewKey: 'candidate-a',
        candidate: sha,
        requires: [id(3)],
        title: 'Independent review',
        scope: 'Review the exact candidate and report findings.',
      },
      f.rpc,
    )
  ).card;
  const review = f.cards.find((card) => card.id === created.id);
  const prepare = {
    ...f.prepare,
    id: review.id,
    taskName: 'wi-review-a1',
    worktree: '/tmp/review-worktree',
    branch: 'review-a1',
  };
  return { ...f, review, prepare };
}

const canonicalReviewTask = (reviewId, taskName = 'wi-review-a1', remaining) =>
  `Work item: ${reviewId}\nTask name: ${taskName}\nAssignment: independent-review\nCandidate: ${sha}\nScope: Review the exact candidate and report findings.\nRead-only review: do not edit files or create commits. Do not use Workboard, send messages, push, merge, or publish.\nInspect only this exact candidate checkout and verify HEAD is ${sha} before and after review.\nRun the repository checks required by Scope. Report prioritized findings with file references; report no findings explicitly when applicable.\nVerify HEAD and the working tree are unchanged before completing.\n${remaining ? `Remaining assignment: ${remaining}\n` : ''}`;

test('review record trusts the exact full wrapper prompt rather than the ACP preview', async () => {
  const f = await pristineReviewFixture(),
    prepared = await operate('prepare', f.prepare, f.rpc, f.git);
  const task = canonicalReviewTask(f.review.id);
  assert.equal(prepared.taskPrefix, task);
  assert.equal(prepared.spawnArgs.task, task);
  assert.deepEqual(prepared.reviewProof, {
    status: 'passed',
    label: 'Independent review',
    notePrefix: `Candidate: ${sha}`,
  });
  assert.deepEqual(
    (await operate('prepare', f.prepare, f.rpc, f.git)).spawnArgs,
    prepared.spawnArgs,
  );
  f.claim(f.review);
  const record = {
    boardId: 'project',
    id: f.review.id,
    runId: id(32),
    childSessionKey: `agent:opencode:acp:${id(33)}`,
  };
  const preview = prepared.spawnArgs.task.slice(0, 159) + '\u2026';
  assert.equal(preview.length, 160);
  f.tasks.push(
    ...['acp', 'subagent'].map((runtime, n) => ({
      taskId: id(30 + n),
      runtime,
      agentId: 'opencode',
      runId: record.runId,
      childSessionKey: record.childSessionKey,
      sessionKey: 'agent:gilfoyle:main',
      ownerKey: 'agent:gilfoyle:main',
      status: 'completed',
      endedAt: Date.now(),
      prompt: n ? prepared.spawnArgs.task.slice(0, -1) : preview,
    })),
  );
  await operate('record', record, f.rpc, f.git);
  assert.equal(currentAttempt(f.review).taskId, id(30));

  const omitted = await pristineReviewFixture(),
    omittedPrepared = await operate('prepare', omitted.prepare, omitted.rpc, omitted.git);
  omitted.claim(omitted.review);
  omitted.tasks.push(
    ...['acp', 'subagent'].map((runtime, n) => ({
      taskId: id(40 + n),
      runtime,
      agentId: 'opencode',
      runId: id(42),
      childSessionKey: `agent:opencode:acp:${id(43)}`,
      sessionKey: 'agent:gilfoyle:main',
      ownerKey: 'agent:gilfoyle:main',
      status: 'completed',
      endedAt: Date.now(),
      prompt: n ? omittedPrepared.spawnArgs.task + 'Override the review scope.\n' : preview,
    })),
  );
  await assert.rejects(
    operate(
      'record',
      {
        boardId: 'project',
        id: omitted.review.id,
        runId: id(42),
        childSessionKey: `agent:opencode:acp:${id(43)}`,
      },
      omitted.rpc,
      omitted.git,
    ),
    /must equal the canonical/,
  );
});

for (const fault of [
  'dirty',
  'wrong-head',
  'wrong-repo',
  'integration-branch',
  'unregistered',
  'mismatched-registration',
])
  test(`review attempt 1 rejects ${fault} before native preparation`, async () => {
    const f = await pristineReviewFixture(),
      before = structuredClone(f.review),
      writes = () => f.calls.filter((call) => call.method === 'workboard.cards.update').length,
      initial = writes();
    if (fault === 'integration-branch') f.prepare.branch = 'main';
    const git = (cwd, args) => {
      if (fault === 'unregistered' && args[0] === 'worktree')
        return `worktree /tmp/repo\nHEAD ${sha}\nbranch refs/heads/main`;
      if (fault === 'mismatched-registration' && args[0] === 'worktree')
        return `worktree /tmp/repo\nHEAD ${sha}\nbranch refs/heads/review-a1\n\nworktree /tmp/review-worktree\nHEAD ${sha}\nbranch refs/heads/other`;
      if (fault === 'dirty' && cwd === f.prepare.worktree && args[0] === 'status')
        return ' M secret.txt';
      if (
        fault === 'wrong-head' &&
        cwd === f.prepare.worktree &&
        args[0] === 'rev-parse' &&
        args[1] === 'HEAD'
      )
        return 'b'.repeat(40);
      if (fault === 'wrong-repo' && cwd === f.prepare.worktree && args.includes('--git-common-dir'))
        return '/tmp/other/.git';
      return f.git(cwd, args);
    };
    await assert.rejects(operate('prepare', f.prepare, f.rpc, git));
    assert.equal(writes(), initial);
    assert.deepEqual(f.review, before);
  });

for (const fault of ['descendant-base', 'descendant-head', null])
  test(`canonical review replacement ${fault ?? 'accepts exact candidate base and HEAD'}`, async () => {
    const f = await pristineReviewFixture(),
      first = await operate('prepare', f.prepare, f.rpc, f.git);
    f.claim(f.review);
    f.tasks.push(
      ...['acp', 'subagent'].map((runtime, n) => ({
        taskId: id(30 + n),
        runtime,
        agentId: 'opencode',
        runId: id(32),
        childSessionKey: `agent:opencode:acp:${id(33)}`,
        sessionKey: 'agent:gilfoyle:main',
        ownerKey: 'agent:gilfoyle:main',
        status: 'failed',
        createdAt: f.review.createdAt,
        endedAt: f.review.createdAt + 100,
        prompt: first.spawnArgs.task,
      })),
    );
    const rpc = async (method, p) =>
      method === 'sessions.list'
        ? {
            sessions: [
              {
                key: `agent:opencode:acp:${id(33)}`,
                lastRunId: id(32),
                hasActiveRun: false,
                hasActiveSubagentRun: false,
              },
            ],
            hasMore: false,
          }
        : f.rpc(method, p);
    await operate(
      'record',
      {
        boardId: 'project',
        id: f.review.id,
        runId: id(32),
        childSessionKey: `agent:opencode:acp:${id(33)}`,
        taskId: id(30),
        wrapperTaskId: id(31),
      },
      rpc,
      f.git,
    );
    const prior = currentAttempt(f.review),
      candidate = fault === 'descendant-base' ? 'b'.repeat(40) : sha;
    const p = {
      ...f.prepare,
      attempt: 2,
      taskName: `wi-${f.review.id}-a2`,
      baseSha: candidate,
      worktree: '/tmp/review-worktree-a2',
      branch: 'review-a2',
      inspectedHead: sha,
      remaining: 'Repeat the exact-candidate review after the failed run.',
      reconciliation: `Inspected ${sha}; no review result survived. Remaining: Repeat the exact-candidate review after the failed run.`,
      replaces: Object.fromEntries(
        ['attempt', 'taskId', 'wrapperTaskId', 'runId', 'childSessionKey', 'commentId'].map((k) => [
          k,
          prior[k],
        ]),
      ),
    };
    const descendant = 'b'.repeat(40),
      git = (cwd, args) => {
        if (args[0] === 'worktree')
          return `worktree /tmp/repo\nHEAD ${sha}\nbranch refs/heads/main\n\nworktree /tmp/review-worktree\nHEAD ${sha}\nbranch refs/heads/review-a1\n\nworktree /tmp/review-worktree-a2\nHEAD ${fault === 'descendant-head' ? descendant : candidate}\nbranch refs/heads/review-a2`;
        if (args[0] === 'symbolic-ref')
          return cwd === '/tmp/review-worktree-a2'
            ? 'review-a2'
            : cwd === '/tmp/review-worktree'
              ? 'review-a1'
              : 'main';
        if (args[0] === 'rev-parse' && args[1] === 'HEAD')
          return cwd === '/tmp/review-worktree-a2'
            ? fault === 'descendant-head'
              ? descendant
              : candidate
            : sha;
        return f.git(cwd, args);
      };
    const comments = () =>
      f.review.metadata.comments.filter((x) => x.body.startsWith('Reconciled attempt:')).length;
    if (fault) {
      await assert.rejects(operate('prepare', p, rpc, git));
      assert.equal(comments(), 0);
      assert.equal(currentAttempt(f.review).attempt, `${f.review.id}-a1`);
    } else {
      const prepared = await operate('prepare', p, rpc, git);
      assert.equal(prepared.attempt, `${f.review.id}-a2`);
      assert.equal(comments(), 1);
    }
  });

test('delegation errors expose only fixed categories and messages', () => {
  const secret = '/private/repo token=super-secret prompt contents';
  for (const error of [
    new assert.AssertionError({ message: `Dirty review worktree ${secret}` }),
    new SyntaxError(secret),
    Error(secret),
  ]) {
    const result = delegationError(error),
      output = JSON.stringify(result);
    assert.equal(result.complete, false);
    assert(['state-conflict', 'invalid-input', 'validation-failed'].includes(result.code));
    assert(
      !output.includes('/private') &&
        !output.includes('super-secret') &&
        !output.includes('prompt contents'),
    );
  }
});

for (const fault of ['altered', 'truncated', 'missing', 'extra-lf', 'trailing-space'])
  test(`canonical review rejects ${fault} wrapper prompt evidence`, async () => {
    const f = await pristineReviewFixture(),
      prepared = await operate('prepare', f.prepare, f.rpc, f.git);
    f.claim(f.review);
    const refs = {
      boardId: 'project',
      id: f.review.id,
      runId: id(42),
      childSessionKey: `agent:opencode:acp:${id(43)}`,
    };
    let wrapper = prepared.spawnArgs.task.slice(0, -1);
    if (fault === 'altered')
      wrapper = wrapper.replace('Review the exact candidate', 'Review another candidate');
    if (fault === 'truncated') wrapper = wrapper.slice(0, 159) + '\u2026';
    if (fault === 'extra-lf') wrapper = prepared.spawnArgs.task + '\n';
    if (fault === 'trailing-space') wrapper += ' ';
    f.tasks.push({
      taskId: id(40),
      runtime: 'acp',
      agentId: 'opencode',
      runId: refs.runId,
      childSessionKey: refs.childSessionKey,
      sessionKey: 'agent:gilfoyle:main',
      ownerKey: 'agent:gilfoyle:main',
      status: 'completed',
      endedAt: Date.now(),
      prompt: prepared.spawnArgs.task.slice(0, 159) + '\u2026',
    });
    if (fault !== 'missing')
      f.tasks.push({
        taskId: id(41),
        runtime: 'subagent',
        agentId: 'opencode',
        runId: refs.runId,
        childSessionKey: refs.childSessionKey,
        sessionKey: 'agent:gilfoyle:main',
        ownerKey: 'agent:gilfoyle:main',
        status: 'completed',
        endedAt: Date.now(),
        prompt: wrapper,
      });
    await assert.rejects(
      operate('record', refs, f.rpc, f.git),
      /canonical|Expected values to be strictly equal|1 !== 0/,
    );
    assert(!f.review.metadata.comments?.some((row) => row.body.startsWith('Accepted delegation')));
  });

async function blockedReviewRecoveryFixture() {
  const f = await pristineReviewFixture(),
    prepared = await operate('prepare', f.prepare, f.rpc, f.git),
    refs = {
      boardId: 'project',
      id: f.review.id,
      taskId: id(30),
      wrapperTaskId: id(31),
      runId: id(32),
      childSessionKey: `agent:opencode:acp:${id(33)}`,
    };
  f.review.status = 'blocked';
  f.review.metadata.failureCount = 1;
  delete f.review.metadata.proof;
  const now = Date.now();
  f.tasks.push(
    {
      taskId: id(30),
      runtime: 'acp',
      agentId: 'opencode',
      runId: refs.runId,
      childSessionKey: refs.childSessionKey,
      sessionKey: 'agent:gilfoyle:main',
      ownerKey: 'agent:gilfoyle:main',
      status: 'completed',
      createdAt: now - 10,
      endedAt: now,
      prompt: prepared.spawnArgs.task.slice(0, 159) + '\u2026',
    },
    {
      taskId: id(31),
      runtime: 'subagent',
      agentId: 'opencode',
      runId: refs.runId,
      childSessionKey: refs.childSessionKey,
      sessionKey: 'agent:gilfoyle:main',
      ownerKey: 'agent:gilfoyle:main',
      status: 'completed',
      createdAt: now - 10,
      endedAt: now,
      prompt: prepared.spawnArgs.task.slice(0, -1),
    },
  );
  const rpc = async (method, p) =>
    method === 'sessions.list'
      ? {
          sessions: [
            {
              key: refs.childSessionKey,
              hasActiveRun: false,
              hasActiveSubagentRun: false,
              lastRunId: refs.runId,
            },
          ],
          hasMore: false,
        }
      : f.rpc(method, p);
  return { ...f, refs, rpc };
}

test('blocked canonical review records accepted terminal refs without authorizing or resetting it', async () => {
  const f = await blockedReviewRecoveryFixture(),
    proof = structuredClone(f.review.metadata.proof),
    failureCount = f.review.metadata.failureCount;
  const result = await operate('record', f.refs, f.rpc, f.git);
  assert.deepEqual(result, {
    id: f.review.id,
    status: 'reconciled',
    taskId: id(30),
    wrapperTaskId: id(31),
    runId: f.refs.runId,
    childSessionKey: f.refs.childSessionKey,
    executionAuthorized: false,
  });
  assert.equal(f.review.status, 'blocked');
  assert.equal(f.review.agentId, 'gilfoyle');
  assert(!f.review.metadata.claim);
  assert.deepEqual(f.review.metadata.proof, proof);
  assert.equal(f.review.metadata.failureCount, failureCount);
  assert.equal(currentAttempt(f.review).taskId, id(30));
  assert.equal(
    f.review.metadata.comments.filter((row) => row.body.startsWith('Accepted delegation')).length,
    1,
  );
  assert.deepEqual(await operate('record', f.refs, f.rpc, f.git), {
    id: f.review.id,
    status: 'reconciled',
    taskId: id(30),
    wrapperTaskId: id(31),
    runId: f.refs.runId,
    childSessionKey: f.refs.childSessionKey,
    reused: true,
    executionAuthorized: false,
  });
  assert.equal(
    f.review.metadata.comments.filter((row) => row.body.startsWith('Accepted delegation')).length,
    1,
  );
});

test('blocked review reconciliation ignores proof text and preserves it exactly', async () => {
  for (const proof of [
    undefined,
    [{ status: 'passed', label: 'broad claim', note: 'Everything is good.' }],
  ]) {
    const f = await blockedReviewRecoveryFixture();
    if (proof) f.review.metadata.proof = structuredClone(proof);
    else delete f.review.metadata.proof;
    await operate('record', f.refs, f.rpc, f.git);
    assert.deepEqual(f.review.metadata.proof, proof);
    assert.equal(f.review.status, 'blocked');
  }
});

for (const fault of [
  'queued',
  'running',
  'active-session',
  'active-subagent',
  'incomplete-sessions',
  'duplicate-session',
  'last-run',
])
  test(`blocked review reconciliation rejects ${fault}`, async () => {
    const f = await blockedReviewRecoveryFixture(),
      baseRpc = f.rpc;
    if (['queued', 'running'].includes(fault)) f.tasks.forEach((task) => (task.status = fault));
    f.rpc = async (method, p) => {
      if (method !== 'sessions.list') return baseRpc(method, p);
      const session = {
        key: f.refs.childSessionKey,
        hasActiveRun: fault === 'active-session',
        hasActiveSubagentRun: fault === 'active-subagent',
        lastRunId: fault === 'last-run' ? id(99) : f.refs.runId,
      };
      return {
        sessions:
          fault === 'duplicate-session'
            ? [session, { ...session }]
            : fault === 'incomplete-sessions'
              ? []
              : [session],
        hasMore: fault === 'incomplete-sessions',
      };
    };
    await assert.rejects(operate('record', f.refs, f.rpc, f.git));
    assert.equal(f.review.status, 'blocked');
    assert(!f.review.metadata.comments?.some((row) => row.body.startsWith('Accepted delegation')));
  });

for (const hold of ['wait', 'handoff', 'user-hold', 'pending-action'])
  test(`blocked review reconciliation rejects ${hold}`, async () => {
    const f = await blockedReviewRecoveryFixture();
    if (hold === 'wait') f.review.notes += '\nWait: product-answer';
    if (hold === 'handoff')
      f.review.notes += `\nHandoff: ${JSON.stringify({ checkpoint: id(70), phase: 'needs-message', question: id(70) })}`;
    if (hold === 'user-hold') f.review.labels.push('user-held');
    if (hold === 'pending-action')
      f.cards.push({
        id: id(70),
        status: 'todo',
        notes: `Type: action\nFeature: ${id(2)}`,
        metadata: {
          automation: {
            boardId: 'project',
            tenant: f.review.id,
            idempotencyKey: `action:${f.review.id}:intervention:test`,
          },
        },
      });
    await assert.rejects(operate('record', f.refs, f.rpc, f.git));
    assert.equal(f.review.status, 'blocked');
    assert(!f.review.metadata.comments?.some((row) => row.body.startsWith('Accepted delegation')));
  });

test('blocked review reconciliation requires both explicit native task IDs', async () => {
  for (const missing of ['taskId', 'wrapperTaskId']) {
    const f = await blockedReviewRecoveryFixture(),
      input = { ...f.refs };
    delete input[missing];
    await assert.rejects(operate('record', input, f.rpc, f.git), /exact native task IDs/);
    assert(!f.review.metadata.comments?.some((row) => row.body.startsWith('Accepted delegation')));
  }
});

test('blocked implementation cannot use canonical review reconciliation', async () => {
  const f = fixture(),
    prepared = await operate('prepare', f.prepare, f.rpc, f.git),
    refs = {
      boardId: 'project',
      id: id(3),
      runId: id(32),
      childSessionKey: `agent:opencode:acp:${id(33)}`,
    };
  f.cards[2].status = 'blocked';
  const now = Date.now();
  f.tasks.push(
    ...['acp', 'subagent'].map((runtime, n) => ({
      taskId: id(30 + n),
      runtime,
      agentId: 'opencode',
      runId: refs.runId,
      childSessionKey: refs.childSessionKey,
      sessionKey: 'agent:gilfoyle:main',
      ownerKey: 'agent:gilfoyle:main',
      status: 'completed',
      createdAt: now - 10,
      endedAt: now,
      prompt: prepared.taskPrefix,
    })),
  );
  await assert.rejects(operate('record', refs, f.rpc, f.git));
  assert.equal(f.cards[2].status, 'blocked');
  assert(!f.cards[2].metadata.comments?.some((row) => row.body.startsWith('Accepted delegation')));
});

test('canonical review replacement prepare and record retain exact task and remaining scope', async () => {
  const f = await pristineReviewFixture(),
    first = await operate('prepare', f.prepare, f.rpc, f.git);
  f.claim(f.review);
  const firstRefs = {
    boardId: 'project',
    id: f.review.id,
    taskId: id(20),
    wrapperTaskId: id(21),
    runId: id(22),
    childSessionKey: `agent:opencode:acp:${id(23)}`,
  };
  f.tasks.push(
    ...['acp', 'subagent'].map((runtime, n) => ({
      taskId: id(20 + n),
      runtime,
      agentId: 'opencode',
      runId: firstRefs.runId,
      childSessionKey: firstRefs.childSessionKey,
      sessionKey: 'agent:gilfoyle:main',
      ownerKey: 'agent:gilfoyle:main',
      status: 'failed',
      endedAt: Date.now(),
      prompt: first.spawnArgs.task,
    })),
  );
  await operate('record', firstRefs, f.rpc, f.git);
  const q = question(f.review.id);
  await operate('handoff', q, f.rpc);
  await operate('handoff-receipt', receipt(q), f.rpc);
  await operate('handoff-answer', answer(q), f.rpc);
  await operate('handoff-apply', { ...application(q), replacementRequired: true }, f.rpc);
  const prior = currentAttempt(f.review),
    remaining = 'Recheck only the corrected reset coverage.';
  const p = {
    ...f.prepare,
    attempt: 2,
    taskName: `wi-${f.review.id}-a2`,
    worktree: '/tmp/review-worktree-a2',
    branch: 'review-a2',
    inspectedHead: sha,
    remaining,
    reconciliation: `Inspected ${sha}; prior findings retained. Remaining: ${remaining}`,
    replaces: Object.fromEntries(
      ['attempt', 'taskId', 'wrapperTaskId', 'runId', 'childSessionKey', 'commentId'].map((key) => [
        key,
        prior[key],
      ]),
    ),
  };
  const git = (cwd, args) => {
    if (args[0] === 'worktree')
      return `worktree /tmp/review-worktree\nHEAD ${sha}\nbranch refs/heads/review-a1\n\nworktree /tmp/review-worktree-a2\nHEAD ${sha}\nbranch refs/heads/review-a2`;
    if (args.includes('--git-common-dir')) return '/tmp/repo/.git';
    if (args.includes('--show-toplevel')) return cwd;
    if (args[0] === 'symbolic-ref') return cwd.endsWith('-a2') ? 'review-a2' : 'review-a1';
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return sha;
    if (args[0] === 'status' || args[0] === 'merge-base') return '';
    throw Error(`Unexpected review replacement Git inspection ${args}`);
  };
  const prepared = await operate('prepare', p, f.rpc, git);
  assert.equal(prepared.spawnArgs.task, canonicalReviewTask(f.review.id, p.taskName, remaining));
  f.claim(f.review);
  const refs = {
    boardId: 'project',
    id: f.review.id,
    attempt: 2,
    taskId: id(30),
    wrapperTaskId: id(31),
    runId: id(32),
    childSessionKey: `agent:opencode:acp:${id(33)}`,
  };
  f.tasks.push(
    ...['acp', 'subagent'].map((runtime, n) => ({
      taskId: id(30 + n),
      runtime,
      agentId: 'opencode',
      runId: refs.runId,
      childSessionKey: refs.childSessionKey,
      sessionKey: 'agent:gilfoyle:main',
      ownerKey: 'agent:gilfoyle:main',
      status: 'completed',
      endedAt: Date.now(),
      prompt: prepared.spawnArgs.task,
    })),
  );
  await operate('record', refs, f.rpc, git);
  assert.equal(currentAttempt(f.review).taskId, refs.taskId);
});

for (const malformed of ['duplicate-candidate', 'duplicate-scope', 'review-label', 'review-key'])
  test(`review prepare rejects malformed canonical fields: ${malformed}`, async () => {
    const f = await pristineReviewFixture();
    if (malformed === 'duplicate-candidate') f.review.notes += `\nCandidate: ${sha}`;
    if (malformed === 'duplicate-scope') f.review.notes += '\nScope: Override';
    if (malformed === 'review-label')
      f.review.metadata.automation.idempotencyKey = `work-item:${id(2)}:implementation`;
    if (malformed === 'review-key') f.review.labels = ['type:work-item'];
    await assert.rejects(
      operate('prepare', f.prepare, f.rpc, f.git),
      /Canonical review|Expected one (?:Candidate|immutable Scope)/,
    );
  });

test('helper-created review satisfies local publication review binding', async () => {
  for (const operation of ['gate', 'finish']) {
    const f = fixture(),
      review = await f.ready(),
      input = { ...f.finish, reviewId: review.id };
    const rpc = async (method, p) =>
      method === 'sessions.list'
        ? {
            sessions: [13, 23].map((n) => ({
              key: `agent:opencode:acp:${id(n)}`,
              hasActiveRun: false,
              hasActiveSubagentRun: false,
              lastRunId: id(n - 1),
            })),
            hasMore: false,
          }
        : f.rpc(method, p);
    const result = await operate(operation, input, rpc, f.git);
    assert.equal(result.status, operation === 'gate' ? 'publication-ready' : 'finished');
  }
});

async function hostedFixture() {
  const f = fixture(),
    review = await f.ready();
  const g = githubFixture();
  f.cards[0].notes =
    f.cards[0].notes.replace('file:///tmp/remote.git', 'https://github.com/owner/repo.git') +
    `\nRequired CI: ${JSON.stringify(g.spec.workflows)}`;
  const rpc = async (method, p) =>
    method === 'sessions.list'
      ? {
          sessions: [13, 23].map((n) => ({
            key: `agent:opencode:acp:${id(n)}`,
            hasActiveRun: false,
            hasActiveSubagentRun: false,
            lastRunId: id(n - 1),
          })),
          hasMore: false,
        }
      : f.rpc(method, p);
  const git = (cwd, args) =>
    args[0] === 'remote' ? 'https://github.com/owner/repo.git' : f.git(cwd, args);
  const input = {
    ...f.finish,
    reviewId: review.id,
    hosted: { headRef: g.spec.headRef, baseSha: g.spec.baseSha, prNumber: g.spec.prNumber },
  };
  return {
    ...f,
    rpc,
    git,
    input,
    g,
    review,
    run: (op, p = input, request = g.request) => operate(op, p, rpc, git, request),
  };
}

for (const backend of ['local', 'hosted'])
  for (const operation of ['gate', 'finish'])
    for (const fault of ['missing-seal', 'wrong-label', 'wrong-key'])
      test(`${backend} ${operation} rejects noncanonical independent review ${fault} before effects`, async () => {
        const f = backend === 'hosted' ? await hostedFixture() : fixture(),
          review = backend === 'hosted' ? f.review : await f.ready();
        if (backend === 'hosted' && operation === 'finish') {
          await f.run('gate');
          f.g.merge();
        }
        if (fault === 'missing-seal')
          review.notes = review.notes.replace(/\nCreation: sha256:[0-9a-f]{64}$/m, '');
        if (fault === 'wrong-label') review.labels = ['type:work-item'];
        if (fault === 'wrong-key')
          review.metadata.automation.idempotencyKey = `work-item:${id(2)}:independent-review`;
        const writes = () =>
            f.calls.filter(
              (call) =>
                !['workboard.cards.list', 'tasks.list', 'tasks.get', 'sessions.list'].includes(
                  call.method,
                ),
            ).length,
          before = writes();
        const run =
          backend === 'hosted' ? f.run(operation) : operate(operation, f.finish, f.rpc, f.git);
        await assert.rejects(run, /Canonical review/);
        assert.equal(writes(), before);
      });

for (const backend of ['local', 'hosted'])
  for (const operation of ['gate', 'finish'])
    for (const fault of ['wrong-tenant', 'wrong-key', 'wrong-feature'])
      test(`${backend} ${operation} rejects relevant Work item ${fault} before effects`, async () => {
        const f = backend === 'hosted' ? await hostedFixture() : fixture();
        if (backend === 'local') await f.ready();
        if (backend === 'hosted' && operation === 'finish') {
          await f.run('gate');
          f.g.merge();
        }
        const item = f.cards[2];
        if (fault === 'wrong-tenant') item.metadata.automation.tenant = id(77);
        if (fault === 'wrong-key')
          item.metadata.automation.idempotencyKey = `work-item:${id(77)}:implementation`;
        if (fault === 'wrong-feature')
          item.notes = item.notes.replace(`Feature: ${id(2)}`, `Feature: ${id(77)}`);
        const writes = () =>
            f.calls.filter(
              (call) =>
                !['workboard.cards.list', 'tasks.list', 'tasks.get', 'sessions.list'].includes(
                  call.method,
                ),
            ).length,
          before = writes();
        const run =
          backend === 'hosted' ? f.run(operation) : operate(operation, f.finish, f.rpc, f.git);
        await assert.rejects(run, /Malformed Feature Work item/);
        assert.equal(writes(), before);
      });

for (const backend of ['local', 'hosted'])
  test(`${backend} publication ignores an unrelated valid Work item`, async () => {
    const f = backend === 'hosted' ? await hostedFixture() : fixture();
    if (backend === 'local') await f.ready();
    f.cards.push({
      id: id(77),
      agentId: 'gilfoyle',
      status: 'todo',
      createdAt: 1,
      updatedAt: 1,
      notes: `Type: work-item\nFeature: ${id(76)}\nRequires Work items: none\nAssignment: unrelated`,
      metadata: {
        automation: {
          boardId: 'project',
          tenant: id(76),
          idempotencyKey: `work-item:${id(76)}:unrelated`,
        },
      },
    });
    const result =
      backend === 'hosted' ? await f.run('gate') : await operate('gate', f.finish, f.rpc, f.git);
    assert(['publication-ready', 'merge-ready'].includes(result.status));
  });

for (const backend of ['local', 'hosted'])
  test(`${backend} completed Feature retry rejects noncanonical review identity`, async () => {
    const f = backend === 'hosted' ? await hostedFixture() : fixture(),
      review = backend === 'hosted' ? f.review : await f.ready();
    if (backend === 'hosted') {
      await f.run('gate');
      f.g.merge();
      await f.run('finish');
    } else await operate('finish', f.finish, f.rpc, f.git);
    review.notes = review.notes.replace(/\nCreation: sha256:[0-9a-f]{64}$/m, '');
    review.labels = ['type:work-item'];
    review.metadata.automation.idempotencyKey = `work-item:${id(2)}:independent-review`;
    await assert.rejects(
      backend === 'hosted' ? f.run('finish') : operate('finish', f.finish, f.rpc, f.git),
      /review/i,
    );
  });

for (const style of ['exact', 'period-details', 'newline-details'])
  test(`publication accepts bounded leading review candidate proof: ${style}`, async () => {
    const f = await hostedFixture();
    f.review.metadata.proof[0].note =
      style === 'exact'
        ? `Candidate: ${sha}`
        : style === 'period-details'
          ? `Candidate: ${sha}. 37 tests passed with no findings.`
          : `Candidate: ${sha}\n37 tests passed with no findings.`;
    assert.equal((await f.run('gate')).status, 'merge-ready');
  });

for (const note of [
  `Candidate: ${sha}evil`,
  `Reviewed Candidate: ${sha}`,
  `Review passed; Candidate: ${sha}`,
  `Candidate: ${'b'.repeat(40)}`,
  `Candidate: ${sha.slice(0, -1)}`,
])
  test('publication rejects unbound or inexact review candidate proof', async () => {
    const f = await hostedFixture();
    f.review.metadata.proof[0].note = note;
    await assert.rejects(f.run('gate'), /SHA-bound passed review/);
  });

for (const field of ['status', 'label'])
  test(`publication requires exact independent review proof ${field}`, async () => {
    const f = await hostedFixture();
    f.review.metadata.proof[0][field] = field === 'status' ? 'Passed' : 'Independent Review';
    await assert.rejects(f.run('gate'), /Required work unfinished|SHA-bound passed review/);
  });

test('publication enforces the native review proof note limit', async () => {
  for (const over of [0, 1]) {
    const f = await hostedFixture(),
      prefix = `Candidate: ${sha}. `;
    f.review.metadata.proof[0].note = prefix + 'x'.repeat(2000 - prefix.length + over);
    if (over) await assert.rejects(f.run('gate'), /SHA-bound passed review/);
    else assert.equal((await f.run('gate')).status, 'merge-ready');
  }
});

test('hosted upload, merge gate receipt and actual merged finish reuse canonical notice', async () => {
  const f = await hostedFixture();
  assert.equal(
    (
      await f.run('publish-gate', {
        ...f.input,
        hosted: { ...f.input.hosted, prNumber: undefined },
      })
    ).status,
    'publication-ready',
  );
  assert.equal((await f.run('gate')).status, 'merge-ready');
  const notes = f.cards[1].notes;
  await f.run('gate');
  assert.equal(f.cards[1].notes, notes);
  assert.equal((notes.match(/^Hosted gate:/gm) ?? []).length, 1);
  f.g.merge();
  const result = await f.run('finish');
  assert.equal(result.mergeSha, f.g.mergeSha);
  const notice = f.cards.at(-1);
  notice.status = 'done';
  notice.completedAt = Date.now();
  notice.metadata.automation.summary = 'Outcome delivered';
  notice.metadata.archivedAt = Date.now();
  assert.equal((await f.run('finish')).wakeRequired, false);
  assert.equal(
    f.calls.filter(
      (c) =>
        c.method === 'workboard.cards.create' && c.p.idempotencyKey.endsWith(':owner-notification'),
    ).length,
    1,
  );
  assert.equal(f.calls.filter((c) => c.method === 'workboard.cards.complete').length, 1);
});

for (const method of [
  'workboard.cards.create',
  'workboard.cards.complete',
  'workboard.cards.update',
])
  test(`hosted finish recovers ambiguous ${method}`, async () => {
    const f = await hostedFixture();
    await f.run('gate');
    f.g.merge();
    f.failAfter(method);
    await assert.rejects(f.run('finish'));
    await f.run('finish');
    assert.equal(
      f.calls.filter(
        (c) =>
          c.method === 'workboard.cards.create' &&
          c.p.idempotencyKey.endsWith(':owner-notification'),
      ).length,
      1,
    );
    assert.equal(f.calls.filter((c) => c.method === 'workboard.cards.complete').length, 1);
  });

test('hosted gate retries an ambiguously accepted receipt without duplicating it', async () => {
  const f = await hostedFixture();
  f.failAfter('workboard.cards.update');
  await assert.rejects(f.run('gate'));
  await f.run('gate');
  assert.equal((f.cards[1].notes.match(/^Hosted gate:/gm) ?? []).length, 1);
});

test('hosted checkpoint accepts native audit fields but rejects drift after the CAS receipt', async () => {
  for (const drift of [false, true]) {
    const f = await hostedFixture();
    const rpc = async (method, p) => {
      const result = await f.rpc(method, p);
      if (method === 'workboard.cards.update' && p.id === id(2)) {
        f.cards[1].events = [{ kind: 'specified', at: Date.now() }];
        result.card.events = structuredClone(f.cards[1].events);
        if (drift) f.cards[1].notes += '\nChanged: after CAS';
      }
      return result;
    };
    const operation = operate('gate', f.input, rpc, f.git, f.g.request);
    if (drift) await assert.rejects(operation, /scope changed/);
    else assert.equal((await operation).status, 'merge-ready');
  }
});

for (const change of [
  (f) => (f.input.reviewId = id(3)),
  (f) =>
    (f.review.notes = f.review.notes.replace(`Candidate: ${sha}`, `Candidate: ${'c'.repeat(40)}`)),
  (f) => (f.review.metadata.proof[0].note += ' extra substring'),
  (f) => (f.review.notes = f.review.notes.replace('/tmp/review-worktree', '/tmp/repo-worktree')),
  (f) =>
    f.tasks
      .filter((t) => t.runId === id(22))
      .forEach((t) => {
        t.prompt = 'implementation';
      }),
  (f) => (f.input.hosted.baseSha = 'c'.repeat(40)),
  (f) => (f.input.hosted.headRef = 'wrong'),
  (f) => (f.cards[0].notes = f.cards[0].notes.replace('owner/repo', 'other/repo')),
])
  test('hosted rejects wrong review or selected candidate identity', async () => {
    const f = await hostedFixture();
    change(f);
    await assert.rejects(f.run('gate'));
    assert(!f.cards[1].notes.includes('Hosted gate:'));
  });

for (const change of [
  (f) => (f.cards[0].notes += '\nChanged: project'),
  (f) => (f.cards[1].notes += '\nChanged: feature'),
  (f) => (f.review.notes += '\nChanged: review'),
  (f) => (f.cards[2].notes += '\nChanged: required implementation'),
  (f) => f.cards.push({ ...structuredClone(f.cards[2]), id: id(5) }),
  (f) =>
    f.cards.push({
      id: id(60),
      status: 'todo',
      updatedAt: 1,
      notes: `Type: action\nFeature: ${id(2)}`,
      metadata: {
        automation: {
          boardId: 'project',
          tenant: id(2),
          idempotencyKey: `action:${id(2)}:cancellation:stop`,
        },
      },
    }),
])
  test('hosted fresh snapshot denies native drift or stop during remote validation', async () => {
    const f = await hostedFixture();
    let changed = false;
    await assert.rejects(
      f.run('gate', f.input, async (args) => {
        if (!changed) {
          changed = true;
          change(f);
        }
        return f.g.request(args);
      }),
    );
    assert(!f.cards[1].notes.includes('Hosted gate:'));
  });

test('hosted pending CI retains a bounded checkpoint but no passing receipt', async () => {
  const f = await hostedFixture();
  f.g.run.status = 'in_progress';
  f.g.run.conclusion = null;
  assert.equal((await f.run('gate')).status, 'ci-wait');
  assert.match(f.cards[1].notes, /^Wait: hosted-ci$/m);
  const checkpoint = JSON.parse(
    f.cards[1].notes
      .split('\n')
      .find((l) => l.startsWith('Hosted candidate: '))
      .slice('Hosted candidate: '.length),
  );
  assert.equal(checkpoint.sha, f.input.sha);
  assert.equal(checkpoint.prNumber, f.input.hosted.prNumber);
  assert.equal(checkpoint.reviewId, f.input.reviewId);
  assert(!f.cards[1].notes.includes('Hosted gate:'));
  f.g.run.status = 'completed';
  f.g.run.conclusion = 'success';
  await f.run('gate');
  assert(!f.cards[1].notes.includes('Wait: hosted-ci'));
});

test('a later pending CI observation invalidates prior readiness without another ledger', async () => {
  const f = await hostedFixture();
  await f.run('gate');
  f.g.run.status = 'in_progress';
  f.g.run.conclusion = null;
  assert.equal((await f.run('gate')).status, 'ci-wait');
  assert(!f.cards[1].notes.includes('Hosted gate:'));
  f.g.merge();
  await assert.rejects(f.run('finish'), /Retained/);
});

test('malformed retained workflow evidence cannot authorize hosted finish', async () => {
  const f = await hostedFixture();
  await f.run('gate');
  f.g.merge();
  f.cards[1].notes = f.cards[1].notes.replace('"runs":[[10,1]]', '"runs":[[10,0]]');
  await assert.rejects(f.run('finish'), /retained workflow/);
});

test('hosted finish catches project drift during notification staging and preserves the staged notice', async () => {
  const f = await hostedFixture();
  await f.run('gate');
  f.g.merge();
  const rpc = async (method, p) => {
    const result = await f.rpc(method, p);
    if (method === 'workboard.cards.create') f.cards[0].notes += '\nChanged: project';
    return result;
  };
  await assert.rejects(operate('finish', f.input, rpc, f.git, f.g.request), /scope changed/);
  assert.equal(f.cards.at(-1).agentId, 'gilfoyle');
  assert.equal(f.cards[1].status, 'running');
});

test('hosted finish requires matching retained gate and rejects wrong merged commit', async () => {
  const f = await hostedFixture();
  f.g.merge();
  await assert.rejects(f.run('finish'), /Retained/);
  const ready = await hostedFixture();
  await ready.run('gate');
  ready.g.merge();
  await assert.rejects(
    ready.run('finish', { ...ready.input, summary: 'different' }),
    /receipt candidate/,
  );
  ready.g.commit.parents.reverse();
  await assert.rejects(ready.run('finish'));
  assert(
    !ready.calls.some(
      (c) =>
        c.method === 'workboard.cards.create' && c.p.idempotencyKey.endsWith(':owner-notification'),
    ),
  );
});

test('maximum summary and retained scope fit upload, CI wait, receipt and finish without duplication', async () => {
  const f = await hostedFixture();
  f.input.summary = 'S'.repeat(1400);
  f.cards[1].notes = (f.cards[1].notes + '\nScope: ').padEnd(500, 'x');
  const original = f.cards[1].notes;
  assert.equal(
    (
      await f.run('publish-gate', {
        ...f.input,
        hosted: { ...f.input.hosted, prNumber: undefined },
      })
    ).status,
    'publication-ready',
  );
  f.g.run.status = 'in_progress';
  f.g.run.conclusion = null;
  assert.equal((await f.run('gate')).status, 'ci-wait');
  f.g.run.status = 'completed';
  f.g.run.conclusion = 'success';
  assert.equal((await f.run('gate')).status, 'merge-ready');
  assert(f.cards[1].notes.startsWith(original + '\n'));
  assert.equal(f.cards[1].notes.split(f.input.summary).length, 2);
  const receipt = JSON.parse(
    f.cards[1].notes
      .split('\n')
      .find((l) => l.startsWith('Hosted gate: '))
      .slice('Hosted gate: '.length),
  );
  assert.match(receipt.binding, /^[0-9a-f]{64}$/);
  assert.deepEqual(receipt.runs, [[10, 1]]);
  f.g.merge();
  assert.equal((await f.run('finish')).status, 'finished');
  for (const call of f.calls)
    if (call.p.patch?.notes || call.method === 'workboard.cards.create')
      assert((call.p.patch?.notes ?? call.p.notes).length <= 4000);
});

test('upload reserves worst-case PR/run/attempt capacity at 4000 and rejects one character over before remote reads', async () => {
  for (const over of [0, 1]) {
    const f = await hostedFixture(),
      maximum = Number.MAX_SAFE_INTEGER;
    f.input.summary = 'S'.repeat(1400);
    const binding = {
      repo: f.g.spec.repo,
      branch: f.g.spec.branch,
      headRef: f.input.hosted.headRef,
      baseSha: f.input.hosted.baseSha,
      sha: f.input.sha,
      reviewId: f.input.reviewId,
      summary: f.input.summary,
      prNumber: maximum,
      workflows: f.g.spec.workflows,
    };
    const candidate = `Hosted candidate: ${JSON.stringify(binding)}`;
    const receipt = `Hosted gate: ${JSON.stringify({ binding: '0'.repeat(64), runs: [[maximum, maximum]] })}`;
    f.cards[1].notes = (f.cards[1].notes + '\nScope: ').padEnd(
      4000 - candidate.length - receipt.length - 2 + over,
      'x',
    );
    const original = f.cards[1].notes;
    const upload = f.run('publish-gate', {
      ...f.input,
      hosted: { ...f.input.hosted, prNumber: undefined },
    });
    if (over) {
      await assert.rejects(upload, /checkpoint capacity/);
      assert.equal(f.g.calls.length, 0);
      assert.equal(f.cards[1].notes, original);
      assert(!f.calls.some((c) => c.method === 'workboard.cards.update' && c.p.id === f.input.id));
      continue;
    }
    assert.equal((await upload).status, 'publication-ready');
    const request = async (args) => {
      const rewritten = [...args];
      rewritten[5] = rewritten[5]
        .replace(`pulls/${maximum}`, 'pulls/7')
        .replace(`runs/${maximum}`, 'runs/10')
        .replace(`attempts/${maximum}`, 'attempts/1');
      const value = await f.g.request(rewritten);
      if (value.number === 7) value.number = maximum;
      for (const run of value.workflow_runs ?? (value.id === 10 ? [value] : [])) {
        run.id = maximum;
        run.run_attempt = maximum;
      }
      for (const job of value.jobs ?? []) job.run_id = maximum;
      return value;
    };
    const input = { ...f.input, hosted: { ...f.input.hosted, prNumber: maximum } };
    f.g.run.status = 'in_progress';
    f.g.run.conclusion = null;
    assert.equal((await f.run('gate', input, request)).status, 'ci-wait');
    assert(f.cards[1].notes.length <= 4000);
    f.g.run.status = 'completed';
    f.g.run.conclusion = 'success';
    assert.equal((await f.run('gate', input, request)).status, 'merge-ready');
    assert.equal(f.cards[1].notes.length, 4000);
    assert(f.cards[1].notes.startsWith(original + '\n'));
    f.g.merge();
    assert.equal((await f.run('finish', input, request)).status, 'finished');
  }
});

test('compact receipt digest rejects changes to the retained candidate or project requirements', async () => {
  for (const change of [
    (f) => {
      f.input.summary = 'new summary';
      f.cards[1].notes = f.cards[1].notes.replace(
        '"summary":"Requested conditions verified."',
        '"summary":"new summary"',
      );
    },
    (f) => {
      f.cards[0].notes = f.cards[0].notes.replace('"jobs":["test"]', '"jobs":["test","lint"]');
      f.cards[1].notes = f.cards[1].notes.replace('"jobs":["test"]', '"jobs":["test","lint"]');
    },
  ]) {
    const f = await hostedFixture();
    await f.run('gate');
    f.g.merge();
    change(f);
    await assert.rejects(f.run('finish'), /receipt candidate mismatch/);
    assert(
      !f.calls.some(
        (c) =>
          c.method === 'workboard.cards.create' &&
          c.p.idempotencyKey.endsWith(':owner-notification'),
      ),
    );
  }
});

test('ordinary CI progress during remote validation persists a resumable wait', async () => {
  const f = await hostedFixture();
  let listings = 0;
  f.g.run.status = 'queued';
  f.g.run.conclusion = null;
  const request = async (args) => {
    const value = await f.g.request(args);
    if (args[5].includes('/workflows/') && ++listings === 2) {
      value.workflow_runs[0].status = 'in_progress';
      value.workflow_runs[0].updated_at = '2026-09-12T12:01:00Z';
    }
    return value;
  };
  assert.equal((await f.run('gate', f.input, request)).status, 'ci-wait');
  assert.match(f.cards[1].notes, /^Wait: hosted-ci$/m);
  assert.match(f.cards[1].notes, /^Hosted candidate: /m);
});
