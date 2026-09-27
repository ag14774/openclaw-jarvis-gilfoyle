import assert from 'node:assert/strict';
import { reconcileExecutionBindings } from './execution-bindings.js';
import { settledWorkers } from './handoff-card.js';

export async function validateRegisteredCompletion(store, project, cards, cardId, rpc) {
  let records = store.records(project.id);
  const obligation = records.obligations.find((row) => row.card === cardId);
  if (!obligation) return { registered: false, allowed: true };
  if (obligation.kind === 'feature') {
    const checkpoint = records.terminalCheckpoints.find(
      (row) => row.feature === obligation.feature,
    );
    assert(
      checkpoint && ['staged', 'completed'].includes(checkpoint.state),
      'Durable terminal checkpoint required before Feature completion',
    );
    return { registered: true, allowed: true, checkpoint: checkpoint.state };
  }
  const result = await reconcileExecutionBindings(records, cards, store, rpc);
  const pending = result.pending.find((row) => row.id === obligation.card);
  assert(!pending, pending?.condition ?? 'Execution binding unresolved');
  records = store.records(project.id);
  await settledWorkers(records, [obligation], rpc);
  return { registered: true, allowed: true };
}
