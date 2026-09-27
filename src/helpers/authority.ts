import assert from 'node:assert/strict';
import { scopedDecision } from './handoff-card.js';

export function assertEngineeringMutationScope(store, exchange, project, operation, input) {
  let feature;
  if (['work-item', 'review', 'exceptional-intervention'].includes(operation))
    feature = store.feature(input.featureId).id;
  else if (['prepare', 'record', 'handoff'].includes(operation))
    feature = store.obligation(input.obligationId ?? input.id).feature;
  else if (['publish-gate', 'gate', 'finish', 'finalize'].includes(operation))
    feature = store.feature(input.featureId ?? input.id).id;
  else if (operation === 'settle-control')
    feature = store.get(
      'SELECT feature FROM control_intents WHERE id=? AND project=?',
      input.controlId,
      project,
    )?.feature;
  else if (['decide', 'handoff-apply'].includes(operation))
    feature = scopedDecision(store, project, input.checkpoint).feature;
  assert(feature, 'Feature-scoped engineering mutation required');
  assert.equal(exchange.project, project, 'Engineering context belongs to another project');
  assert.equal(exchange.scope, feature, 'Internal context cannot mutate another Feature');
  return feature;
}
