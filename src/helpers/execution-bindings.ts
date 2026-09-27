import assert from 'node:assert/strict';
import { controllerKey } from './workboard-page.js';
import { topology } from '../topology.js';
import { assertChildSession, assertTaskIdentity } from './record-contracts.js';

// Discover only exact matches for prepared registry attempts. Native tasks remain
// liveness authority; this persists identities, never task status.
export async function reconcileExecutionBindings(records, cards, store, rpc) {
  const bound = [];
  const pending = [];
  for (const attempt of records.attempts.filter((row) => !row.bound)) {
    const obligation = records.obligations.find((row) => row.id === attempt.obligation);
    const card = cards.find((row) => row.id === obligation?.card);
    if (!card) continue;
    try {
      const owner = controllerKey(records, card);
      const snapshot = await rpc('tasks.list', {
        sessionKey: owner,
        sortBy: 'updatedAt',
        limit: 100,
      });
      assert(
        Array.isArray(snapshot.tasks) && !snapshot.nextCursor,
        'Native task snapshot incomplete',
      );
      const wrappers = [];
      for (const row of snapshot.tasks.filter(
        (task) =>
          task.runtime === 'subagent' &&
          task.agentId === topology().workerAgentId &&
          task.ownerKey === owner,
      )) {
        const task = (await rpc('tasks.get', { taskId: row.taskId })).task;
        try {
          assert(
            task?.taskId === row.taskId &&
              task.runtime === 'subagent' &&
              task.agentId === topology().workerAgentId &&
              task.ownerKey === owner &&
              task.sessionKey === owner,
            'Exact wrapper task identity required',
          );
          assertTaskIdentity(task?.prompt, card.id, attempt.task_name);
          assertChildSession(task?.childSessionKey);
        } catch {
          continue;
        }
        const backing = snapshot.tasks.filter(
          (candidate) =>
            candidate.runtime === topology().workerRuntime &&
            candidate.runId === task.runId &&
            candidate.childSessionKey === task.childSessionKey &&
            candidate.ownerKey === owner,
        );
        assert.equal(backing.length, 1, 'Accepted wrapper has no unique native execution');
        const backingTask = (await rpc('tasks.get', { taskId: backing[0].taskId })).task;
        assert(
          backingTask?.taskId === backing[0].taskId &&
            backingTask.runtime === topology().workerRuntime &&
            backingTask.agentId === topology().workerAgentId &&
            backingTask.ownerKey === owner &&
            backingTask.sessionKey === owner &&
            backingTask.runId === task.runId &&
            backingTask.childSessionKey === task.childSessionKey,
          'Exact backing task identity required',
        );
        wrappers.push({ wrapper: task, backing: backingTask });
      }
      assert(wrappers.length <= 1, 'Multiple executions match prepared attempt');
      if (!wrappers.length) continue;
      const match = wrappers[0];
      bound.push(
        store.bindAttempt(attempt.id, {
          task_id: match.backing.taskId,
          wrapper_task_id: match.wrapper.taskId,
          run_id: match.wrapper.runId,
          child_session: match.wrapper.childSessionKey,
        }),
      );
    } catch (error) {
      pending.push({
        id: obligation?.card,
        attemptId: attempt.id,
        condition: String(error.message).split('\n')[0],
      });
    }
  }
  return { bound, pending };
}
