import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { projectSessionKey, topology } from '../topology.js';

const bounded = (value) => typeof value === 'string' && value.trim() && value.length <= 1400;

async function projectCard(obligation, expected, expectedUpdatedAt, rpc) {
  let response = await rpc('workboard.cards.list', { boardId: obligation.board });
  let card = response.cards?.find((candidate) => candidate.id === obligation.card);
  assert(card, 'Registered decision card missing');
  if (card.status === expected.status && card.agentId === expected.agentId) return card;
  let failure;
  try {
    await rpc('workboard.cards.update', {
      id: obligation.card,
      expectedUpdatedAt: expectedUpdatedAt ?? card.updatedAt,
      patch: expected,
    });
  } catch (error) {
    failure = error;
  }
  response = await rpc('workboard.cards.list', { boardId: obligation.board });
  card = response.cards?.find((candidate) => candidate.id === obligation.card);
  if (card?.status !== expected.status || card.agentId !== expected.agentId)
    throw failure ?? new Error('Decision projection not confirmed');
  return card;
}

export function scopedDecision(store, project, checkpoint) {
  const decision = store.get(
    'SELECT d.* FROM decisions d JOIN features f ON f.id=d.feature WHERE d.id=? AND f.project=?',
    checkpoint,
    project,
  );
  assert(decision, 'Project-scoped decision required');
  if (decision.obligation) {
    const obligation = store.obligation(decision.obligation);
    const feature = store.feature(decision.feature);
    assert(
      obligation.feature === feature.id && obligation.board === feature.board,
      'Decision obligation scope mismatch',
    );
  }
  return decision;
}

export async function projectAnsweredDecision(store, project, checkpoint, rpc, expectedUpdatedAt) {
  const decision = scopedDecision(store, project, checkpoint);
  assert(decision.phase === 'answered', 'Answered decision required');
  if (!decision.obligation) return decision;
  const obligation = store.obligation(decision.obligation);
  await projectCard(
    obligation,
    { status: 'todo', agentId: topology().engineeringAgentId },
    expectedUpdatedAt,
    rpc,
  );
  return decision;
}

export async function settledWorkers(records, obligations, rpc) {
  for (const obligation of obligations.filter((row) => ['work', 'review'].includes(row.kind)))
    assert(
      records.attempts.some((attempt) => attempt.obligation === obligation.id && attempt.bound),
      'Accepted execution binding required',
    );
  const attempts = records.attempts.filter(
    (attempt) =>
      obligations.some((obligation) => obligation.id === attempt.obligation) && attempt.bound,
  );
  for (const attempt of attempts) {
    const obligation = records.obligations.find((row) => row.id === attempt.obligation);
    const owner = projectSessionKey('engineering', obligation.feature);
    const sessions = await rpc('sessions.list', {
      agentId: topology().workerAgentId,
      search: attempt.child_session,
      limit: 10,
      archived: 'all',
    });
    const exact = sessions.sessions.filter((candidate) => candidate.key === attempt.child_session);
    assert(!sessions.hasMore && exact.length === 1, 'Exact worker session unavailable');
    const session = exact[0];
    assert(
      session.hasActiveRun === false && session.hasActiveSubagentRun !== true,
      'Worker session not settled',
    );
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
          ['completed', 'succeeded', 'failed', 'lost', 'timed_out', 'cancelled'].includes(
            task.status,
          ),
        'Worker task not terminal',
      );
    }
  }
}

// Decisions are registry records. Workboard owner/status is only their human-visible projection.
export async function handoffCard(operation, input, rpc, registry) {
  assert(registry?.store && registry.project, 'Registry context required');
  const { store } = registry;
  if (operation === 'handoff') {
    const obligation = store.obligation(input.obligationId ?? input.id);
    const feature = store.feature(obligation.feature);
    assert(feature.project === registry.project && obligation.board === feature.board);
    assert(['user', 'agent'].includes(input.decisionBy ?? 'user'));
    assert([input.reason, input.question, input.resolution].every(bounded));
    const decision = store.recordDecision({
      id: input.checkpoint ?? randomUUID(),
      feature: feature.id,
      obligation: obligation.id,
      authority: input.decisionBy ?? 'user',
      question: input.question,
      reason: input.reason,
      suggestion: input.resolution,
      source: input.source ?? null,
    });
    await projectCard(
      obligation,
      { status: 'blocked', agentId: topology().productAgentId },
      input.expectedUpdatedAt,
      rpc,
    );
    return {
      id: obligation.card,
      checkpoint: decision.id,
      phase: decision.phase,
      sendRequired: true,
    };
  }
  let decision = scopedDecision(store, registry.project, input.checkpoint);
  if (operation === 'handoff-decision') {
    assert(decision.authority === 'agent' && bounded(input.decision) && bounded(input.evidence));
    if (decision.phase === 'answered') {
      assert.equal(decision.answer, input.decision, 'Decision answer changed');
      assert.equal(decision.answer_message, input.evidence, 'Decision evidence changed');
    } else {
      assert(['open', 'sent'].includes(decision.phase), 'Open agent decision required');
      store.run(
        "UPDATE decisions SET phase='answered',answer=?,answer_message=?,updated=? WHERE id=?",
        input.decision,
        input.evidence,
        store.now(),
        decision.id,
      );
    }
    decision = store.get('SELECT * FROM decisions WHERE id=?', decision.id);
    await projectAnsweredDecision(
      store,
      registry.project,
      decision.id,
      rpc,
      input.expectedUpdatedAt,
    );
  } else if (operation === 'handoff-answer') {
    assert(decision.authority === 'user' && bounded(input.answer) && bounded(input.message));
    if (decision.phase === 'answered') {
      assert.equal(decision.answer, input.answer, 'Decision answer changed');
      assert.equal(decision.answer_message, input.message, 'Decision answer source changed');
    } else {
      assert(decision.phase === 'sent', 'Sent user decision required');
      store.run(
        "UPDATE decisions SET phase='answered',answer=?,answer_message=?,updated=? WHERE id=?",
        input.answer,
        input.message,
        store.now(),
        decision.id,
      );
    }
    decision = store.get('SELECT * FROM decisions WHERE id=?', decision.id);
    await projectAnsweredDecision(
      store,
      registry.project,
      decision.id,
      rpc,
      input.expectedUpdatedAt,
    );
  } else if (operation === 'handoff-receipt') {
    assert(input.deliveryId && input.message);
    const delivery = store.get(
      'SELECT * FROM deliveries WHERE id=? AND project=?',
      input.deliveryId,
      registry.project,
    );
    assert(
      delivery?.event === `question:${decision.id}` &&
        ['sent', 'fallback-sent'].includes(delivery.status),
      'Project-scoped sent question delivery required',
    );
    store.run(
      "UPDATE decisions SET phase='sent',question_delivery=?,updated=? WHERE id=?",
      input.deliveryId,
      store.now(),
      decision.id,
    );
  } else if (operation === 'handoff-apply') {
    assert(bounded(input.application));
    if (decision.phase === 'applied') {
      assert.equal(decision.application, input.application, 'Decision application changed');
      assert.equal(
        decision.replacement_required,
        input.replacementRequired ? 1 : 0,
        'Replacement decision changed',
      );
    } else {
      assert(decision.phase === 'answered', 'Answered decision required');
      store.run(
        "UPDATE decisions SET phase='applied',application=?,replacement_required=?,updated=? WHERE id=?",
        input.application,
        input.replacementRequired ? 1 : 0,
        store.now(),
        decision.id,
      );
    }
    decision = store.get('SELECT * FROM decisions WHERE id=?', decision.id);
    const obligation = decision.obligation ? store.obligation(decision.obligation) : null;
    if (obligation)
      await projectCard(
        obligation,
        { status: 'todo', agentId: topology().engineeringAgentId },
        input.expectedUpdatedAt,
        rpc,
      );
  } else throw new Error('Unsupported handoff operation');
  return store.get('SELECT * FROM decisions WHERE id=?', decision.id);
}

export function handoffError(error) {
  return {
    complete: false,
    code: 'validation-failed',
    error: String(error?.message ?? '').slice(0, 500),
  };
}
