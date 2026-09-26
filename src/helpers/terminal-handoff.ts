import assert from 'node:assert/strict';
import { ensureCreatedCard, sealCreationPayload } from './create-card.js';
import { assertNoNativeCardLinks } from './record-contracts.js';
import { topology } from '../topology.js';

// Evidence adapters validate effects. This single routine owns completion and
// notification ordering, including recovery after an ambiguously accepted write.
export async function terminalHandoff(
  { feature, boardId, summary, evidence, noticeSummary = summary, candidate, validate },
  rpc,
) {
  const { engineeringAgentId, productAgentId } = topology();
  assert(
    typeof evidence?.note === 'string' && evidence.note.length <= 2000,
    'Terminal evidence exceeds native proof capacity',
  );
  const key = `action:${feature.id}:owner-notification`;
  const read = async () => {
    const state = await validate();
    const card = state.cards.find((c) => c.id === feature.id);
    assert(card, 'Feature disappeared during finalization');
    assertNoNativeCardLinks(card);
    const notices = state.cards.filter(
      (c) =>
        c.metadata?.automation?.tenant === card.id &&
        (c.metadata.automation.idempotencyKey === key ||
          c.labels?.includes('owner-notification') ||
          /^Kind: (owner-)?notification$/im.test(c.notes ?? '')),
    );
    assert(
      notices.length <= 1 && notices.every((c) => c.metadata.automation.idempotencyKey === key),
      'Existing noncanonical or duplicate notice requires reconciliation',
    );
    if (card.status === 'done') {
      assert.equal(card.metadata?.automation?.summary, summary, 'Terminal outcome changed');
      assert(
        card.metadata?.proof?.some((p) => p.status === 'passed'),
        'Terminal evidence missing',
      );
    } else {
      assert(
        card.status === 'running' &&
          card.metadata?.claim?.ownerId === engineeringAgentId &&
          card.metadata.claim.expiresAt > Date.now(),
        'Claim Feature before closure',
      );
      assert.equal(card.updatedAt, feature.updatedAt, 'Feature changed before completion');
    }
    return { card, notices };
  };
  const delivery = /^Delivery: (.+)$/m.exec(feature.notes)?.[1];
  assert(delivery, 'Feature delivery context missing');
  const expected = sealCreationPayload({
    boardId,
    tenant: feature.id,
    idempotencyKey: key,
    title: 'Owner notification',
    agentId: engineeringAgentId,
    status: 'todo',
    priority: 'normal',
    labels: ['type:action', 'owner-notification'],
    workspace: { kind: 'scratch' },
    maxRuntimeSeconds: 1,
    maxRetries: 1,
    notes: `Type: action\nKind: owner-notification\nFeature: ${feature.id}\nDelivery: ${delivery}${candidate ? `\nCandidate: ${candidate}` : ''}\nSummary: ${noticeSummary}`,
  });
  await read();
  const created = await ensureCreatedCard(expected, rpc);
  let { card, notices } = await read();
  assert.equal(notices.length, 1, 'Notification staging readback failed');
  if (card.status !== 'done') {
    assert(
      notices[0].agentId === engineeringAgentId &&
        notices[0].status === 'todo' &&
        !notices[0].metadata?.claim,
      'Staged notice already active',
    );
    await rpc('workboard.cards.complete', { id: card.id, summary, proof: evidence });
  }
  ({ card, notices } = await read());
  assert.equal(card.status, 'done');
  await ensureCreatedCard(expected, rpc);
  const notice = notices[0];
  assert.equal(notice.id, created.card.id);
  assertNoNativeCardLinks(notice);
  if (notice.agentId === engineeringAgentId) {
    assert(
      notice.status === 'todo' && !notice.metadata?.claim && !notice.metadata?.archivedAt,
      'Notification must be unclaimed before transfer',
    );
    await rpc('workboard.cards.update', {
      id: notice.id,
      expectedUpdatedAt: notice.updatedAt,
      patch: { agentId: productAgentId },
    });
  } else assert.equal(notice.agentId, productAgentId, 'Unexpected notification owner');
  const final = (await read()).notices[0];
  assert(
    final.agentId === productAgentId &&
      (!final.metadata?.claim || final.metadata.claim.ownerId === productAgentId),
    'Notification transfer failed',
  );
  return {
    id: card.id,
    status: 'finished',
    notificationId: final.id,
    notificationStatus: final.status,
    wakeRequired: final.status !== 'done' && !final.metadata?.claim,
  };
}
