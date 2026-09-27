import assert from 'node:assert/strict';

// Feature scope is registry authority. The native note is a recoverable human projection.
export async function amendFeature(input, rpc, registry) {
  assert(registry?.store && registry.project, 'Registry context required');
  const feature = registry.store.feature(input.featureId ?? input.id);
  assert(feature.project === registry.project && feature.board === input.boardId);
  assert(typeof input.scope === 'string' && input.scope.trim() && input.scope.length <= 1400);
  const response = await rpc('workboard.cards.list', { boardId: input.boardId });
  const card = response.cards?.find((candidate) => candidate.id === feature.card);
  assert(
    card && card.status !== 'done' && !card.metadata?.claim,
    'Open unclaimed Feature required',
  );
  const revision = registry.store.stageFeatureRevision({
    feature: feature.id,
    expectedRevision: input.expectedRevision,
    scope: input.scope,
    reason: input.reason,
    source: input.source,
  });
  if (card.notes !== revision.scope) {
    let failure;
    try {
      await rpc('workboard.cards.update', {
        id: card.id,
        expectedUpdatedAt: input.expectedUpdatedAt,
        patch: { notes: revision.scope },
      });
    } catch (error) {
      failure = error;
    }
    const readback = await rpc('workboard.cards.list', { boardId: input.boardId });
    if (
      readback.cards?.find((candidate) => candidate.id === feature.card)?.notes !== revision.scope
    )
      throw failure ?? new Error('Feature scope projection not confirmed');
  }
  registry.store.markFeatureRevisionProjected(feature.id, revision.revision);
  return {
    id: card.id,
    featureId: feature.id,
    revision: revision.revision,
    scope: revision.scope,
    publicationEvidenceInvalidated: true,
  };
}
