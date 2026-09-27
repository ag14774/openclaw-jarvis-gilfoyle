import assert from 'node:assert/strict';
import test from 'node:test';
import './support/setup.ts';
import { Store } from '../src/store.ts';
import { createFeatureCard, createProductCard } from '../src/helpers/create-card.ts';
import {
  operate,
  requireFinishPublication,
  requirePassedPublication,
  validateSelectedReview,
} from '../src/helpers/native-operation.ts';
import { handoffCard, projectAnsweredDecision } from '../src/helpers/handoff-card.ts';
import { amendFeature } from '../src/helpers/amend-feature.ts';
import { terminalHandoff } from '../src/helpers/terminal-handoff.ts';
import { finalizeFeature } from '../src/helpers/finalize-feature.ts';
import { validateRegisteredCompletion } from '../src/helpers/completion-guard.ts';
import { classifyCards, readView, workerCapacity } from '../src/helpers/workboard-page.ts';
import { ProjectRuntime } from '../src/runtime.ts';
import { reconcileExecutionBindings } from '../src/helpers/execution-bindings.ts';
import { assertEngineeringMutationScope } from '../src/helpers/authority.ts';
import { isCompletionMutation } from '../src/index.ts';

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = 'a'.repeat(40);
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
  scope: 'Repository scope.',
  evidence: 'Verified.',
};

function state() {
  let tick = 100;
  let nextCard = 10;
  const cards = [];
  const tasks = new Map();
  const sessions = [];
  const fail = new Set();
  const store = new Store(':memory:', { now: () => ++tick });
  const project = store.declare({
    key: 'project',
    name: 'Project',
    purpose: 'Exercise transitions.',
    route,
    productFallback: route,
  });
  store.attach(project.id, 'board', repository);
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
        id: id(nextCard++),
        createdAt: ++tick,
        updatedAt: tick,
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
      if (fail.delete(method)) throw new Error('accepted create response lost');
      return { card: structuredClone(card) };
    }
    const card = cards.find((candidate) => candidate.id === input.id);
    if (method === 'workboard.cards.update') {
      assert.equal(input.expectedUpdatedAt, card.updatedAt);
      Object.assign(card, structuredClone(input.patch));
      card.updatedAt = ++tick;
      if (fail.delete(method)) throw new Error('accepted update response lost');
      return { card: structuredClone(card) };
    }
    if (method === 'workboard.cards.complete') {
      card.status = 'done';
      delete card.metadata.claim;
      card.metadata.automation.summary = input.summary;
      card.metadata.proof = [input.proof];
      card.updatedAt = ++tick;
      if (fail.delete(method)) throw new Error('accepted completion response lost');
      return { card: structuredClone(card) };
    }
    if (method === 'workboard.cards.release') {
      delete card.metadata.claim;
      card.status = input.status;
      card.updatedAt = ++tick;
      return { card: structuredClone(card) };
    }
    if (method === 'tasks.get') return { task: structuredClone(tasks.get(input.taskId)) };
    if (method === 'tasks.list') return { tasks: structuredClone([...tasks.values()]) };
    if (method === 'sessions.list') return { sessions: structuredClone(sessions), hasMore: false };
    throw new Error(`Unexpected RPC ${method}`);
  };
  const git = (cwd, args) => {
    if (args[0] === 'worktree')
      return `worktree /tmp/project\nHEAD ${sha}\nbranch refs/heads/main\n\nworktree /tmp/work\nHEAD ${sha}\nbranch refs/heads/work-a1\n\nworktree /tmp/review\nHEAD ${sha}\nbranch refs/heads/review-a1\n\nworktree /tmp/replacement\nHEAD ${sha}\nbranch refs/heads/work-a2`;
    if (args[0] === 'status') return '';
    if (args[0] === 'symbolic-ref')
      return cwd === '/tmp/review'
        ? 'review-a1'
        : cwd === '/tmp/replacement'
          ? 'work-a2'
          : cwd === '/tmp/work'
            ? 'work-a1'
            : 'main';
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return cwd;
    if (args[0] === 'rev-parse') return sha;
    if (args[0] === 'remote') return repository.repository;
    if (args[0] === 'merge-base') return '';
    throw new Error(`Unexpected Git ${args.join(' ')}`);
  };
  return { store, project, cards, tasks, sessions, fail, rpc, git };
}

async function featureFixture(s, source = 'source') {
  const request = s.store.createRequest({
    project: s.project.id,
    source: { messageId: source },
    title: 'Feature',
    scope: 'Deliver the requested behavior.',
  });
  const feature = await createFeatureCard(
    { boardId: 'board', title: request.title, scope: request.scope },
    s.rpc,
    { store: s.store, project: s.project.id, request: request.id },
  );
  return { request, feature };
}

async function workFixture(s, featureId, assignment = 'implementation') {
  return createProductCard(
    'work-item',
    {
      boardId: 'board',
      featureId,
      assignment,
      title: 'Implement',
      scope: 'Implement safely.',
      requires: [],
    },
    s.rpc,
    { store: s.store, project: s.project.id },
  );
}

test('runtime intake creates one request and recovers board-local native creation', async () => {
  const s = state();
  s.store.attach(s.project.id, 'other', {
    ...repository,
    name: 'Other',
    repository: 'file:///tmp/other.git',
    checkout: '/tmp/other',
  });
  s.fail.add('workboard.cards.create');
  const runtime = new ProjectRuntime(s.store, async (method, input) => {
    return s.rpc(method, input);
  });
  const result = await runtime.intake(
    s.store.project(s.project.id),
    { title: 'Cross repo', scope: 'Change both.', boards: ['board', 'other'] },
    { route, messageId: '42' },
  );
  assert.equal(result.features.length, 2);
  assert.equal(s.store.all('SELECT * FROM requests').length, 1);
  for (const feature of s.store.all('SELECT card,native_key FROM features')) {
    const card = s.cards.find((candidate) => candidate.id === feature.card);
    assert(card);
    assert.equal(feature.native_key, card.metadata.automation.idempotencyKey);
  }
});

test('registry identities exist before create and recover both accepted create responses', async () => {
  const s = state();
  const request = s.store.createRequest({
    project: s.project.id,
    source: { messageId: '1' },
    title: 'Feature',
    scope: 'Scope.',
  });
  let featureReserved = false;
  const rpc = async (method, input) => {
    if (method === 'workboard.cards.create') {
      const pending = s.store.get('SELECT * FROM features WHERE request=?', request.id);
      featureReserved = Boolean(
        pending && !pending.card && pending.native_key === input.idempotencyKey,
      );
      s.fail.add(method);
    }
    return s.rpc(method, input);
  };
  const feature = await createFeatureCard(
    { boardId: 'board', title: request.title, scope: request.scope },
    rpc,
    { store: s.store, project: s.project.id, request: request.id },
  );
  assert(featureReserved && s.store.feature(feature.featureId).card);
  let obligationReserved = false;
  const obligationRpc = async (method, input) => {
    if (method === 'workboard.cards.create') {
      const pending = s.store.get("SELECT * FROM obligations WHERE kind='work'");
      obligationReserved = Boolean(
        pending && !pending.card && pending.native_key === input.idempotencyKey,
      );
      s.fail.add(method);
    }
    return s.rpc(method, input);
  };
  const work = await createProductCard(
    'work-item',
    {
      boardId: 'board',
      featureId: feature.featureId,
      assignment: 'work',
      title: 'Work',
      scope: 'Do work.',
      requires: [],
    },
    obligationRpc,
    { store: s.store, project: s.project.id },
  );
  assert(obligationReserved && s.store.obligation(work.obligationId).card);
});

test('review candidate is immutable and preparation always uses the registry candidate', async () => {
  const s = state();
  const { feature } = await featureFixture(s);
  const review = await createProductCard(
    'review',
    {
      boardId: 'board',
      featureId: feature.featureId,
      reviewKey: 'candidate',
      candidate: sha,
      title: 'Review',
      scope: 'Review candidate.',
      requires: [],
    },
    s.rpc,
    { store: s.store, project: s.project.id },
  );
  assert.equal(s.store.obligation(review.obligationId).candidate, sha);
  const prepared = await operate(
    'prepare',
    {
      boardId: 'board',
      id: review.card.id,
      attempt: 1,
      taskName: 'review-a1',
      profileId: 'deep',
      timeoutSeconds: 1800,
      baseSha: sha,
      worktree: '/tmp/review',
      branch: 'review-a1',
    },
    s.rpc,
    s.git,
    undefined,
    { store: s.store, project: s.project.id, repository },
  );
  assert(prepared.spawnArgs.task.includes(`Candidate: ${sha}`));
  await assert.rejects(
    operate(
      'prepare',
      {
        boardId: 'board',
        id: review.card.id,
        attempt: 2,
        taskName: 'review-a2',
        profileId: 'deep',
        timeoutSeconds: 1800,
        baseSha: 'b'.repeat(40),
        worktree: '/tmp/replacement',
        branch: 'work-a2',
        replaces: prepared.attemptId,
        remaining: 'Review again.',
        reconciliation: 'Prior review settled.',
      },
      s.rpc,
      s.git,
      undefined,
      { store: s.store, project: s.project.id, repository },
    ),
    /candidate/,
  );
  assert.throws(() =>
    s.store.publication({
      feature: feature.featureId,
      candidate: 'b'.repeat(40),
      reviewObligation: review.obligationId,
      backend: 'git',
      state: 'candidate',
      details: {},
    }),
  );
});

test('prepare and bind retries are idempotent, while changed retries fail', async () => {
  const s = state();
  const { feature } = await featureFixture(s);
  const work = await workFixture(s, feature.featureId);
  const input = {
    boardId: 'board',
    id: work.card.id,
    attempt: 1,
    taskName: 'work-a1',
    profileId: 'deep',
    timeoutSeconds: 1800,
    baseSha: sha,
    worktree: '/tmp/work',
    branch: 'work-a1',
  };
  const first = await operate('prepare', input, s.rpc, s.git, undefined, {
    store: s.store,
    project: s.project.id,
    repository,
  });
  const retry = await operate('prepare', input, s.rpc, s.git, undefined, {
    store: s.store,
    project: s.project.id,
    repository,
  });
  assert.equal(retry.attemptId, first.attemptId);
  assert.equal(retry.reused, true);
  await assert.rejects(
    operate('prepare', { ...input, timeoutSeconds: 1200 }, s.rpc, s.git, undefined, {
      store: s.store,
      project: s.project.id,
      repository,
    }),
    /conflicts/,
  );
  const owner = `agent:gilfoyle:jarvis-gilfoyle:${feature.featureId}`;
  for (const [taskId, runtime] of [
    [id(50), 'acp'],
    [id(51), 'subagent'],
  ])
    s.tasks.set(taskId, {
      taskId,
      runtime,
      agentId: 'opencode',
      runId: id(52),
      childSessionKey: `agent:opencode:acp:${id(53)}`,
      ownerKey: owner,
      sessionKey: owner,
      status: 'running',
      prompt: `Work item: ${work.card.id}\nTask name: work-a1`,
    });
  const record = {
    boardId: 'board',
    id: work.card.id,
    attemptId: first.attemptId,
    taskId: id(50),
    wrapperTaskId: id(51),
    runId: id(52),
    childSessionKey: `agent:opencode:acp:${id(53)}`,
  };
  const bound = await operate('record', record, s.rpc, s.git, undefined, {
    store: s.store,
    project: s.project.id,
    repository,
  });
  assert.equal(
    (
      await operate('record', record, s.rpc, s.git, undefined, {
        store: s.store,
        project: s.project.id,
        repository,
      })
    ).attemptId,
    bound.attemptId,
  );
  await assert.rejects(
    validateRegisteredCompletion(
      s.store,
      s.store.project(s.project.id),
      s.cards,
      work.card.id,
      s.rpc,
    ),
  );
  for (const task of s.tasks.values()) task.status = 'completed';
  s.sessions.push({
    key: record.childSessionKey,
    hasActiveRun: false,
    hasActiveSubagentRun: false,
  });
  assert.equal(
    (
      await validateRegisteredCompletion(
        s.store,
        s.store.project(s.project.id),
        s.cards,
        work.card.id,
        s.rpc,
      )
    ).allowed,
    true,
  );
});

test('replacement preparation requires terminal tasks and an inactive exact session', async () => {
  const s = state();
  const { feature } = await featureFixture(s);
  const work = await workFixture(s, feature.featureId);
  const prior = s.store.prepareAttempt({
    obligation: work.obligationId,
    sequence: 1,
    profileId: 'deep',
    model: 'openai/gpt-5.6-sol',
    thinking: 'high',
    taskName: 'work-a1',
    timeoutSeconds: 1800,
    baseSha: sha,
    worktree: '/tmp/work',
    branch: 'work-a1',
  });
  s.store.bindAttempt(prior.id, {
    task_id: id(60),
    wrapper_task_id: id(61),
    run_id: id(62),
    child_session: `agent:opencode:acp:${id(63)}`,
  });
  for (const [taskId, runtime] of [
    [id(60), 'acp'],
    [id(61), 'subagent'],
  ])
    s.tasks.set(taskId, {
      taskId,
      runtime,
      agentId: 'opencode',
      ownerKey: `agent:gilfoyle:jarvis-gilfoyle:${feature.featureId}`,
      sessionKey: `agent:gilfoyle:jarvis-gilfoyle:${feature.featureId}`,
      runId: id(62),
      childSessionKey: `agent:opencode:acp:${id(63)}`,
      status: 'running',
    });
  s.sessions.push({
    key: `agent:opencode:acp:${id(63)}`,
    hasActiveRun: true,
    hasActiveSubagentRun: true,
  });
  const replacement = {
    boardId: 'board',
    id: work.card.id,
    attempt: 2,
    taskName: 'work-a2',
    profileId: 'deep',
    timeoutSeconds: 1800,
    baseSha: sha,
    worktree: '/tmp/replacement',
    branch: 'work-a2',
    replaces: prior.id,
    remaining: 'Complete remaining work.',
    reconciliation: 'Prior task inspected and remaining work identified.',
  };
  await assert.rejects(
    operate('prepare', replacement, s.rpc, s.git, undefined, {
      store: s.store,
      project: s.project.id,
      repository,
    }),
    /terminal/,
  );
  for (const task of s.tasks.values()) task.status = 'completed';
  s.sessions[0].hasActiveRun = false;
  s.sessions[0].hasActiveSubagentRun = false;
  assert.equal(
    (
      await operate('prepare', replacement, s.rpc, s.git, undefined, {
        store: s.store,
        project: s.project.id,
        repository,
      })
    ).status,
    'prepared',
  );
});

test('stop blocks new execution and settles only after execution reconciliation', async () => {
  const s = state();
  const { request, feature } = await featureFixture(s);
  const work = await workFixture(s, feature.featureId);
  const prior = s.store.prepareAttempt({
    obligation: work.obligationId,
    sequence: 1,
    profileId: 'deep',
    model: 'openai/gpt-5.6-sol',
    thinking: 'high',
    taskName: 'work-a1',
    timeoutSeconds: 1800,
    baseSha: sha,
    worktree: '/tmp/work',
    branch: 'work-a1',
  });
  s.store.bindAttempt(prior.id, {
    task_id: id(64),
    wrapper_task_id: id(65),
    run_id: id(66),
    child_session: `agent:opencode:acp:${id(67)}`,
  });
  for (const [taskId, runtime] of [
    [id(64), 'acp'],
    [id(65), 'subagent'],
  ])
    s.tasks.set(taskId, {
      taskId,
      runtime,
      agentId: 'opencode',
      ownerKey: `agent:gilfoyle:jarvis-gilfoyle:${feature.featureId}`,
      sessionKey: `agent:gilfoyle:jarvis-gilfoyle:${feature.featureId}`,
      runId: id(66),
      childSessionKey: `agent:opencode:acp:${id(67)}`,
      status: 'running',
    });
  s.sessions.push({
    key: `agent:opencode:acp:${id(67)}`,
    hasActiveRun: true,
    hasActiveSubagentRun: true,
  });
  const control = s.store.control({
    project: s.project.id,
    request: request.id,
    feature: feature.featureId,
    reason: 'Stop now.',
  });
  await assert.rejects(
    operate(
      'prepare',
      {
        boardId: 'board',
        id: work.card.id,
        attempt: 1,
        taskName: 'work-a1',
        profileId: 'deep',
        timeoutSeconds: 1800,
        baseSha: sha,
        worktree: '/tmp/work',
        branch: 'work-a1',
      },
      s.rpc,
      s.git,
      undefined,
      { store: s.store, project: s.project.id, repository },
    ),
    /stop control/,
  );
  await assert.rejects(
    operate(
      'gate',
      { boardId: 'board', id: feature.card.id, sha, reviewId: id(999), summary: 'Blocked.' },
      s.rpc,
      s.git,
      undefined,
      { store: s.store, project: s.project.id, repository },
    ),
    /stop control/,
  );
  await assert.rejects(
    finalizeFeature(
      { boardId: 'board', id: feature.card.id, summary: 'Blocked.', evidence: 'Evidence.' },
      s.rpc,
      s.git,
      { store: s.store, project: s.project.id, repository },
    ),
    /stop control/,
  );
  await assert.rejects(
    operate(
      'settle-control',
      { boardId: 'board', controlId: control.id },
      s.rpc,
      s.git,
      undefined,
      { store: s.store, project: s.project.id, repository },
    ),
    /terminal/,
  );
  for (const task of s.tasks.values()) task.status = 'completed';
  s.sessions[0].hasActiveRun = false;
  s.sessions[0].hasActiveSubagentRun = false;
  const settled = await operate(
    'settle-control',
    { boardId: 'board', controlId: control.id },
    s.rpc,
    s.git,
    undefined,
    { store: s.store, project: s.project.id, repository },
  );
  assert.equal(settled.control.state, 'applied');
  assert.equal(
    (
      await operate(
        'prepare',
        {
          boardId: 'board',
          id: work.card.id,
          attempt: 1,
          taskName: 'work-a1',
          profileId: 'deep',
          timeoutSeconds: 1800,
          baseSha: sha,
          worktree: '/tmp/work',
          branch: 'work-a1',
        },
        s.rpc,
        s.git,
        undefined,
        { store: s.store, project: s.project.id, repository },
      )
    ).reused,
    true,
  );
});

test('decision projection and application recover from accepted update response loss', async () => {
  const s = state();
  const { feature } = await featureFixture(s);
  const work = await workFixture(s, feature.featureId);
  s.fail.add('workboard.cards.update');
  const input = {
    boardId: 'board',
    id: work.card.id,
    checkpoint: id(70),
    expectedUpdatedAt: work.card.updatedAt,
    reason: 'Choice needed.',
    question: 'Proceed?',
    resolution: 'Proceed safely.',
    decisionBy: 'agent',
  };
  const first = await handoffCard('handoff', input, s.rpc, {
    store: s.store,
    project: s.project.id,
  });
  assert.equal(first.phase, 'open');
  assert.equal(s.store.all('SELECT * FROM decisions').length, 1);
  assert.equal(
    (
      await handoffCard(
        'handoff',
        { ...input, expectedUpdatedAt: s.cards.find((card) => card.id === work.card.id).updatedAt },
        s.rpc,
        { store: s.store, project: s.project.id },
      )
    ).checkpoint,
    id(70),
  );
  await handoffCard(
    'handoff-decision',
    { checkpoint: id(70), decision: 'Yes.', evidence: 'Product evidence.' },
    s.rpc,
    { store: s.store, project: s.project.id },
  );
  s.fail.add('workboard.cards.update');
  const apply = {
    checkpoint: id(70),
    application: 'Proceed.',
    replacementRequired: false,
    expectedUpdatedAt: s.cards.find((card) => card.id === work.card.id).updatedAt,
  };
  await handoffCard('handoff-apply', apply, s.rpc, { store: s.store, project: s.project.id });
  assert.equal(
    (
      await handoffCard(
        'handoff-apply',
        { ...apply, expectedUpdatedAt: s.cards.find((card) => card.id === work.card.id).updatedAt },
        s.rpc,
        { store: s.store, project: s.project.id },
      )
    ).phase,
    'applied',
  );
});

test('Feature amendments are isolated, revisioned, and recover an ambiguous native update', async () => {
  const s = state();
  const { request, feature } = await featureFixture(s);
  s.fail.add('workboard.cards.update');
  const result = await amendFeature(
    {
      boardId: 'board',
      featureId: feature.featureId,
      expectedRevision: 1,
      expectedUpdatedAt: feature.card.updatedAt,
      scope: 'Revised Feature scope.',
      reason: 'Owner amendment.',
      source: 'message:2',
    },
    s.rpc,
    { store: s.store, project: s.project.id },
  );
  assert.equal(result.revision, 2);
  assert.equal(s.store.feature(feature.featureId).scope, 'Revised Feature scope.');
  assert.equal(
    s.store.get('SELECT scope FROM requests WHERE id=?', request.id).scope,
    request.scope,
  );
  assert(
    s.store.get(
      'SELECT projected FROM feature_scope_revisions WHERE feature=? AND revision=2',
      feature.featureId,
    ).projected,
  );
  assert.equal(
    (
      await amendFeature(
        {
          boardId: 'board',
          featureId: feature.featureId,
          expectedRevision: 1,
          expectedUpdatedAt: s.cards[0].updatedAt,
          scope: 'Revised Feature scope.',
          reason: 'Owner amendment.',
          source: 'message:2',
        },
        s.rpc,
        { store: s.store, project: s.project.id },
      )
    ).revision,
    2,
  );
});

test('terminal staging survives ambiguous completion and direct Feature completion is guarded', async () => {
  const s = state();
  const { feature } = await featureFixture(s);
  const card = s.cards.find((candidate) => candidate.id === feature.card.id);
  card.status = 'running';
  card.metadata.claim = { ownerId: 'gilfoyle', expiresAt: Date.now() + 10000 };
  await assert.rejects(
    validateRegisteredCompletion(s.store, s.store.project(s.project.id), s.cards, card.id, s.rpc),
    /terminal checkpoint/,
  );
  s.fail.add('workboard.cards.complete');
  const result = await terminalHandoff(
    {
      feature: card,
      summary: 'Finished.',
      evidence: { status: 'passed', label: 'Proof', note: 'Verified.' },
      kind: 'finalize',
    },
    s.rpc,
    { store: s.store, project: s.project.id },
  );
  assert.equal(result.status, 'finished');
  assert.equal(
    (
      await validateRegisteredCompletion(
        s.store,
        s.store.project(s.project.id),
        s.cards,
        card.id,
        s.rpc,
      )
    ).checkpoint,
    'completed',
  );
  assert.equal(s.store.all('SELECT * FROM deliveries').length, 0);
});

test('publication finish requires the exact passed review, backend, hosted identity, and CI runs', async () => {
  const s = state();
  const { feature } = await featureFixture(s);
  const review = await createProductCard(
    'review',
    {
      boardId: 'board',
      featureId: feature.featureId,
      reviewKey: 'candidate',
      candidate: sha,
      title: 'Review',
      scope: 'Review.',
      requires: [],
    },
    s.rpc,
    { store: s.store, project: s.project.id },
  );
  assert.throws(
    () =>
      requirePassedPublication(s.store, feature.featureId, review.obligationId, sha, 'github', {}),
    /passed/,
  );
  const hosted = {
    repo: 'owner/repo',
    branch: 'main',
    headRef: 'feature',
    baseSha: 'b'.repeat(40),
    prNumber: 7,
    workflows: [{ path: '.github/workflows/ci.yml', jobs: ['test'] }],
  };
  s.store.publication({
    feature: feature.featureId,
    candidate: sha,
    reviewObligation: review.obligationId,
    backend: 'github',
    state: 'passed',
    details: { hosted, result: { status: 'merge-ready', runs: [{ id: 10, attempt: 1 }] } },
  });
  assert(
    requirePassedPublication(
      s.store,
      feature.featureId,
      review.obligationId,
      sha,
      'github',
      hosted,
    ),
  );
  const gate = JSON.parse(
    s.store.get('SELECT details FROM publication_checkpoints WHERE feature=?', feature.featureId)
      .details,
  );
  s.store.publication({
    feature: feature.featureId,
    candidate: sha,
    reviewObligation: review.obligationId,
    backend: 'github',
    state: 'merged',
    details: { hosted, gate, merge: { mergeSha: 'd'.repeat(40) }, summary: 'Merged.' },
  });
  assert(
    requireFinishPublication(
      s.store,
      feature.featureId,
      review.obligationId,
      sha,
      'github',
      hosted,
    ),
  );
  assert.throws(
    () =>
      requireFinishPublication(s.store, feature.featureId, review.obligationId, sha, 'github', {
        ...hosted,
        prNumber: 8,
      }),
    /identity/,
  );
});

test('selected publication review is independently required, proved, candidate-bound and terminal', async () => {
  const s = state();
  const { feature } = await featureFixture(s, 'selected-review');
  const review = await createProductCard(
    'review',
    {
      boardId: 'board',
      featureId: feature.featureId,
      reviewKey: 'optional-review',
      candidate: sha,
      title: 'Review',
      scope: 'Review.',
      requires: [],
      required: false,
    },
    s.rpc,
    { store: s.store, project: s.project.id },
  );
  const card = s.cards.find((item) => item.id === review.card.id);
  card.status = 'done';
  card.metadata.proof = [{ status: 'passed', note: 'Passed.' }];
  await assert.rejects(
    validateSelectedReview(
      s.store,
      s.store.feature(feature.featureId),
      s.store.obligation(review.obligationId),
      sha,
      s.cards,
      s.rpc,
    ),
    /Required registered review/,
  );
  s.store.run('UPDATE obligations SET required=1 WHERE id=?', review.obligationId);
  const attempt = s.store.prepareAttempt({
    obligation: review.obligationId,
    sequence: 1,
    profileId: 'deep',
    model: 'openai/gpt-5.6-sol',
    thinking: 'high',
    taskName: 'selected-review-a1',
    timeoutSeconds: 1800,
    baseSha: sha,
    worktree: '/tmp/review',
    branch: 'review-a1',
  });
  const owner = `agent:gilfoyle:jarvis-gilfoyle:${feature.featureId}`;
  const child = `agent:opencode:acp:${id(91)}`;
  s.store.bindAttempt(attempt.id, {
    task_id: id(89),
    wrapper_task_id: id(90),
    run_id: id(92),
    child_session: child,
  });
  for (const [taskId, runtime] of [
    [id(89), 'acp'],
    [id(90), 'subagent'],
  ])
    s.tasks.set(taskId, {
      taskId,
      runtime,
      agentId: 'opencode',
      ownerKey: owner,
      sessionKey: owner,
      runId: id(92),
      childSessionKey: child,
      status: 'completed',
    });
  s.sessions.push({ key: child, hasActiveRun: true, hasActiveSubagentRun: false });
  const searches = [];
  const exactRpc = async (method, input) => {
    if (method === 'sessions.list') searches.push(input);
    return s.rpc(method, input);
  };
  await assert.rejects(
    validateSelectedReview(
      s.store,
      s.store.feature(feature.featureId),
      s.store.obligation(review.obligationId),
      sha,
      s.cards,
      exactRpc,
    ),
    /inactive/,
  );
  s.sessions[0].hasActiveRun = false;
  assert(
    await validateSelectedReview(
      s.store,
      s.store.feature(feature.featureId),
      s.store.obligation(review.obligationId),
      sha,
      s.cards,
      exactRpc,
    ),
  );
  assert(searches.every((input) => input.search === child && input.limit === 10));
});

test('classifier computes child state first and preserves meaningful native holds', async () => {
  const s = state();
  const { feature } = await featureFixture(s);
  const work = await workFixture(s, feature.featureId);
  const records = s.store.records(s.project.id);
  assert.equal(
    classifyCards(s.cards, records, { available: true }).get(feature.card.id).stage,
    'orchestration',
  );
  s.cards.find((card) => card.id === work.card.id).status = 'scheduled';
  let rows = classifyCards(s.cards, records, { available: true });
  assert.equal(rows.get(work.card.id).stage, 'held');
  assert.equal(rows.get(feature.card.id).stage, 'orchestration');
  s.cards.find((card) => card.id === work.card.id).status = 'todo';
  rows = classifyCards(s.cards, records, { available: true });
  assert.equal(rows.get(work.card.id).stage, 'todoUndelegated');
  s.cards.find((card) => card.id === feature.card.id).status = 'backlog';
  assert.equal(
    classifyCards(s.cards, records, { available: true }).get(feature.card.id).stage,
    'held',
  );
});

test('dispatch retry budget resets only when the durable attention version changes', () => {
  const s = state();
  const runtime = new ProjectRuntime(s.store, s.rpc);
  let exchange = s.store.exchange(s.project.id, id(90), 'engineering');
  s.store.run(
    'UPDATE exchanges SET observed=?,attempts=3,lastDispatch=99 WHERE id=?',
    'v1',
    exchange.id,
  );
  exchange = runtime.syncAttention(s.project.id, id(90), 'engineering', 'v1');
  assert.equal(exchange.attempts, 3);
  assert.equal(exchange.lastDispatch, 99);
  exchange = runtime.syncAttention(s.project.id, id(90), 'engineering', 'v2');
  assert.equal(exchange.attempts, 0);
  assert.equal(exchange.lastDispatch, 0);
  s.store.run('UPDATE exchanges SET attempts=3,lastDispatch=99 WHERE id=?', exchange.id);
  assert.equal(runtime.syncAttention(s.project.id, id(90), 'engineering', 'v2').attempts, 3);
});

test('batched delivery settles every member with the actual receipt and event-specific copies', async () => {
  const s = state();
  let sends = 0;
  const runtime = new ProjectRuntime(s.store, async (method, input) => {
    if (method === 'conversations.send')
      return { status: 'sent', messageId: `m${++sends}`, conversationRef: input.conversationRef };
    return s.rpc(method, input);
  });
  const one = s.store.enqueue({
    project: s.project.id,
    event: 'event:one',
    kind: 'milestone',
    message: 'One',
    due: 1,
  });
  const two = s.store.enqueue({
    project: s.project.id,
    event: 'event:two',
    kind: 'result',
    message: 'Two',
    due: 1,
  });
  s.store.copy({ project: s.project.id, event: 'event:one', managerRole: 'product', route });
  s.store.copy({ project: s.project.id, event: 'event:two', managerRole: 'product', route });
  runtime.batchMilestones(s.store.project(s.project.id));
  const leader = s.store.get("SELECT * FROM deliveries WHERE kind='milestone-batch'");
  await runtime.deliver(leader);
  for (const member of [one, two]) {
    const settled = s.store.get('SELECT * FROM deliveries WHERE id=?', member.id);
    assert.equal(settled.status, 'sent');
    assert.equal(JSON.parse(settled.receipt).messageId, 'm1');
  }
  assert.deepEqual(
    s.store
      .all("SELECT event FROM deliveries WHERE kind='copy' ORDER BY event")
      .map((row) => row.event),
    [
      `copy:${s.store.get("SELECT id FROM copies WHERE event='event:one'").id}`,
      `copy:${s.store.get("SELECT id FROM copies WHERE event='event:two'").id}`,
    ].sort(),
  );
});

test('fallback batch settlement propagates the actual fallback receipt to every member', async () => {
  const s = state();
  const runtime = new ProjectRuntime(s.store, s.rpc);
  const one = s.store.enqueue({
    project: s.project.id,
    event: 'fallback:one',
    kind: 'milestone',
    message: 'One',
    due: 1,
  });
  const two = s.store.enqueue({
    project: s.project.id,
    event: 'fallback:two',
    kind: 'result',
    message: 'Two',
    due: 1,
  });
  runtime.batchMilestones(s.store.project(s.project.id));
  const leader = s.store.get("SELECT * FROM deliveries WHERE kind='milestone-batch'");
  const actualRoute = { ...route, conversationRef: `conv_${'b'.repeat(32)}` };
  const receipt = {
    status: 'sent',
    messageId: 'fallback-message',
    conversationRef: actualRoute.conversationRef,
  };
  await runtime.settleBatch(
    {
      ...leader,
      status: 'fallback-sent',
      receipt: JSON.stringify(receipt),
      route: JSON.stringify(actualRoute),
    },
    true,
  );
  for (const member of [one, two]) {
    const row = s.store.get('SELECT * FROM deliveries WHERE id=?', member.id);
    assert.equal(row.status, 'fallback-sent');
    assert.deepEqual(JSON.parse(row.receipt), receipt);
    assert.deepEqual(JSON.parse(row.route), actualRoute);
  }
});

test('delivery resolves the preferred route at send time and schedules skip missed occurrences', async () => {
  const s = state();
  const moved = { ...route, conversationRef: `conv_${'c'.repeat(32)}`, target: 'telegram:2' };
  const calls = [];
  const runtime = new ProjectRuntime(s.store, async (method, input) => {
    if (method === 'conversations.send') {
      calls.push(input);
      return { status: 'sent', messageId: 'late-route', conversationRef: input.conversationRef };
    }
    return s.rpc(method, input);
  });
  const delivery = s.store.enqueue({
    project: s.project.id,
    event: 'late-route',
    message: 'Deliver later.',
  });
  s.store.move({
    key: 'move',
    id: s.project.id,
    managerRole: 'product',
    route: moved,
    revision: 1,
  });
  await runtime.deliver(delivery);
  assert.equal(calls[0].conversationRef, moved.conversationRef);
  const schedule = s.store.schedule({
    project: s.project.id,
    spec: { scope: 'Scheduled scope.' },
    next: 1000,
    intervalMs: 60000,
    sourceKey: 'schedule-skip-missed',
  });
  s.store.run("UPDATE projects SET state='inactive' WHERE id=?", s.project.id);
  s.store.reactivate(s.project.id, 181001);
  assert(s.store.get('SELECT next FROM schedules WHERE id=?', schedule.id).next > 181001);
});

test('restart reconciliation releases a held terminal communication only after native completion', async () => {
  const s = state();
  const { feature } = await featureFixture(s);
  const card = s.cards.find((candidate) => candidate.id === feature.card.id);
  const proof = { status: 'passed', label: 'Proof', note: 'Verified.' };
  s.store.stageTerminal({
    feature: feature.featureId,
    kind: 'finalize',
    summary: 'Finished.',
    evidence: proof,
  });
  assert.equal(s.store.get('SELECT eligible FROM communication_intents').eligible, 0);
  card.status = 'done';
  card.metadata.automation.summary = 'Finished.';
  card.metadata.proof = [proof];
  const runtime = new ProjectRuntime(s.store, async (method, input) => {
    if (method === 'workboard.cards.list') return s.rpc(method, input);
    if (method === 'tasks.list') return { tasks: [] };
    if (method === 'sessions.list') return { sessions: [], hasMore: false };
    if (method === 'sessions.create') return {};
    if (method === 'agent') return {};
    return s.rpc(method, input);
  });
  runtime.dispatch = async () => {};
  const exchange = s.store.exchange(s.project.id, feature.featureId, 'product');
  await assert.rejects(
    runtime.operation(
      'communication-decision',
      {
        projectId: s.project.id,
        event: `result:${feature.featureId}`,
        notify: true,
        message: 'Too early.',
        reason: 'Attempt early delivery.',
      },
      { agentId: 'main', sessionKey: exchange.session },
    ),
  );
  await runtime.tick();
  assert.equal(s.store.get('SELECT state FROM terminal_checkpoints').state, 'completed');
  assert.equal(s.store.get('SELECT eligible FROM communication_intents').eligible, 1);
  const composed = await runtime.operation(
    'communication-decision',
    {
      projectId: s.project.id,
      event: `result:${feature.featureId}`,
      notify: true,
      message: 'Jarvis-authored result.',
      reason: 'Deliver the terminal result.',
    },
    { agentId: 'main', sessionKey: exchange.session },
  );
  assert.equal(
    s.store.get('SELECT text FROM deliveries WHERE id=?', composed.deliveryId).text,
    'Jarvis-authored result.',
  );
});

test('scanner recovers registry reservations created before any native write and pending scope projection', async () => {
  const s = state();
  const request = s.store.createRequest({
    project: s.project.id,
    source: { messageId: 'prewrite' },
    title: 'Reserved Feature',
    scope: 'Initial scope.',
  });
  const unavailable = async (method, input) => {
    if (method === 'workboard.cards.list')
      return { cards: [], boards: [{ id: input.boardId, total: 0 }] };
    throw new Error('native unavailable before write');
  };
  await assert.rejects(
    createFeatureCard(
      { boardId: 'board', title: request.title, scope: request.scope },
      unavailable,
      { store: s.store, project: s.project.id, request: request.id },
    ),
  );
  const reserved = s.store.get('SELECT * FROM features WHERE request=?', request.id);
  assert(
    reserved &&
      reserved.card === null &&
      JSON.parse(reserved.creation_payload).notes === request.scope,
  );
  const runtime = new ProjectRuntime(s.store, s.rpc);
  const interruptedInventory = await runtime.inventory(s.project.id);
  assert.equal(interruptedInventory.obligations[0].status, 'projection-pending');
  assert.deepEqual(await runtime.reconcileRegistryProjections(s.store.project(s.project.id)), []);
  const feature = s.store.feature(reserved.id);
  assert(feature.card);
  const childUnavailable = async (method, input) => {
    if (method === 'workboard.cards.create')
      throw new Error('child native unavailable before write');
    return s.rpc(method, input);
  };
  await assert.rejects(
    createProductCard(
      'work-item',
      {
        boardId: 'board',
        featureId: feature.id,
        assignment: 'reserved-child',
        title: 'Reserved child',
        scope: 'Create after restart.',
        requires: [],
      },
      childUnavailable,
      { store: s.store, project: s.project.id },
    ),
  );
  const pendingChild = s.store.get(
    "SELECT * FROM obligations WHERE feature=? AND kind='work'",
    feature.id,
  );
  assert(pendingChild && pendingChild.card === null && pendingChild.creation_payload);
  assert.deepEqual(await runtime.reconcileRegistryProjections(s.store.project(s.project.id)), []);
  assert(s.store.obligation(pendingChild.id).card);
  s.store.stageFeatureRevision({
    feature: feature.id,
    expectedRevision: 1,
    scope: 'Recovered revised scope.',
    reason: 'Process ended before projection.',
    source: 'message:revision',
  });
  assert.equal(
    s.store.get(
      'SELECT projected FROM feature_scope_revisions WHERE feature=? AND revision=2',
      feature.id,
    ).projected,
    null,
  );
  assert.deepEqual(await runtime.reconcileRegistryProjections(s.store.project(s.project.id)), []);
  assert.equal(s.cards.find((card) => card.id === feature.card).notes, 'Recovered revised scope.');
  assert(
    s.store.get(
      'SELECT projected FROM feature_scope_revisions WHERE feature=? AND revision=2',
      feature.id,
    ).projected,
  );
});

test('answered decision remains engineering attention when native ownership projection is interrupted', async () => {
  const s = state();
  const { feature } = await featureFixture(s, 'answered');
  const work = await workFixture(s, feature.featureId, 'answered-work');
  await handoffCard(
    'handoff',
    {
      id: work.card.id,
      checkpoint: id(81),
      expectedUpdatedAt: work.card.updatedAt,
      reason: 'Need decision.',
      question: 'Proceed?',
      resolution: 'Proceed safely.',
      decisionBy: 'agent',
    },
    s.rpc,
    { store: s.store, project: s.project.id },
  );
  const projectionDenied = async (method, input) => {
    if (method === 'workboard.cards.update') throw new Error('projection unavailable');
    return s.rpc(method, input);
  };
  await assert.rejects(
    handoffCard(
      'handoff-decision',
      { checkpoint: id(81), decision: 'Proceed.', evidence: 'Product evidence.' },
      projectionDenied,
      { store: s.store, project: s.project.id },
    ),
  );
  assert.equal(s.store.get('SELECT phase FROM decisions WHERE id=?', id(81)).phase, 'answered');
  const dispatched = [];
  const runtime = new ProjectRuntime(s.store, async (method, input) => {
    if (method === 'workboard.cards.update') throw new Error('still unavailable');
    if (method === 'tasks.list') return { tasks: [] };
    if (method === 'sessions.list') return { sessions: [], hasMore: false };
    return s.rpc(method, input);
  });
  runtime.dispatch = async (_project, _feature, role, ids) => dispatched.push({ role, ids });
  await runtime.tick();
  assert(
    dispatched.some(
      (entry) => entry.role === 'engineering' && entry.ids.includes(`decision:${id(81)}`),
    ),
  );
  assert(
    !dispatched.some((entry) => entry.role === 'product' && entry.ids.includes(work.obligationId)),
  );
  await projectAnsweredDecision(s.store, s.project.id, id(81), s.rpc);
  const projected = s.cards.find((card) => card.id === work.card.id);
  assert.equal(projected.agentId, 'gilfoyle');
  assert.equal(projected.status, 'todo');
});

test('decision operations reject cross-project checkpoints and cross-project delivery receipts', async () => {
  const s = state();
  const { feature } = await featureFixture(s, 'scope-one');
  const work = await workFixture(s, feature.featureId, 'scope-work');
  await handoffCard(
    'handoff',
    {
      id: work.card.id,
      checkpoint: id(82),
      expectedUpdatedAt: work.card.updatedAt,
      reason: 'Need answer.',
      question: 'Choose?',
      resolution: 'Choose safely.',
      decisionBy: 'user',
    },
    s.rpc,
    { store: s.store, project: s.project.id },
  );
  const other = s.store.declare({
    key: 'other-project',
    name: 'Other',
    purpose: 'Other project.',
    route,
    productFallback: route,
  });
  await assert.rejects(
    handoffCard('handoff-answer', { checkpoint: id(82), answer: 'Yes.', message: 'm1' }, s.rpc, {
      store: s.store,
      project: other.id,
    }),
    /Project-scoped/,
  );
  const wrong = s.store.enqueue({
    project: other.id,
    event: `question:${id(82)}`,
    kind: 'question',
    message: 'Wrong project.',
  });
  s.store.run("UPDATE deliveries SET status='sent' WHERE id=?", wrong.id);
  await assert.rejects(
    handoffCard(
      'handoff-receipt',
      { checkpoint: id(82), deliveryId: wrong.id, message: 'm1' },
      s.rpc,
      { store: s.store, project: s.project.id },
    ),
    /Project-scoped sent question/,
  );
});

test('manual binding rejects substring markers and accepts only exact line-delimited identity', async () => {
  const s = state();
  const { feature } = await featureFixture(s, 'markers');
  const work = await workFixture(s, feature.featureId, 'marker-work');
  const attempt = s.store.prepareAttempt({
    obligation: work.obligationId,
    sequence: 1,
    profileId: 'deep',
    model: 'openai/gpt-5.6-sol',
    thinking: 'high',
    taskName: 'marker-a1',
    timeoutSeconds: 1800,
    baseSha: sha,
    worktree: '/tmp/work',
    branch: 'work-a1',
  });
  const owner = `agent:gilfoyle:jarvis-gilfoyle:${feature.featureId}`;
  const child = `agent:opencode:acp:${id(85)}`;
  for (const [taskId, runtime] of [
    [id(83), 'acp'],
    [id(84), 'subagent'],
  ])
    s.tasks.set(taskId, {
      taskId,
      runtime,
      agentId: 'opencode',
      ownerKey: owner,
      sessionKey: owner,
      runId: id(86),
      childSessionKey: child,
      status: 'running',
      prompt: `prefix Work item: ${work.card.id} Task name: marker-a1 suffix`,
    });
  const record = {
    boardId: 'board',
    id: work.card.id,
    attemptId: attempt.id,
    taskId: id(83),
    wrapperTaskId: id(84),
    runId: id(86),
    childSessionKey: child,
  };
  await assert.rejects(
    operate('record', record, s.rpc, s.git, undefined, {
      store: s.store,
      project: s.project.id,
      repository,
    }),
    /line-delimited/,
  );
  s.tasks.get(id(84)).prompt = `Work item: ${work.card.id}\nTask name: marker-a1\nDo the work.`;
  assert.equal(
    (
      await operate('record', record, s.rpc, s.git, undefined, {
        store: s.store,
        project: s.project.id,
        repository,
      })
    ).status,
    'delegated',
  );
});

test('automatic binding also requires exact wrapper and backing identities', async () => {
  const s = state();
  const { feature } = await featureFixture(s, 'automatic-binding');
  const work = await workFixture(s, feature.featureId, 'automatic-work');
  s.store.prepareAttempt({
    obligation: work.obligationId,
    sequence: 1,
    profileId: 'deep',
    model: 'openai/gpt-5.6-sol',
    thinking: 'high',
    taskName: 'automatic-a1',
    timeoutSeconds: 1800,
    baseSha: sha,
    worktree: '/tmp/work',
    branch: 'work-a1',
  });
  const owner = `agent:gilfoyle:jarvis-gilfoyle:${feature.featureId}`;
  const child = `agent:opencode:acp:${id(99)}`;
  const backing = {
    taskId: id(97),
    runtime: 'acp',
    agentId: 'opencode',
    ownerKey: owner,
    sessionKey: owner,
    runId: id(100),
    childSessionKey: child,
    status: 'running',
  };
  const wrapper = {
    ...backing,
    taskId: id(98),
    runtime: 'subagent',
    prompt: `contains Work item: ${work.card.id} and Task name: automatic-a1 inline`,
  };
  s.tasks.set(backing.taskId, backing);
  s.tasks.set(wrapper.taskId, wrapper);
  let result = await reconcileExecutionBindings(
    s.store.records(s.project.id),
    s.cards,
    s.store,
    s.rpc,
  );
  assert.equal(result.bound.length, 0);
  wrapper.prompt = `Work item: ${work.card.id}\nTask name: automatic-a1`;
  s.tasks.set(wrapper.taskId, wrapper);
  result = await reconcileExecutionBindings(s.store.records(s.project.id), s.cards, s.store, s.rpc);
  assert.equal(result.bound.length, 1);
  assert.equal(result.bound[0].task_id, backing.taskId);
});

test('attention reads search each retained child session exactly instead of scanning archives globally', async () => {
  const s = state();
  const { feature } = await featureFixture(s, 'session-search');
  const work = await workFixture(s, feature.featureId, 'session-work');
  const attempt = s.store.prepareAttempt({
    obligation: work.obligationId,
    sequence: 1,
    profileId: 'deep',
    model: 'openai/gpt-5.6-sol',
    thinking: 'high',
    taskName: 'session-a1',
    timeoutSeconds: 1800,
    baseSha: sha,
    worktree: '/tmp/work',
    branch: 'work-a1',
  });
  const owner = `agent:gilfoyle:jarvis-gilfoyle:${feature.featureId}`;
  const child = `agent:opencode:acp:${id(95)}`;
  s.store.bindAttempt(attempt.id, {
    task_id: id(93),
    wrapper_task_id: id(94),
    run_id: id(96),
    child_session: child,
  });
  for (const [taskId, runtime] of [
    [id(93), 'acp'],
    [id(94), 'subagent'],
  ])
    s.tasks.set(taskId, {
      taskId,
      runtime,
      agentId: 'opencode',
      ownerKey: owner,
      sessionKey: owner,
      runId: id(96),
      childSessionKey: child,
      status: 'running',
      startedAt: 1,
      updatedAt: 2,
    });
  s.sessions.push({ key: child, hasActiveRun: true, hasActiveSubagentRun: true });
  const searches = [];
  const rpc = async (method, input) => {
    if (method === 'sessions.list') searches.push(input);
    return s.rpc(method, input);
  };
  const page = await readView(
    { agentId: 'gilfoyle', boardId: 'board', includeArchived: false, view: 'delegated' },
    rpc,
    s.store.records(s.project.id),
  );
  assert.equal(page.total, 1);
  assert.deepEqual(searches, [{ agentId: 'opencode', search: child, limit: 10, archived: 'all' }]);
});

test('unchanged exhausted engineering attention creates exactly one retained blocker intent', async () => {
  const s = state();
  const runtime = new ProjectRuntime(
    s.store,
    async () => {
      throw new Error('dispatch should not run');
    },
    { now: () => 1_000_000 },
  );
  const scope = id(87);
  const exchange = s.store.exchange(s.project.id, scope, 'engineering');
  s.store.run(
    'UPDATE exchanges SET attempts=3,lastDispatch=0,observed=? WHERE id=?',
    'attention-v1',
    exchange.id,
  );
  await runtime.dispatch(s.store.project(s.project.id), scope, 'engineering', ['work']);
  await runtime.dispatch(s.store.project(s.project.id), scope, 'engineering', ['work']);
  const intents = s.store.all("SELECT * FROM communication_intents WHERE kind='blocker'");
  assert.equal(intents.length, 1);
  assert.equal(JSON.parse(intents[0].facts).attentionVersion, 'attention-v1');
  assert.equal(intents[0].status, 'pending');
});

test('inactivation requires complete explicit dispositions and preserves pending work inactive', async () => {
  const s = state();
  const { feature } = await featureFixture(s, 'inactive-pending');
  await workFixture(s, feature.featureId, 'pending-work');
  const delivery = s.store.enqueue({
    project: s.project.id,
    event: 'pending-delivery',
    message: 'Pending delivery.',
  });
  const intent = s.store.requestCommunication({
    project: s.project.id,
    event: 'pending-intent',
    scope: feature.featureId,
    kind: 'milestone',
    facts: { condition: 'pending' },
  });
  const control = s.store.control({
    project: s.project.id,
    feature: feature.featureId,
    reason: 'Pending owner stop.',
  });
  const schedule = s.store.schedule({
    project: s.project.id,
    spec: { scope: 'Pending schedule.' },
    next: Date.now() + 60000,
    sourceKey: 'schedule-inactivation-pending',
  });
  const runtime = new ProjectRuntime(s.store, s.rpc);
  runtime.requestTick = () => {};
  const inventory = await runtime.inventory(s.project.id);
  await assert.rejects(
    runtime.operation(
      'inactivate',
      {
        projectId: s.project.id,
        confirmed: true,
        revision: inventory.revision,
        dispositions: {},
      },
      { agentId: 'main', operator: true },
    ),
    /Every unfinished/,
  );
  const dispositions = Object.fromEntries(
    [
      ...inventory.obligations,
      ...inventory.notifications,
      ...inventory.communicationIntents,
      ...inventory.controls,
      ...inventory.schedules,
    ].map((item) => [item.id, 'pending']),
  );
  const result = await runtime.operation(
    'inactivate',
    { projectId: s.project.id, confirmed: true, revision: inventory.revision, dispositions },
    { agentId: 'main', operator: true },
  );
  assert.equal(result.state, 'inactive');
  assert.equal(
    s.store.all('SELECT * FROM inactivation_plans').length,
    Object.keys(dispositions).length,
  );
  assert(s.store.all('SELECT * FROM obligations WHERE card IS NOT NULL').length > 0);
  assert.equal(
    s.store.get('SELECT status FROM deliveries WHERE id=?', delivery.id).status,
    'pending',
  );
  assert.equal(
    s.store.get('SELECT status FROM communication_intents WHERE id=?', intent.id).status,
    'pending',
  );
  assert.equal(
    s.store.get('SELECT state FROM control_intents WHERE id=?', control.id).state,
    'pending',
  );
  assert.equal(s.store.get('SELECT enabled FROM schedules WHERE id=?', schedule.id).enabled, 1);
});

test('finish and stop dispositions drain until their exact obligations settle', async () => {
  const s = state();
  const { feature } = await featureFixture(s, 'draining');
  const work = await workFixture(s, feature.featureId, 'finish-work');
  const runtime = new ProjectRuntime(s.store, s.rpc);
  runtime.requestTick = () => {};
  const inventory = await runtime.inventory(s.project.id);
  const dispositions = Object.fromEntries(
    [
      ...inventory.obligations,
      ...inventory.notifications,
      ...inventory.communicationIntents,
      ...inventory.controls,
      ...inventory.schedules,
    ].map((item) => [item.id, item.recordId === work.obligationId ? 'finish' : 'pending']),
  );
  assert.equal(
    (
      await runtime.operation(
        'inactivate',
        { projectId: s.project.id, confirmed: true, revision: 1, dispositions },
        { agentId: 'main', operator: true },
      )
    ).state,
    'draining',
  );
  const card = s.cards.find((candidate) => candidate.id === work.card.id);
  card.status = 'done';
  assert.equal(await runtime.inactivationReady(s.store.project(s.project.id), s.cards), true);

  const t = state();
  const stoppedFeature = await featureFixture(t, 'stopping');
  const stoppedWork = await workFixture(t, stoppedFeature.feature.featureId, 'stop-work');
  const stopRuntime = new ProjectRuntime(t.store, t.rpc);
  stopRuntime.requestTick = () => {};
  const stopInventory = await stopRuntime.inventory(t.project.id);
  const stopDispositions = Object.fromEntries(
    [
      ...stopInventory.obligations,
      ...stopInventory.notifications,
      ...stopInventory.communicationIntents,
      ...stopInventory.controls,
      ...stopInventory.schedules,
    ].map((item) => [item.id, item.recordId === stoppedWork.obligationId ? 'stop' : 'pending']),
  );
  assert.equal(
    (
      await stopRuntime.operation(
        'inactivate',
        { projectId: t.project.id, confirmed: true, revision: 1, dispositions: stopDispositions },
        { agentId: 'main', operator: true },
      )
    ).state,
    'draining',
  );
  const control = t.store.pendingStop(stoppedFeature.feature.featureId);
  assert(control);
  t.store.settleControl(control.id);
  assert.equal(await stopRuntime.inactivationReady(t.store.project(t.project.id), t.cards), true);
});

test('merged publication checkpoint recovers terminal completion and repeated finish is idempotent', async () => {
  const s = state();
  const { feature } = await featureFixture(s, 'merged-retry');
  const review = await createProductCard(
    'review',
    {
      boardId: 'board',
      featureId: feature.featureId,
      reviewKey: 'merged-review',
      candidate: sha,
      title: 'Review',
      scope: 'Review merged candidate.',
      requires: [],
    },
    s.rpc,
    { store: s.store, project: s.project.id },
  );
  const reviewCard = s.cards.find((card) => card.id === review.card.id);
  reviewCard.status = 'done';
  reviewCard.metadata.proof = [{ status: 'passed', note: 'Passed.' }];
  const attempt = s.store.prepareAttempt({
    obligation: review.obligationId,
    sequence: 1,
    profileId: 'deep',
    model: 'openai/gpt-5.6-sol',
    thinking: 'high',
    taskName: 'merged-review-a1',
    timeoutSeconds: 1800,
    baseSha: sha,
    worktree: '/tmp/review',
    branch: 'review-a1',
  });
  const owner = `agent:gilfoyle:jarvis-gilfoyle:${feature.featureId}`;
  const child = `agent:opencode:acp:${id(105)}`;
  s.store.bindAttempt(attempt.id, {
    task_id: id(103),
    wrapper_task_id: id(104),
    run_id: id(106),
    child_session: child,
  });
  for (const [taskId, runtime] of [
    [id(103), 'acp'],
    [id(104), 'subagent'],
  ])
    s.tasks.set(taskId, {
      taskId,
      runtime,
      agentId: 'opencode',
      ownerKey: owner,
      sessionKey: owner,
      runId: id(106),
      childSessionKey: child,
      status: 'completed',
    });
  s.sessions.push({ key: child, hasActiveRun: false, hasActiveSubagentRun: false });
  const gate = { remoteBefore: sha, summary: 'Published.' };
  s.store.publication({
    feature: feature.featureId,
    candidate: sha,
    reviewObligation: review.obligationId,
    backend: 'git',
    state: 'passed',
    details: gate,
  });
  s.store.publication({
    feature: feature.featureId,
    candidate: sha,
    reviewObligation: review.obligationId,
    backend: 'git',
    state: 'merged',
    details: { gate, merge: { remoteSha: sha }, summary: 'Published.' },
  });
  assert(requireFinishPublication(s.store, feature.featureId, review.obligationId, sha, 'git'));
  assert.equal(
    classifyCards(s.cards, s.store.records(s.project.id)).get(feature.card.id).stage,
    'publication-completion',
  );
  const featureCard = s.cards.find((card) => card.id === feature.card.id);
  featureCard.status = 'running';
  featureCard.metadata.claim = { ownerId: 'gilfoyle', expiresAt: Date.now() + 60000 };
  const input = {
    boardId: 'board',
    id: feature.card.id,
    sha,
    reviewId: review.obligationId,
    summary: 'Published.',
  };
  const registry = { store: s.store, project: s.project.id, repository };
  assert.equal(
    (await operate('finish', input, s.rpc, s.git, undefined, registry)).status,
    'finished',
  );
  assert.equal(
    (await operate('finish', input, s.rpc, s.git, undefined, registry)).status,
    'finished',
  );
  assert.equal(s.store.get('SELECT state FROM terminal_checkpoints').state, 'completed');
});

test('registered done Feature without completed checkpoint is actionable terminal uncertainty', async () => {
  const s = state();
  const { feature } = await featureFixture(s, 'done-uncertain');
  const card = s.cards.find((item) => item.id === feature.card.id);
  card.status = 'done';
  card.metadata.automation.summary = 'Direct completion.';
  card.metadata.proof = [{ status: 'passed', label: 'Proof', note: 'Direct.' }];
  let records = s.store.records(s.project.id);
  assert.equal(classifyCards(s.cards, records).get(card.id).stage, 'terminal-uncertain');
  s.store.stageTerminal({
    feature: feature.featureId,
    kind: 'finalize',
    summary: 'Direct completion.',
    evidence: card.metadata.proof[0],
  });
  records = s.store.records(s.project.id);
  assert.equal(classifyCards(s.cards, records).get(card.id).stage, 'terminal-reconciliation');
  s.store.completeTerminal(feature.featureId);
  records = s.store.records(s.project.id);
  assert.equal(classifyCards(s.cards, records).get(card.id).stage, 'settled');
  assert.equal(isCompletionMutation({ toolName: 'workboard_complete', params: {} }), true);
  assert.equal(
    isCompletionMutation({ toolName: 'workboard_move', params: { status: 'done' } }),
    true,
  );
  assert.equal(
    isCompletionMutation({ toolName: 'workboard_release', params: { status: 'done' } }),
    true,
  );
  assert.equal(
    isCompletionMutation({ toolName: 'workboard_move', params: { status: 'review' } }),
    false,
  );
});

test('engineering and product Feature contexts cannot mutate sibling Features', async () => {
  const s = state();
  const first = await featureFixture(s, 'scope-a');
  const second = await featureFixture(s, 'scope-b');
  const work = await workFixture(s, second.feature.featureId, 'scope-b-work');
  const exchange = s.store.exchange(s.project.id, first.feature.featureId, 'engineering');
  assert.throws(
    () =>
      assertEngineeringMutationScope(s.store, exchange, s.project.id, 'prepare', {
        id: work.card.id,
      }),
    /another Feature/,
  );
  const runtime = new ProjectRuntime(s.store, s.rpc);
  await assert.rejects(
    runtime.operation(
      'priority',
      { projectId: s.project.id, priority: 10 },
      { agentId: 'gilfoyle', operator: true },
    ),
    /product agent/,
  );
  const productExchange = s.store.exchange(s.project.id, first.feature.featureId, 'product');
  await assert.rejects(
    runtime.operation(
      'notify',
      {
        projectId: s.project.id,
        featureId: second.feature.featureId,
        event: 'scope-test',
        message: 'Wrong scope.',
      },
      { agentId: 'main', sessionKey: productExchange.session },
    ),
    /another Feature/,
  );
  await assert.rejects(
    runtime.operation(
      'context',
      { projectId: s.project.id, context: 'Global change.', revision: 1 },
      { agentId: 'main', sessionKey: productExchange.session },
    ),
    /Project-wide operation/,
  );
});

test('schedules validate associated boards, replay by source identity, and isolate due failures', async () => {
  const s = state();
  const runtime = new ProjectRuntime(s.store, s.rpc, { now: () => 1000 });
  const source = { route, messageId: 'schedule-message' };
  await assert.rejects(
    runtime.operation(
      'schedule',
      {
        projectId: s.project.id,
        authorized: true,
        title: 'Invalid',
        scope: 'Invalid boards.',
        boards: [],
        next: 2000,
        source,
      },
      { agentId: 'main', operator: true },
    ),
    /Schedule boards/,
  );
  const input = {
    projectId: s.project.id,
    authorized: true,
    title: 'Scheduled',
    scope: 'Run once.',
    boards: ['board'],
    next: 2000,
    source,
  };
  const first = await runtime.operation('schedule', input, { agentId: 'main', operator: true });
  const retry = await runtime.operation('schedule', input, { agentId: 'main', operator: true });
  assert.equal(retry.id, first.id);
  assert.equal(s.store.all('SELECT * FROM schedules').length, 1);
  await assert.rejects(
    runtime.operation(
      'schedule',
      { ...input, scope: 'Conflicting retry.' },
      { agentId: 'main', operator: true },
    ),
    /specification changed/,
  );
  const malformed = s.store.schedule({
    project: s.project.id,
    spec: { title: 'Bad', scope: 'Bad.', boards: ['board'] },
    next: 500,
    sourceKey: 'malformed-schedule',
  });
  s.store.run('UPDATE schedules SET spec=? WHERE id=?', '{bad', malformed.id);
  s.store.schedule({
    project: s.project.id,
    spec: { title: 'Good', scope: 'Good.', boards: ['board'] },
    next: 500,
    sourceKey: 'good-schedule',
  });
  await runtime.runSchedules(s.store.project(s.project.id));
  assert.equal(s.store.all("SELECT * FROM communication_intents WHERE kind='blocker'").length, 1);
  assert.equal(
    s.store.get("SELECT enabled FROM schedules WHERE source_key='good-schedule'").enabled,
    0,
  );
  assert.equal(s.store.get('SELECT enabled FROM schedules WHERE id=?', malformed.id).enabled, 1);
  assert(s.store.all('SELECT * FROM requests').length >= 1);
});

test('worker capacity ignores unrelated agents and non-ACP Gateway tasks', () => {
  const evidence = {
    available: true,
    capacityTasks: [
      { taskId: id(110), agentId: 'opencode', runtime: 'acp', status: 'running', runId: id(111) },
      { taskId: id(112), agentId: 'other', runtime: 'acp', status: 'running', runId: id(113) },
      {
        taskId: id(114),
        agentId: 'opencode',
        runtime: 'subagent',
        status: 'running',
        runId: id(115),
      },
      { taskId: id(116), agentId: 'opencode', runtime: 'acp', status: 'completed', runId: id(117) },
    ],
  };
  assert.deepEqual(workerCapacity(evidence), { limit: 2, occupied: 1, complete: true });
});

test('amendment atomically invalidates staged terminal checkpoint and held result intent', async () => {
  const s = state();
  const { feature } = await featureFixture(s, 'amend-terminal');
  const proof = { status: 'passed', label: 'Proof', note: 'Staged.' };
  s.store.stageTerminal({
    feature: feature.featureId,
    kind: 'finalize',
    summary: 'Staged result.',
    evidence: proof,
  });
  assert(s.store.get('SELECT * FROM terminal_checkpoints'));
  await amendFeature(
    {
      boardId: 'board',
      featureId: feature.featureId,
      expectedRevision: 1,
      expectedUpdatedAt: feature.card.updatedAt,
      scope: 'Amended after staged result.',
      reason: 'Scope changed.',
      source: 'message:amend-terminal',
    },
    s.rpc,
    { store: s.store, project: s.project.id },
  );
  assert.equal(s.store.all('SELECT * FROM terminal_checkpoints').length, 0);
  assert.equal(
    s.store.all("SELECT * FROM communication_intents WHERE event LIKE 'result:%'").length,
    0,
  );
});

test('cleanup uses matching Scope marker and closes only after confirmed cleanup', async () => {
  const s = state();
  const { feature } = await featureFixture(s, 'cleanup');
  const card = s.cards.find((item) => item.id === feature.card.id);
  card.status = 'done';
  const exchange = s.store.exchange(s.project.id, feature.featureId, 'engineering');
  s.store.run('UPDATE exchanges SET conclusion=? WHERE id=?', 'Concluded.', exchange.id);
  let confirmed = false;
  const runtime = new ProjectRuntime(s.store, async (method, input) => {
    if (method === 'sessions.list')
      return {
        sessions: [
          {
            key: exchange.session,
            sessionId: id(120),
            hasActiveRun: false,
            hasActiveSubagentRun: false,
          },
        ],
        hasMore: false,
      };
    if (method === 'jarvis-gilfoyle.session.cleanup')
      return confirmed ? { archivedTranscriptArtifacts: 0, exportedPaths: [] } : {};
    return s.rpc(method, input);
  });
  await assert.rejects(runtime.cleanup(s.store.project(s.project.id), s.cards), /not confirmed/);
  assert.equal(s.store.get('SELECT closed FROM exchanges WHERE id=?', exchange.id).closed, null);
  confirmed = true;
  await runtime.cleanup(s.store.project(s.project.id), s.cards);
  assert(s.store.get('SELECT closed FROM exchanges WHERE id=?', exchange.id).closed);
  const sent = [];
  const dispatchRuntime = new ProjectRuntime(
    s.store,
    async (method, input) => {
      if (method === 'sessions.list') return { sessions: [], hasMore: false };
      if (method === 'sessions.create') return {};
      if (method === 'agent') {
        sent.push(input.message);
        return {};
      }
      throw new Error(method);
    },
    { now: () => 1_000_000 },
  );
  const open = s.store.exchange(s.project.id, feature.featureId, 'engineering');
  await dispatchRuntime.dispatch(
    s.store.project(s.project.id),
    feature.featureId,
    'engineering',
    [],
  );
  assert(sent[0].includes(`Scope: ${feature.featureId}`));
  assert(!sent[0].includes(`Feature: ${feature.featureId}`));
  s.store.run('UPDATE exchanges SET closed=? WHERE id=?', 1, open.id);
});

test('fallback delivery rediscovers destination on every retry without changing preferred route', async () => {
  const s = state();
  let now = 1000;
  let discovery = 0;
  const first = { ...route, conversationRef: `conv_${'d'.repeat(32)}`, target: 'telegram:2' };
  const second = { ...route, conversationRef: `conv_${'e'.repeat(32)}`, target: 'telegram:2' };
  const sends = [];
  const runtime = new ProjectRuntime(
    s.store,
    async (method, input) => {
      if (method === 'conversations.list')
        return { conversations: [++discovery === 1 ? first : second] };
      if (method === 'conversations.send') {
        sends.push(input.conversationRef);
        if (sends.length === 1) throw new Error('first fallback failed');
        return { status: 'sent', messageId: 'fallback-ok', conversationRef: input.conversationRef };
      }
      return s.rpc(method, input);
    },
    {
      now: () => now,
      fallbackDestinations: {
        product: {
          channel: 'telegram',
          accountId: 'default',
          to: 'telegram:2',
          kind: 'direct',
        },
      },
    },
  );
  const delivery = s.store.enqueue({
    project: s.project.id,
    event: 'fallback:test',
    kind: 'fallback',
    message: 'Fallback.',
    route: first,
  });
  await runtime.deliver(delivery);
  now += 60001;
  await runtime.deliver(s.store.get('SELECT * FROM deliveries WHERE id=?', delivery.id));
  assert.deepEqual(sends, [first.conversationRef, second.conversationRef]);
  assert.equal(
    s.store.project(s.project.id).productConversation.conversationRef,
    route.conversationRef,
  );
});
