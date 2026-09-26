import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pageCards } from './workboard-page.js';
import { assertNoNativeCardLinks, handoffHeld } from './record-contracts.js';
import { settledWorkers } from './handoff-card.js';
import { terminalHandoff } from './terminal-handoff.js';
import { topology } from '../topology.js';

// A conclusion is agent-authored. Settled execution may have succeeded, failed,
// been cancelled, or produced no changes: none requires a special ending.
export async function finalizeFeature(
  p,
  rpc,
  git = (cwd, args) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000 }).trim(),
) {
  assert(
    p &&
      ['boardId', 'id', 'summary', 'evidence', 'sha'].every(
        (k) => k === 'sha' || Object.hasOwn(p, k),
      ) &&
      Object.keys(p).every((k) => ['boardId', 'id', 'summary', 'evidence', 'sha'].includes(k)),
    'Invalid finalization input',
  );
  assert(/^[0-9a-f-]{36}$/.test(p.id), 'Feature identity required');
  assert(
    [p.summary, p.evidence].every(
      (s) => typeof s === 'string' && s.trim() && s.length <= 2000 && !/\0/.test(s),
    ),
    'Nonempty bounded summary and evidence (up to 2000 characters each) required',
  );
  const { engineeringAgentId } = topology();
  let executionSnapshot;
  const validate = async () => {
    const state = await rpc('workboard.cards.list', { boardId: p.boardId });
    pageCards(state, { boardId: p.boardId, includeArchived: true });
    const feature = state.cards.find((c) => c.id === p.id);
    assert(
      feature && /^Type: feature$/im.test(feature.notes) && feature.agentId === engineeringAgentId,
      'Engineering-owned Feature required',
    );
    assertNoNativeCardLinks(feature);
    assert(
      !handoffHeld(feature) && !feature.labels?.includes('user-held'),
      'Resolve retained decision or hold first',
    );
    const children = state.cards.filter(
      (c) =>
        c.id !== feature.id &&
        (c.metadata?.automation?.tenant === p.id ||
          c.notes?.split('\n').includes(`Feature: ${p.id}`) ||
          new RegExp(`^(work-item|action):${p.id}:`).test(
            c.metadata?.automation?.idempotencyKey ?? '',
          )),
    );
    for (const child of children) {
      assertNoNativeCardLinks(child);
      assert(
        child.metadata?.automation?.boardId === p.boardId &&
          child.metadata.automation.tenant === p.id &&
          (child.notes?.match(/^Type:/gim) ?? []).length === 1 &&
          (child.notes?.match(/^Feature:/gm) ?? []).length === 1 &&
          child.notes.split('\n').includes(`Feature: ${p.id}`) &&
          (child.notes.match(/^Creation: sha256:[0-9a-f]{64}$/gm) ?? []).length === 1,
        'Malformed Feature child',
      );
      if (child.metadata.automation.idempotencyKey === `action:${p.id}:owner-notification`)
        continue;
      assert(
        child.status === 'done' && !child.metadata?.claim && !handoffHeld(child),
        `Settle child ${child.id} before finalization`,
      );
    }
    // Check accepted task identities and actual terminal execution, not semantic
    // outcome labels. The manager's own Feature claim is not worker execution.
    const snapshot = JSON.stringify(
      children.filter(
        (c) => c.metadata.automation.idempotencyKey !== `action:${p.id}:owner-notification`,
      ),
    );
    if (executionSnapshot === undefined) {
      await settledWorkers(
        state.cards,
        [
          { ...feature, metadata: { ...feature.metadata, claim: undefined } },
          ...children.filter((c) => /^Type: work[ -]item$/im.test(c.notes ?? '')),
        ],
        rpc,
      );
      executionSnapshot = snapshot;
    } else
      assert.equal(
        snapshot,
        executionSnapshot,
        'Scoped execution evidence changed; reconcile before finalization',
      );
    if (p.sha !== undefined) {
      assert(/^[0-9a-f]{40}$/.test(p.sha), 'Invalid repository HEAD');
      const info = state.cards.find(
        (c) => c.metadata?.automation?.idempotencyKey === `project-info:${p.boardId}`,
      );
      const checkout = /^Checkout: (.+)$/m.exec(info?.notes ?? '')?.[1];
      assert(checkout, 'Repository checkout missing for supplied HEAD');
      assert.equal(
        git(checkout, ['rev-parse', 'HEAD']),
        p.sha,
        'Supplied HEAD differs from checkout',
      );
      assert.equal(
        git(checkout, ['status', '--porcelain']),
        '',
        'Supplied Git evidence requires a clean checkout',
      );
    }
    return state;
  };
  const state = await validate();
  const result = await terminalHandoff(
    {
      feature: state.cards.find((c) => c.id === p.id),
      boardId: p.boardId,
      summary: p.summary,
      noticeSummary: p.summary.replace(/\s+/g, ' '),
      evidence: {
        status: 'passed',
        label: 'Verified terminal evidence',
        note: `${p.sha ? `Repository HEAD: ${p.sha}. ` : ''}${p.evidence}`,
      },
      validate,
    },
    rpc,
  );
  return { ...result, status: 'finalized' };
}
