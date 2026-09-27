import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pageCards } from './workboard-page.js';
import { settledWorkers } from './handoff-card.js';
import { terminalHandoff } from './terminal-handoff.js';

export async function finalizeFeature(
  input,
  rpc,
  git = (cwd, args) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000 }).trim(),
  registry,
) {
  assert(registry?.store && registry.project, 'Registry context required');
  const feature = registry.store.feature(input.featureId ?? input.id);
  assert(feature.project === registry.project && feature.board === input.boardId);
  assert(!registry.store.pendingStop(feature.id), 'Pending stop control blocks finalization');
  const records = registry.store.records(registry.project);
  const response = await rpc('workboard.cards.list', { boardId: input.boardId });
  pageCards(response, { boardId: input.boardId, includeArchived: true }, records);
  const card = response.cards.find((candidate) => candidate.id === feature.card);
  assert(card && !card.metadata?.archivedAt, 'Registered Feature card required');
  const obligations = records.obligations.filter(
    (row) => row.feature === feature.id && row.kind !== 'feature' && row.required,
  );
  assert(
    obligations.every((obligation) => {
      const child = response.cards.find((candidate) => candidate.id === obligation.card);
      return (
        child?.status === 'done' &&
        child.metadata?.proof?.some((proof) => proof.status === 'passed')
      );
    }),
    'Required obligations must be settled and proved',
  );
  await settledWorkers(records, obligations, rpc);
  assert(
    !records.decisions.some(
      (decision) => decision.feature === feature.id && decision.phase !== 'applied',
    ),
    'Resolve open decision first',
  );
  if (input.sha !== undefined) {
    assert(/^[0-9a-f]{40}$/.test(input.sha) && registry.repository);
    assert.equal(git(registry.repository.checkout, ['rev-parse', 'HEAD']), input.sha);
    assert.equal(git(registry.repository.checkout, ['status', '--porcelain']), '');
  }
  return terminalHandoff(
    {
      feature: card,
      summary: input.summary,
      evidence: {
        status: 'passed',
        label: 'Verified terminal evidence',
        note: `${input.sha ? `Repository HEAD: ${input.sha}. ` : ''}${input.evidence}`,
      },
      kind: 'finalize',
    },
    rpc,
    registry,
  );
}
