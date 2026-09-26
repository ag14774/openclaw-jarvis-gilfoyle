import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { ensureCreatedCard, sealCreationPayload } from './create-card.js';
import { assertNoNativeCardLinks, pageCards } from './workboard-page.js';
import { controllerKey, currentAttempt, handoffHeld } from './record-contracts.js';
import { topology } from '../topology.js';

// One terminal path for settled work that does not require a publication adapter.
// Agents supply the outcome; code validates durable obligations and stages delivery.
export async function finalizeFeature(
  p,
  rpc,
  git = (cwd, args) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000 }).trim(),
) {
  const { productAgentId, engineeringAgentId, workerRuntime } = topology();
  assert(
    p &&
      ['boardId', 'evidence', 'id', 'summary', ...(p.sha === undefined ? [] : ['sha'])]
        .sort()
        .join(',') === Object.keys(p).sort().join(','),
  );
  assert(/^[0-9a-f-]{36}$/.test(p.id) && (p.sha === undefined || /^[0-9a-f]{40}$/.test(p.sha)));
  assert(
    [p.summary, p.evidence].every(
      (s) => typeof s === 'string' && s.trim() && s.length <= 1000 && !/[\r\n]/.test(s),
    ),
  );
  const read = async () => {
    const r = await rpc('workboard.cards.list', { boardId: p.boardId });
    pageCards(r, { boardId: p.boardId, includeArchived: true });
    return r.cards;
  };
  const relatedChildren = (all, feature) => {
    const workPrefix = `work-item:${feature.id}:`,
      actionPrefix = `action:${feature.id}:`;
    return all.filter((child) => {
      if (child.id === feature.id) return false;
      const notes = child.notes ?? '',
        key = child.metadata?.automation?.idempotencyKey ?? '',
        related =
          child.metadata?.automation?.tenant === feature.id ||
          key.startsWith(workPrefix) ||
          key.startsWith(actionPrefix) ||
          notes.split('\n').includes(`Feature: ${feature.id}`);
      if (!related) return false;
      const featureLines = notes.split('\n').filter((line) => line.startsWith('Feature: ')),
        typeLines = notes.split('\n').filter((line) => /^Type:/i.test(line)),
        creationLines = notes.match(/^Creation: sha256:[0-9a-f]{64}$/gm) ?? [],
        workItem = /^Type: work[ -]item$/im.test(notes),
        action = /^Type: action$/im.test(notes);
      assertNoNativeCardLinks(child);
      assert(
        child.metadata?.automation?.boardId === p.boardId &&
          child.metadata?.automation?.tenant === feature.id &&
          typeLines.length === 1 &&
          creationLines.length === 1 &&
          featureLines.length === 1 &&
          featureLines[0] === `Feature: ${feature.id}` &&
          ((workItem && key.startsWith(workPrefix)) || (action && key.startsWith(actionPrefix))),
        'Malformed Feature child',
      );
      return true;
    });
  };
  let cards = await read(),
    c = cards.find((c) => c.id === p.id);
  assert(
    c && /^Type: feature$/m.test(c.notes) && c.agentId === engineeringAgentId && !handoffHeld(c),
  );
  const info = cards.find(
    (c) => c.metadata?.automation?.idempotencyKey === `project-info:${p.boardId}`,
  );
  if (info) {
    const checkout = /^Checkout: (.+)$/m.exec(info.notes)?.[1];
    assert(checkout, 'Repository checkout is missing');
    if (c.status !== 'done' || p.sha !== undefined) {
      assert(p.sha, 'Repository finalization requires an exact HEAD');
      assert.equal(git(checkout, ['rev-parse', 'HEAD']), p.sha);
      assert.equal(
        git(checkout, ['status', '--porcelain']),
        '',
        'Finalization requires a clean checkout',
      );
    }
  } else assert.equal(p.sha, undefined, 'Non-repository finalization cannot claim a Git HEAD');
  if (c.status === 'done')
    assert(
      c.metadata?.automation?.summary === p.summary &&
        c.metadata?.proof?.some((proof) => proof.status === 'passed'),
      'Terminal Feature evidence mismatch',
    );
  const key = `action:${p.id}:owner-notification`,
    children = relatedChildren(cards, c).filter(
      (x) => x.metadata.automation.idempotencyKey !== key,
    );
  assert(
    children.every((c) => c.status === 'done'),
    'Settled work has unfinished children or stops',
  );
  assert(
    children.every(
      (child) =>
        !currentAttempt(child) &&
        !child.labels?.includes('review') &&
        !/^Candidate:/m.test(child.notes ?? ''),
    ),
    'Execution or review evidence requires its publication adapter',
  );
  const active = await rpc('tasks.list', {
    sessionKey: controllerKey(cards, c),
    status: ['queued', 'running'],
    limit: 100,
  });
  assert(
    !active.nextCursor &&
      !active.tasks.some((t) => [workerRuntime, 'subagent'].includes(t.runtime)),
    'Execution is not settled',
  );
  const delivery = /^Delivery: (.+)$/m.exec(c.notes)?.[1];
  assert(delivery);
  const notice = sealCreationPayload({
    boardId: p.boardId,
    tenant: c.id,
    idempotencyKey: key,
    title: 'Owner notification',
    agentId: engineeringAgentId,
    status: 'todo',
    priority: 'normal',
    labels: ['type:action', 'owner-notification'],
    workspace: { kind: 'scratch' },
    maxRuntimeSeconds: 1,
    maxRetries: 1,
    notes: `Type: action\nKind: owner-notification\nFeature: ${c.id}\nDelivery: ${delivery}\nSummary: ${p.summary}`,
  });
  const created = await ensureCreatedCard(notice, rpc);
  if (c.status !== 'done') {
    assert(
      c.metadata?.claim?.ownerId === engineeringAgentId && c.metadata.claim.expiresAt > Date.now(),
      'Claim report Feature before closure',
    );
    cards = await read();
    const fresh = cards.find((x) => x.id === c.id);
    assert.equal(fresh.updatedAt, c.updatedAt, 'Report changed before completion');
    assert(
      relatedChildren(cards, fresh)
        .filter((x) => x.id !== created.card.id)
        .every((x) => x.status === 'done'),
      'New report stop/obligation',
    );
    await rpc('workboard.cards.complete', {
      id: c.id,
      summary: p.summary,
      proof: {
        status: 'passed',
        label: 'Verified terminal evidence',
        note: `${p.sha ? `Repository HEAD: ${p.sha}. ` : ''}${p.evidence}`,
      },
    });
  }
  cards = await read();
  c = cards.find((x) => x.id === p.id);
  assert(
    c.status === 'done' &&
      c.metadata.automation.summary === p.summary &&
      c.metadata.proof?.some((proof) => proof.status === 'passed'),
    'Terminal Feature evidence mismatch',
  );
  const n = cards.find((x) => x.id === created.card.id);
  if (n.agentId === engineeringAgentId)
    await rpc('workboard.cards.update', {
      id: n.id,
      expectedUpdatedAt: n.updatedAt,
      patch: { agentId: productAgentId },
    });
  else assert(n.agentId === productAgentId);
  return { id: c.id, status: 'finalized', notificationId: n.id };
}
