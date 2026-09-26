import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pageCards } from './workboard-page.js';
import { settledWorkers, assertCommentCapacity } from './handoff-card.js';
import { handoffHeld, assertNoNativeCardLinks } from './record-contracts.js';

export async function amendFeature({ boardId, id, expectedUpdatedAt, scope, reason, source }, rpc) {
  assert(
    [scope, reason, source].every(
      (v) => typeof v === 'string' && v.trim() && v.length <= 1400 && !/[\r\n\0]/.test(v),
    ),
    'Amendment requires bounded scope, reason and authentic source',
  );
  const result = await rpc('workboard.cards.list', { boardId });
  pageCards(result, { boardId, includeArchived: true });
  const feature = result.cards.find((c) => c.id === id);
  assert(
    feature &&
      /^Type: feature$/im.test(feature.notes) &&
      feature.status !== 'done' &&
      !feature.metadata?.archivedAt &&
      !feature.metadata?.claim &&
      !handoffHeld(feature),
    'Amend an open, unclaimed Feature after settling its decision',
  );
  assertNoNativeCardLinks(feature);
  const prior = (feature.metadata?.comments ?? []).flatMap((c) => {
    try {
      const value = JSON.parse(c.body);
      return value.source === source && value.amendment ? [value] : [];
    } catch {
      return [];
    }
  });
  if (prior.length) {
    assert.equal(prior.length, 1, 'Ambiguous amendment source');
    assert(
      prior[0].reason === reason &&
        /^Current scope: (.+)$/m.exec(feature.notes)?.[1] === scope &&
        Number(/^Scope revision: (\d+)$/m.exec(feature.notes)?.[1]) === prior[0].amendment,
      'Amendment source already applied; reread current scope',
    );
    return { id, revision: prior[0].amendment, scope, reused: true };
  }
  assert.equal(feature.updatedAt, expectedUpdatedAt, 'Feature changed; reread before amendment');
  const workers = result.cards.filter(
    (c) => c.metadata?.automation?.tenant === id && /^Type: work[ -]item$/im.test(c.notes ?? ''),
  );
  await settledWorkers(result.cards, [feature, ...workers], rpc);
  const revision = Number(/^Scope revision: (\d+)$/m.exec(feature.notes)?.[1] ?? 0) + 1;
  const notes =
    feature.notes
      .replace(
        /^(Current scope|Scope revision|Hosted candidate|Hosted gate|CI observed at|CI recheck at):.*\n?/gm,
        '',
      )
      .replace(/^Wait: hosted-ci\n?/gm, '')
      .trimEnd() + `\nCurrent scope: ${scope}\nScope revision: ${revision}`;
  assert(notes.length <= 4000, 'Amendment exceeds native notes capacity');
  const body = JSON.stringify({
    amendment: revision,
    source,
    reason,
    previousScope:
      /^(?:Current scope): (.+)$/m.exec(feature.notes)?.[1] ??
      /^Scope: (.+)$/m.exec(feature.notes)?.[1],
  });
  assert(body.length <= 2000, 'Amendment evidence exceeds native comment capacity');
  assertCommentCapacity(feature, [body]);
  // One native CAS persists scope and provenance together, avoiding a second ledger.
  const metadata = {
    ...feature.metadata,
    comments: [
      ...(feature.metadata?.comments ?? []),
      { id: randomUUID(), body, createdAt: Date.now() },
    ],
  };
  await rpc('workboard.cards.update', { id, expectedUpdatedAt, patch: { notes, metadata } });
  const readback = await rpc('workboard.cards.list', { boardId });
  pageCards(readback, { boardId, includeArchived: true });
  assert.equal(
    readback.cards.find((c) => c.id === id)?.notes,
    notes,
    'Amendment readback mismatch',
  );
  return { id, revision, scope, publicationEvidenceInvalidated: true };
}
