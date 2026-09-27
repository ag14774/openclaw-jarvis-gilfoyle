import assert from 'node:assert/strict';
import { topology } from '../topology.js';

// Stage user-communication facts before the native completion. A restart can
// observe the completed card and release the held intent without losing notice.
export async function terminalHandoff({ feature, summary, evidence, kind }, rpc, registry) {
  assert(registry?.store && registry.project, 'Registry context required');
  assert(feature && typeof summary === 'string' && summary.trim() && summary.length <= 2000);
  assert(
    evidence?.status === 'passed' &&
      typeof evidence.note === 'string' &&
      evidence.note.length <= 2000,
  );
  const registered = registry.store.feature(feature.id);
  assert.equal(registered.project, registry.project);
  registry.store.stageTerminal({ feature: registered.id, kind, summary, evidence });
  if (feature.status !== 'done') {
    assert(
      feature.status === 'running' &&
        feature.metadata?.claim?.ownerId === topology().engineeringAgentId &&
        feature.metadata.claim.expiresAt > Date.now(),
      'Claim Feature before closure',
    );
    try {
      await rpc('workboard.cards.complete', { id: feature.id, summary, proof: evidence });
    } catch {
      // Resolve ambiguous native acceptance from the authoritative reread below.
    }
  } else {
    assert.equal(feature.metadata?.automation?.summary, summary, 'Terminal outcome changed');
    assert(
      feature.metadata?.proof?.some((proof) => proof.status === 'passed'),
      'Terminal proof missing',
    );
  }
  const response = await rpc('workboard.cards.list', { boardId: registered.board });
  const completed = response.cards?.find((card) => card.id === registered.card);
  assert(
    completed?.status === 'done' &&
      completed.metadata?.automation?.summary === summary &&
      completed.metadata?.proof?.some(
        (proof) =>
          proof.status === evidence.status &&
          proof.label === evidence.label &&
          proof.note === evidence.note,
      ),
    'Terminal completion not confirmed',
  );
  registry.store.completeTerminal(registered.id);
  return {
    id: feature.id,
    status: 'finished',
    communicationIntent: `result:${registered.id}`,
  };
}
