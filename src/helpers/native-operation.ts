import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import {
  githubEvidence,
  githubPassedGateEvidence,
  githubStopEvidence,
  hostedSpec,
} from './github-evidence.js';
import { pageCards, controllerKey } from './workboard-page.js';
import { terminalHandoff } from './terminal-handoff.js';
import { topology, workerProfile } from '../topology.js';
import { assertChildSession, assertTaskIdentity } from './record-contracts.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const terminal = new Set(['completed', 'succeeded', 'failed', 'lost', 'timed_out', 'cancelled']);

async function boardState(boardId, rpc) {
  const response = await rpc('workboard.cards.list', { boardId });
  pageCards(response, { boardId, includeArchived: true });
  return response.cards;
}

function inspectWorktree(repository, input, git) {
  assert(repository?.readiness === 'ready', 'Repository is not ready');
  assert(SHA.test(input.baseSha) && isAbsolute(input.worktree));
  assert.notEqual(input.worktree, repository.checkout, 'Worker worktree must differ from checkout');
  assert.notEqual(
    input.branch,
    repository.integrationBranch,
    'Worker branch must differ from integration',
  );
  const entries = git(repository.checkout, ['worktree', 'list', '--porcelain']).split('\n\n');
  assert.equal(
    entries.filter((entry) => entry.split('\n').includes(`worktree ${input.worktree}`)).length,
    1,
  );
  assert.equal(
    entries.filter((entry) => entry.split('\n').includes(`branch refs/heads/${input.branch}`))
      .length,
    1,
  );
  assert.equal(git(input.worktree, ['rev-parse', '--show-toplevel']), input.worktree);
  assert.equal(git(input.worktree, ['symbolic-ref', '--short', 'HEAD']), input.branch);
  assert.equal(git(input.worktree, ['rev-parse', 'HEAD']), input.baseSha);
  assert.equal(git(input.worktree, ['status', '--porcelain', '--untracked-files=all']), '');
}

function spawnArguments(card, attempt, review, candidate, scope) {
  const task = `Work item: ${card.id}\nTask name: ${attempt.task_name}\n${review ? `Assignment: independent review\nCandidate: ${candidate}\nScope: ${scope}\nRead-only review: do not edit, publish, merge, or message users.\n` : ''}${attempt.remaining ? `Remaining assignment: ${attempt.remaining}\n` : ''}`;
  return {
    profile: {
      id: attempt.profile_id,
      model: attempt.model,
      thinking: attempt.thinking,
    },
    taskPrefix: task,
    spawnArgs: {
      runtime: topology().workerRuntime,
      agentId: topology().workerAgentId,
      mode: 'run',
      cwd: attempt.worktree,
      taskName: attempt.task_name,
      model: attempt.model,
      thinking: attempt.thinking,
      runTimeoutSeconds: attempt.timeout_seconds,
      cleanup: 'keep',
      expectsCompletionMessage: true,
      ...(review ? { task } : {}),
    },
  };
}

async function validateBinding(store, obligation, attempt, refs, cards, rpc) {
  const { workerAgentId, workerRuntime } = topology();
  assert(UUID.test(refs.runId) && UUID.test(refs.taskId) && UUID.test(refs.wrapperTaskId));
  assert(refs.taskId !== refs.wrapperTaskId && typeof refs.childSessionKey === 'string');
  assertChildSession(refs.childSessionKey);
  const card = cards.find((candidate) => candidate.id === obligation.card);
  assert(card, 'Registered Workboard obligation missing');
  const records = store.records(store.feature(obligation.feature).project);
  const owner = controllerKey(records, card);
  const tasks = await Promise.all(
    [refs.taskId, refs.wrapperTaskId].map(
      async (taskId) => (await rpc('tasks.get', { taskId })).task,
    ),
  );
  for (const [task, runtime, taskId] of [
    [tasks[0], workerRuntime, refs.taskId],
    [tasks[1], 'subagent', refs.wrapperTaskId],
  ])
    assert(
      task?.taskId === taskId &&
        task.runtime === runtime &&
        task.agentId === workerAgentId &&
        task.runId === refs.runId &&
        task.childSessionKey === refs.childSessionKey &&
        task.ownerKey === owner &&
        task.sessionKey === owner,
      'Native execution task identity required',
    );
  assertTaskIdentity(tasks[1].prompt, card.id, attempt.task_name);
}

async function assertAttemptSettled(attempt, obligation, rpc) {
  assert(attempt?.bound, 'Bound prior attempt required');
  assertChildSession(attempt.child_session);
  const owner = `agent:${topology().engineeringAgentId}:${topology().sessionNamespace}:${obligation.feature}`;
  for (const [taskId, runtime] of [
    [attempt.task_id, topology().workerRuntime],
    [attempt.wrapper_task_id, 'subagent'],
  ]) {
    const task = (await rpc('tasks.get', { taskId })).task;
    assert(
      task?.taskId === taskId &&
        task.runtime === runtime &&
        task.agentId === topology().workerAgentId &&
        task.ownerKey === owner &&
        task.sessionKey === owner &&
        task.runId === attempt.run_id &&
        task.childSessionKey === attempt.child_session &&
        terminal.has(task.status),
      'Prior replacement attempt must be terminal',
    );
  }
  const sessions = await rpc('sessions.list', {
    agentId: topology().workerAgentId,
    search: attempt.child_session,
    archived: 'all',
    limit: 10,
  });
  assert(
    !sessions.hasMore &&
      sessions.sessions.filter((session) => session.key === attempt.child_session).length === 1 &&
      sessions.sessions.find((session) => session.key === attempt.child_session).hasActiveRun ===
        false &&
      sessions.sessions.find((session) => session.key === attempt.child_session)
        .hasActiveSubagentRun !== true,
    'Prior replacement session must be inactive',
  );
}

export function requirePassedPublication(
  store,
  feature,
  review,
  candidate,
  backend,
  hosted = null,
) {
  const retained = store.get('SELECT * FROM publication_checkpoints WHERE feature=?', feature);
  assert(
    retained?.state === 'passed' &&
      retained.backend === backend &&
      retained.candidate === candidate &&
      retained.review_obligation === review,
    `Exact passed ${backend} gate required before finish`,
  );
  const details = JSON.parse(retained.details);
  if (backend === 'github') {
    assert.deepEqual(details.hosted, hosted, 'Hosted finish identity differs from passed gate');
    assert.equal(details.result?.status, 'merge-ready', 'Passed CI identity required');
    assert(Array.isArray(details.result.runs) && details.result.runs.length > 0);
  }
  return { retained, details };
}

export function requireFinishPublication(
  store,
  feature,
  review,
  candidate,
  backend,
  hosted = null,
) {
  const retained = store.get('SELECT * FROM publication_checkpoints WHERE feature=?', feature);
  assert(
    ['passed', 'merged'].includes(retained?.state) &&
      retained.backend === backend &&
      retained.candidate === candidate &&
      retained.review_obligation === review,
    `Exact passed or merged ${backend} checkpoint required before finish`,
  );
  const details = JSON.parse(retained.details);
  const gate = retained.state === 'merged' ? details.gate : details;
  if (backend === 'github') {
    assert.deepEqual(gate.hosted, hosted, 'Hosted finish identity differs from gate');
    assert.equal(gate.result?.status, 'merge-ready', 'Passed CI identity required');
    assert(Array.isArray(gate.result.runs) && gate.result.runs.length > 0);
  }
  return { retained, details, gate };
}

export async function validateSelectedReview(store, feature, review, candidate, cards, rpc) {
  assert(
    review.feature === feature.id && review.kind === 'review' && review.required === 1,
    'Required registered review required',
  );
  assert.equal(review.candidate, candidate, 'Publication candidate differs from review');
  const card = cards.find((item) => item.id === review.card);
  assert(
    card?.status === 'done' && card.metadata?.proof?.some((proof) => proof.status === 'passed'),
    'Selected review must be done with passed proof',
  );
  const attempt = store.get(
    'SELECT * FROM attempts WHERE obligation=? ORDER BY sequence DESC LIMIT 1',
    review.id,
  );
  assert(attempt?.base_sha === candidate, 'Selected review execution candidate mismatch');
  await assertAttemptSettled(attempt, review, rpc);
  return attempt;
}

export async function operate(
  operation,
  input,
  rpc,
  git = (cwd, args) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000 }).trim(),
  githubRequest,
  registry,
) {
  assert(registry?.store && registry.project && registry.repository, 'Registry context required');
  const { store, project, repository } = registry;
  assert(
    ['prepare', 'record', 'publish-gate', 'gate', 'finish', 'settle-control'].includes(operation),
  );
  const cards = await boardState(input.boardId, rpc);
  if (operation === 'settle-control') {
    const control = store.get(
      "SELECT * FROM control_intents WHERE id=? AND project=? AND state='pending'",
      input.controlId,
      project,
    );
    assert(control?.kind === 'stop', 'Pending stop control required');
    const records = store.records(project);
    for (const attempt of records.attempts.filter((attempt) => {
      const obligation = records.obligations.find((row) => row.id === attempt.obligation);
      return obligation?.feature === control.feature;
    })) {
      assert(attempt.bound, 'Prepared attempt must bind before stop settlement');
      const obligation = records.obligations.find((row) => row.id === attempt.obligation);
      await assertAttemptSettled(attempt, obligation, rpc);
    }
    const publication = records.publications.find((row) => row.feature === control.feature);
    let effect = null;
    if (
      publication?.backend === 'github' &&
      ['candidate', 'waiting', 'passed'].includes(publication.state)
    ) {
      const details = JSON.parse(publication.details);
      if (details.hosted?.prNumber)
        effect = await githubStopEvidence(details.hosted, publication.candidate, githubRequest);
      else
        assert.equal(
          publication.state,
          'candidate',
          'Hosted publication effect identity unresolved',
        );
    }
    return { control: store.settleControl(control.id), effect };
  }
  if (operation === 'prepare' || operation === 'record') {
    const obligation = store.obligation(input.obligationId ?? input.id);
    const feature = store.feature(obligation.feature);
    assert(
      feature.project === project && feature.board === input.boardId,
      'Obligation belongs to another project',
    );
    assert(['work', 'review'].includes(obligation.kind), 'Executable obligation required');
    const card = cards.find((candidate) => candidate.id === obligation.card);
    assert(
      card && !card.metadata?.archivedAt && card.status !== 'done',
      'Open registered obligation required',
    );
    if (operation === 'prepare') {
      assert(!store.pendingStop(feature.id), 'Pending stop control blocks preparation');
      assert(Number.isInteger(input.attempt) && input.attempt > 0 && input.attempt <= 999999);
      assert(/^[a-z][a-z0-9_-]{0,63}$/.test(input.taskName));
      assert(
        Number.isInteger(input.timeoutSeconds) &&
          input.timeoutSeconds >= 1 &&
          input.timeoutSeconds <= 1800,
      );
      if (obligation.kind === 'review') {
        if (input.candidate !== undefined)
          assert.equal(input.candidate, obligation.candidate, 'Review candidate changed');
        assert.equal(input.baseSha, obligation.candidate, 'Review worktree must use candidate');
      }
      inspectWorktree(repository, input, git);
      const profile = workerProfile(input.profileId);
      const existing = store.get(
        'SELECT * FROM attempts WHERE obligation=? AND sequence=?',
        obligation.id,
        input.attempt,
      );
      if (existing) {
        const retained = store.prepareAttempt({
          obligation: obligation.id,
          sequence: input.attempt,
          profileId: profile.id,
          model: profile.model,
          thinking: profile.thinking,
          taskName: input.taskName,
          timeoutSeconds: input.timeoutSeconds,
          baseSha: input.baseSha,
          worktree: input.worktree,
          branch: input.branch,
          replaces: input.replaces,
          remaining: input.remaining,
          reconciliation: input.reconciliation,
        });
        return {
          id: card.id,
          obligationId: obligation.id,
          attemptId: retained.id,
          status: 'prepared',
          reused: true,
          executionAccepted: Boolean(retained.bound),
          ...spawnArguments(
            card,
            retained,
            obligation.kind === 'review',
            obligation.candidate,
            card.notes,
          ),
        };
      }
      const previous = store.get(
        'SELECT * FROM attempts WHERE obligation=? ORDER BY sequence DESC LIMIT 1',
        obligation.id,
      );
      if (input.attempt > 1) {
        assert(
          previous?.bound && previous.sequence === input.attempt - 1,
          'Bound prior attempt required',
        );
        assert.equal(input.replaces, previous.id, 'Exact replacement identity required');
        assert(typeof input.remaining === 'string' && input.remaining.trim());
        assert(typeof input.reconciliation === 'string' && input.reconciliation.trim());
        await assertAttemptSettled(previous, obligation, rpc);
      } else assert(!previous, 'Attempt sequence already started');
      const attempt = store.prepareAttempt({
        obligation: obligation.id,
        sequence: input.attempt,
        profileId: profile.id,
        model: profile.model,
        thinking: profile.thinking,
        taskName: input.taskName,
        timeoutSeconds: input.timeoutSeconds,
        baseSha: input.baseSha,
        worktree: input.worktree,
        branch: input.branch,
        replaces: input.replaces,
        remaining: input.remaining,
        reconciliation: input.reconciliation,
      });
      return {
        id: card.id,
        obligationId: obligation.id,
        attemptId: attempt.id,
        status: 'prepared',
        executionAccepted: false,
        ...spawnArguments(
          card,
          attempt,
          obligation.kind === 'review',
          obligation.candidate,
          card.notes,
        ),
      };
    }
    const attempt = store.get(
      'SELECT * FROM attempts WHERE id=? AND obligation=?',
      input.attemptId,
      obligation.id,
    );
    assert(attempt, 'Prepared attempt required');
    const refs = {
      taskId: input.taskId,
      wrapperTaskId: input.wrapperTaskId,
      runId: input.runId,
      childSessionKey: input.childSessionKey,
    };
    await validateBinding(store, obligation, attempt, refs, cards, rpc);
    const bound = store.bindAttempt(attempt.id, {
      task_id: refs.taskId,
      wrapper_task_id: refs.wrapperTaskId,
      run_id: refs.runId,
      child_session: refs.childSessionKey,
    });
    if (card.metadata?.claim?.ownerId === topology().engineeringAgentId)
      await rpc('workboard.cards.release', {
        id: card.id,
        ownerId: topology().engineeringAgentId,
        status: 'todo',
      });
    return {
      id: card.id,
      obligationId: obligation.id,
      attemptId: bound.id,
      status: 'delegated',
      ...refs,
      executionAuthorized: false,
    };
  }

  const feature = store.feature(input.featureId ?? input.id);
  assert(
    feature.project === project && feature.board === input.boardId,
    'Feature belongs to another project',
  );
  const featureCard = cards.find((card) => card.id === feature.card);
  assert(featureCard && SHA.test(input.sha), 'Registered Feature and immutable candidate required');
  assert(!store.pendingStop(feature.id), 'Pending stop control blocks publication');
  const review = store.obligation(input.reviewId);
  await validateSelectedReview(store, feature, review, input.sha, cards, rpc);
  const obligations = store
    .records(project)
    .obligations.filter(
      (row) => row.feature === feature.id && row.kind !== 'feature' && row.required,
    );
  assert(obligations.length > 0, 'At least one required obligation is required');
  for (const obligation of obligations) {
    const card = cards.find((candidate) => candidate.id === obligation.card);
    assert(
      card?.status === 'done' && card.metadata?.proof?.some((proof) => proof.status === 'passed'),
      'Required obligation unfinished or unproved',
    );
    const attempt = store.get(
      'SELECT * FROM attempts WHERE obligation=? ORDER BY sequence DESC LIMIT 1',
      obligation.id,
    );
    if (['work', 'review'].includes(obligation.kind)) {
      assert(attempt?.bound, 'Required execution binding missing');
      await assertAttemptSettled(attempt, obligation, rpc);
    }
  }
  assert.equal(
    git(repository.checkout, ['status', '--porcelain']),
    '',
    'Dirty publication checkout',
  );
  assert.equal(
    git(repository.checkout, ['remote', 'get-url', '--all', 'origin']),
    repository.repository,
  );
  const hosted = input.hosted
    ? hostedSpec(
        repository.repository,
        repository.integrationBranch,
        repository.requiredCI,
        input.hosted,
        operation,
      )
    : null;
  if (hosted) {
    let finishCheckpoint;
    if (operation === 'finish') {
      finishCheckpoint = requireFinishPublication(
        store,
        feature.id,
        review.id,
        input.sha,
        'github',
        hosted,
      );
      await githubPassedGateEvidence(
        hosted,
        input.sha,
        finishCheckpoint.gate.result.runs,
        githubRequest,
      );
    }
    const result = await githubEvidence(hosted, input.sha, operation, githubRequest);
    const state =
      operation === 'publish-gate'
        ? 'candidate'
        : operation === 'gate' && result.status === 'ci-wait'
          ? 'waiting'
          : operation === 'gate'
            ? 'passed'
            : 'merged';
    const details =
      operation === 'finish'
        ? {
            hosted,
            gate: finishCheckpoint.gate,
            merge: result,
            summary: input.summary,
          }
        : { hosted, result, summary: input.summary };
    if (finishCheckpoint?.retained.state === 'merged') {
      assert.deepEqual(
        finishCheckpoint.details.merge,
        result,
        'Merged publication identity changed',
      );
      assert.equal(finishCheckpoint.details.summary, input.summary, 'Merged summary changed');
    }
    store.publication({
      feature: feature.id,
      candidate: input.sha,
      reviewObligation: review.id,
      backend: 'github',
      state,
      details,
      nextCheck: state === 'waiting' ? Date.now() + 30 * 60 * 1000 : null,
    });
    if (operation !== 'finish') return { id: feature.card, status: result.status, sha: input.sha };
    return terminalHandoff(
      {
        feature: featureCard,
        summary: input.summary,
        evidence: {
          status: 'passed',
          label: 'Verified hosted delivery',
          note: `Candidate ${input.sha}; merged commit ${result.mergeSha}.`,
        },
        kind: 'publication',
      },
      rpc,
      registry,
    );
  }
  const remote = new URL(repository.repository);
  assert(remote.protocol === 'file:' && !remote.hostname, 'Selected backend requires hosted input');
  const remoteSha = git(fileURLToPath(remote), [
    'rev-parse',
    `refs/heads/${repository.integrationBranch}`,
  ]);
  if (operation === 'gate') {
    git(repository.checkout, ['merge-base', '--is-ancestor', remoteSha, input.sha]);
    store.publication({
      feature: feature.id,
      candidate: input.sha,
      reviewObligation: review.id,
      backend: 'git',
      state: 'passed',
      details: { remoteBefore: remoteSha, summary: input.summary },
    });
    return { id: feature.card, status: 'publication-ready', sha: input.sha };
  }
  const finishCheckpoint =
    operation === 'finish'
      ? requireFinishPublication(store, feature.id, review.id, input.sha, 'git')
      : null;
  assert(
    operation === 'finish' && finishCheckpoint && remoteSha === input.sha,
    'Publication not independently confirmed',
  );
  const merge = { remoteSha };
  if (finishCheckpoint.retained.state === 'merged') {
    assert.deepEqual(finishCheckpoint.details.merge, merge, 'Merged publication identity changed');
    assert.equal(finishCheckpoint.details.summary, input.summary, 'Merged summary changed');
  }
  store.publication({
    feature: feature.id,
    candidate: input.sha,
    reviewObligation: review.id,
    backend: 'git',
    state: 'merged',
    details: { gate: finishCheckpoint.gate, merge, summary: input.summary },
  });
  return terminalHandoff(
    {
      feature: featureCard,
      summary: input.summary,
      evidence: {
        status: 'passed',
        label: 'Verified local delivery',
        note: `Published candidate ${input.sha}; independent review ${review.id}.`,
      },
      kind: 'publication',
    },
    rpc,
    registry,
  );
}
