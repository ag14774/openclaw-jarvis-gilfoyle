import { createHash } from 'node:crypto';
import { hostedCandidate } from './github-evidence.js';
import { assertNoNativeCardLinks, controllerKey, currentAttempt, deliverySource, handoffEvidencePending, handoffHeld, handoffMarker } from './record-contracts.js';
import { topology } from '../topology.js';
export { assertNoNativeCardLinks, currentAttempt, reconciledAttempts } from './record-contracts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCOPE = /^[a-zA-Z0-9:_-]{1,160}$/;
const STATUSES = new Set(['triage', 'backlog', 'todo', 'scheduled', 'ready', 'running', 'review', 'blocked', 'done']);
const VIEWS = new Set(['queue', 'todoUndelegated', 'delegated', 'attention']);
export const PAGE_CANDIDATE_LIMIT = 96;
export const PAGE_OUTPUT_BYTES = 12000;

function ownerNoticeIdentity(notice, feature) {
  try { assertNoNativeCardLinks(notice); } catch { return false; }
  const notes = typeof notice?.notes === 'string' ? notice.notes : '';
  const featureLines = notes.split('\n').filter(line => line.startsWith('Feature: '));
  return notice?.metadata?.automation?.boardId === feature.metadata?.automation?.boardId &&
    notice.metadata.automation.tenant === feature.id &&
    notice.metadata.automation.idempotencyKey === `action:${feature.id}:owner-notification` &&
    (notes.match(/^Type:/gmi) ?? []).length === 1 && /^Type: action$/mi.test(notes) &&
    featureLines.length === 1 && featureLines[0] === `Feature: ${feature.id}`;
}

function sentOwnerNotice(notice, feature) {
  const { productAgentId } = topology();
  const summary = notice?.metadata?.automation?.summary;
  const receipt = /\bNative [^\r\n]{1,120}\breceipt\b/i;
  const identity = /\b(?:message(?:Id| ID)?|receipt(?:Id| ID)?)\s*[:=#]\s*[A-Za-z0-9][A-Za-z0-9._:-]{0,199}\b/i;
  return ownerNoticeIdentity(notice, feature) && notice.agentId === productAgentId && notice.status === 'done' &&
    Number.isFinite(notice.completedAt) && !notice.metadata?.claim && (!notice.metadata?.archivedAt || feature.metadata?.archivedAt) &&
    typeof summary === 'string' && summary.length <= 1400 && /^Result: sent(?:\b|$)/.test(summary) &&
    notice.metadata?.proof?.some(proof => proof.status === 'passed' && typeof proof.note === 'string' && proof.note.length <= 2000 && receipt.test(proof.note) && identity.test(proof.note));
}


function childCapacity(evidence) {
  const {productAgentId,engineeringAgentId,workerAgentId,workerRuntime}=topology();
  const children = (evidence.capacityTasks ?? evidence.tasks ?? []).filter(t => [workerRuntime, 'subagent'].includes(t.runtime) && ['queued', 'running'].includes(t.status));
  const identities = new Set(children.map(t => t.runId && t.childSessionKey ? `${t.runId}:${t.childSessionKey}` : t.taskId));
  let complete = evidence.available === true && children.every(t => {
    const parts=String(t.childSessionKey??'').split(':'),id=parts.at(-1),worker=parts[1]===workerAgentId&&parts[2]===workerRuntime,managerSubagent=t.runtime==='subagent'&&[productAgentId,engineeringAgentId].includes(parts[1])&&parts[2]==='subagent';
    return UUID.test(t.runId??'')&&UUID.test(id??'')&&(worker||managerSubagent);
  });
  for (const session of evidence.sessions ?? []) {
    if (!session.hasActiveRun) continue;
    if (!children.some(t => t.childSessionKey === session.key)) {
      identities.add(`unresolved:${session.key}`);
      complete = false;
    }
  }
  return { limit: 2, occupied: identities.size, complete };
}


export function classifyCards(cards, evidence = {}, now = Date.now()) {
  const { productAgentId, engineeringAgentId, workerAgentId, workerRuntime } = topology();
  const byId = new Map(cards.map(c => [c.id, c]));
  const tasks = new Map((evidence.tasks ?? []).map(t => [t.taskId, t]));
  const sessions = new Map((evidence.sessions ?? []).map(s => [s.key, s]));
  const capacity = childCapacity(evidence);
  const deliveredQuestions = new Set(cards.filter(c => c.metadata?.comments?.some(comment =>
    typeof comment.body === 'string' && comment.body.startsWith('Question delivery: sent\n') && comment.body.split('\n').includes(`Action: ${c.id}`))).map(c => c.id));
  const rows = new Map();
  for (const card of cards) {
    const notes = typeof card.notes === 'string' ? card.notes : '';
    const type = /^Type: (feature|work[ -]item|action)$/mi.exec(notes)?.[1]?.toLowerCase().replace('-', ' ');
    const feature = /^Feature: ([0-9a-f-]{36})$/m.exec(notes)?.[1];
    const parent = byId.get(feature);
    const a = type === 'work item' ? currentAttempt(card) : notes.includes('<!-- current-attempt -->') ? { uncertain: true } : null;
    let stage = 'uncertain', workerState = null, startedAt = null, lastUpdate = null, live = null, hasActiveRun = null;
    const delegated = Boolean(a?.taskId);
    const waiting = card.status === 'blocked' && /^Wait: product-answer$/m.test(notes);
    const held = card.labels?.includes('user-held') || /^Wait: (human|external|schedule)$/m.test(notes);
    const childValid = feature && UUID.test(feature) && card.metadata?.automation?.tenant === feature && parent && typeof parent.notes === 'string' && /^Type: feature$/mi.test(parent.notes) && (parent.notes.match(/^Type:/gmi) ?? []).length === 1 &&
      parent.metadata?.automation?.boardId === card.metadata?.automation?.boardId;
    if (card.status === 'done') {
      stage = 'settled';
      // The default board is explicitly not a registered product project.
      if (type === 'feature' && card.metadata?.automation?.boardId && card.metadata.automation.boardId !== 'default') {
        const key = `action:${card.id}:owner-notification`;
        const notices = cards.filter(c => c.metadata?.automation?.idempotencyKey === key ||
          (c.metadata?.automation?.boardId === card.metadata?.automation?.boardId && c.metadata?.automation?.tenant === card.id &&
            (/^Kind: owner-notification$/mi.test(c.notes ?? '') || c.labels?.includes('owner-notification'))));
        if (!/^Outcome: (delivered|cancelled)\b/.test(card.metadata?.automation?.summary ?? '') || !card.metadata?.proof?.some(p => p.status === 'passed')) stage = 'terminal-proof-uncertain';
        else if (notices.length !== 1) stage = 'notification-repair';
        else if (!ownerNoticeIdentity(notices[0], card)) stage = 'notification-pending';
        else if (notices[0].agentId === engineeringAgentId && notices[0].status === 'todo' && !notices[0].metadata?.claim && !notices[0].metadata?.archivedAt) stage = 'notification-transfer';
        else if (!sentOwnerNotice(notices[0], card)) stage = 'notification-pending';
      }
    }
    else if (handoffHeld(card)) {
      const h = handoffMarker(card);
      let sourceValid = false;
      try { sourceValid = !h.uncertain && deliverySource(cards,card) === JSON.parse(card.metadata.comments.find(c => c.id === h.question).body).data.source; } catch { /* Missing or changed source is actionable, never a quiet wait. */ }
      stage = !sourceValid || handoffEvidencePending(card,h) || card.status !== 'blocked' || card.metadata?.claim || card.agentId !== (h.phase === 'answer-ready' ? engineeringAgentId : productAgentId) ? 'handoff-uncertain' : h.phase === 'sent' ? 'handoff-waiting-answer' : `handoff-${h.phase}`;
    }
    else if (/^Wait: hosted-ci$/m.test(notes)) {
      const values = name => notes.split('\n').filter(l => l.startsWith(`${name}: `)).map(l => l.slice(name.length + 2));
      const observed = values('CI observed at'), recheck = values('CI recheck at');
      let continuation = false;
      try {
        const candidates = values('Hosted candidate');
        if (notes.length <= 4000 && candidates.length === 1 && (notes.match(/^Hosted candidate:/gm) ?? []).length === 1) {
          const binding = hostedCandidate(JSON.parse(candidates[0]));
          continuation = binding.reviewId !== card.id;
        }
      } catch { /* Malformed continuation is attention, never a healthy wait. */ }
      const validTime = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
      const stops = cards.some(c => c.metadata?.automation?.tenant === card.id && c.status !== 'done' && /^Type: action$/mi.test(c.notes ?? ''));
      stage = !continuation || type !== 'feature' || card.status !== 'todo' || card.metadata?.claim || (notes.match(/^Wait:/gm) ?? []).length !== 1 || observed.length !== 1 || recheck.length !== 1 || !validTime(observed[0]) || !validTime(recheck[0]) || Date.parse(observed[0]) > now || Date.parse(recheck[0]) <= Date.parse(observed[0]) || Date.parse(recheck[0]) - Date.parse(observed[0]) > 30 * 60 * 1000 ? 'hosted-ci-uncertain' : stops || now >= Date.parse(recheck[0]) ? 'hosted-ci-due' : 'hosted-ci-wait';
    }
    else if (waiting || held) {
      const decisions = type === 'feature' ? cards.filter(c => c.metadata?.automation?.tenant === card.id && c.metadata?.automation?.boardId === card.metadata?.automation?.boardId &&
        c.status === 'blocked' && c.agentId === productAgentId && /^Wait: product-answer$/m.test(c.notes ?? '')) : [card];
      stage = a ? 'wait-with-attempt' : !waiting ? 'held' : decisions.length === 1 && deliveredQuestions.has(decisions[0].id) ? 'awaiting-product-answer' : 'question-delivery-uncertain';
    }
    else if (!type || (type !== 'feature' && !childValid)) stage = 'uncertain';
    else if (a) {
      if (!a.taskId || !a.runId || !a.childSessionKey || a.uncertain) stage = 'acceptance-uncertain';
      else {
        const t = tasks.get(a.taskId), w = tasks.get(a.wrapperTaskId), s = sessions.get(a.childSessionKey);
        hasActiveRun = typeof s?.hasActiveRun === 'boolean' ? s.hasActiveRun : null;
        const match = t => t && t.runId === a.runId && t.childSessionKey === a.childSessionKey &&
          t.sessionKey === controllerKey(cards, card) && t.ownerKey === controllerKey(cards, card);
        if (!match(t) || t.runtime !== workerRuntime || t.agentId !== workerAgentId || (a.wrapperTaskId && (!match(w) || w.runtime !== 'subagent'))) stage = 'task-uncertain';
        else {
          workerState = t.status;
          startedAt = Number.isFinite(t.startedAt) ? t.startedAt : null;
          lastUpdate = Number.isFinite(t.updatedAt) ? t.updatedAt : null;
          const runIds = s?.activeRunIds;
          live = s?.hasActiveRun === true && s.hasActiveSubagentRun === true && s.agentRuntime?.id === a.backend &&
            s.parentSessionKey === controllerKey(cards, card) &&
            (!a.wrapperTaskId || (w.status === 'running' && !w.endedAt)) &&
            (Array.isArray(runIds) ? runIds.includes(a.runId) : s.lastRunId ? s.lastRunId === a.runId :
              match(w) && w.runtime === 'subagent' && w.status === 'running' && !w.endedAt && s.startedAt === w.createdAt);
          if (['completed', 'succeeded'].includes(t.status)) stage = s?.hasActiveRun || (w && ['queued', 'running'].includes(w.status)) ? 'terminal-live-conflict' : 'pending-verification';
          else if (['failed', 'lost', 'timed_out', 'cancelled'].includes(t.status)) stage = 'recovery-required';
          else if (t.status === 'queued') stage = s?.hasActiveRun || t.endedAt || !Number.isFinite(t.createdAt) || t.createdAt > now ? 'queued-uncertain' : now - t.createdAt > a.timeoutSeconds * 1000 ? 'queued-overdue' : 'queued';
          else if (t.status === 'running' && !t.endedAt && !s?.endedAt && live && startedAt !== null && startedAt <= now) stage = now > startedAt + a.timeoutSeconds * 1000 ? 'deadline-exceeded' : 'running';
          else stage = 'liveness-uncertain';
        }
      }
    } else if (card.metadata?.claim || card.status === 'running' || card.execution || card.sessionKey) stage = 'manager-reconciliation';
    else if (type === 'work item' && ['todo', 'ready'].includes(card.status)) {
      const requires = /^Requires Work items: (.+)$/m.exec(notes)?.[1];
      const dependencies = requires === 'none' ? [] : requires?.split(', ');
      const valid = dependencies && (notes.match(/^Requires Work items:/gm) ?? []).length === 1 && new Set(dependencies).size === dependencies.length && dependencies.every(id => UUID.test(id) && id !== card.id &&
        /^Type: work[ -]item$/mi.test(byId.get(id)?.notes ?? '') && byId.get(id)?.metadata?.automation?.tenant === feature && byId.get(id)?.metadata?.automation?.boardId === card.metadata?.automation?.boardId);
      stage = !valid ? 'dependencies-uncertain' : dependencies.every(id => byId.get(id).status === 'done' && byId.get(id).metadata?.proof?.some(p => p.status === 'passed')) ? 'todoUndelegated' : 'dependency-wait';
      if (!['todo', 'ready', 'review'].includes(parent.status) || parent.metadata?.archivedAt || handoffHeld(parent) || parent.labels?.includes('user-held') || /^Wait:/m.test(parent.notes) || cards.some(x => [parent.id,card.id].includes(x.metadata?.automation?.tenant) && x.status !== 'done' && /^Type: action$/mi.test(x.notes ?? ''))) stage = 'parent-wait';
    } else if (type === 'feature' && ['todo', 'ready', 'review'].includes(card.status)) stage = 'orchestration';
    else if (type === 'action' && ['todo', 'ready', 'review'].includes(card.status)) stage = 'action';
    else if (card.status === 'backlog' || card.status === 'scheduled') stage = 'held';
    else if (card.status === 'review') stage = 'pending-verification';
    if (card.status !== 'done' && ((notes.match(/^Type:/gmi) ?? []).length !== 1 || (type !== 'feature' && (notes.match(/^Feature:/gm) ?? []).length !== 1))) stage = 'identity-uncertain';
    const noticeParent = type === 'action' ? cards.find(feature => /^Type: feature$/mi.test(feature.notes ?? '') &&
      (card.metadata?.automation?.idempotencyKey === `action:${feature.id}:owner-notification` ||
        ((/^Kind: owner-notification$/mi.test(notes) || card.labels?.includes('owner-notification')) &&
          (card.metadata?.automation?.tenant === feature.id || notes.split('\n').includes(`Feature: ${feature.id}`))))) : null;
    if (noticeParent && (!ownerNoticeIdentity(card, noticeParent) || (card.status === 'done' && !sentOwnerNotice(card, noticeParent)))) stage = ownerNoticeIdentity(card, noticeParent) ? 'notification-pending' : 'identity-uncertain';
    if (a && card.status !== 'done' && (card.metadata?.claim || card.status === 'running' || card.execution || card.sessionKey)) stage = 'manager-reconciliation';
    if (stage === 'todoUndelegated' && !capacity.complete) stage = 'task-snapshot-uncertain';
    else if (stage === 'todoUndelegated' && capacity.occupied >= 2) stage = 'capacity-wait';
    if (['feature','work item','action'].includes(type)) {
      try { assertNoNativeCardLinks(card); } catch { stage = 'identity-uncertain'; }
    }
    rows.set(card.id, { feature: childValid ? feature : null, delegated, stage, taskId: a?.taskId ?? null, workerState, startedAt, lastUpdate, live: Boolean(live), deadline: startedAt !== null && a?.timeoutSeconds ? startedAt + a.timeoutSeconds * 1000 : null,
      hasActiveRun, controller: [productAgentId, engineeringAgentId].includes(card.agentId) ? controllerKey(cards, card, type === 'work item' && a ? engineeringAgentId : card.agentId) : null, backend: a?.backend ?? null, runId: a?.runId ?? null, childSessionKey: a?.childSessionKey ?? null, wrapperTaskId: a?.wrapperTaskId ?? null });
  }
  const executionCards = new Map();
  for (const card of cards) {
    const row = rows.get(card.id);
    if (card.status === 'done' || card.metadata?.archivedAt || !row.runId || !row.childSessionKey) continue;
    const key = `${row.runId}:${row.childSessionKey}`;
    const previous = executionCards.get(key);
    if (previous) {
      row.stage = 'duplicate-execution-reference';
      rows.get(previous).stage = 'duplicate-execution-reference';
    } else executionCards.set(key, card.id);
  }
  for (const card of cards) {
    const row = rows.get(card.id);
    if (row.stage !== 'orchestration') continue;
    const children = cards.filter(c => c.metadata?.automation?.tenant === card.id && c.metadata?.automation?.boardId === card.metadata?.automation?.boardId && c.status !== 'done');
    // Human delivery can be quiet without hiding the engineer's retained terminal
    // attempt. The parent remains actionable even when its child is Jarvis-owned.
    if (children.some(c => handoffHeld(c) && currentAttempt(c))) {
      row.stage = 'child-handoff-reconciliation';
      continue;
    }
    if (children.length && children.every(c => ['running', 'queued', 'awaiting-product-answer', 'held', 'dependency-wait', 'capacity-wait'].includes(rows.get(c.id).stage)) && children.some(c => ['running', 'queued', 'awaiting-product-answer', 'held', 'capacity-wait'].includes(rows.get(c.id).stage))) row.stage = 'children-wait';
  }
  return rows;
}

export function validateQuery(query) {
  const { productAgentId, engineeringAgentId } = topology();
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new Error('Expected query object');
  for (const key of Object.keys(query)) {
    if (!['agentId', 'boardId', 'tenant', 'includeArchived', 'after', 'membership', 'view'].includes(key)) throw new Error('Unknown query field');
  }
  if (query.agentId !== undefined && ![productAgentId, engineeringAgentId].includes(query.agentId)) throw new Error('Invalid manager');
  for (const key of ['boardId', 'tenant']) {
    if (query[key] !== undefined && (typeof query[key] !== 'string' || !SCOPE.test(query[key]))) throw new Error(`Invalid ${key}`);
  }
  if (!query.agentId && !query.boardId && !query.tenant) throw new Error('Explicit scope required');
  if (typeof query.includeArchived !== 'boolean') throw new Error('Explicit includeArchived required');
  if (query.view !== undefined && !VIEWS.has(query.view)) throw new Error('Invalid view');
  if (query.after !== undefined && (typeof query.after !== 'string' || !UUID.test(query.after))) throw new Error('Invalid after');
  if (query.membership !== undefined && (typeof query.membership !== 'string' || !/^[0-9a-f]{64}$/.test(query.membership))) throw new Error('Invalid membership');
  if (Boolean(query.after) !== Boolean(query.membership)) throw new Error('Continuation requires after and membership together');
  return query;
}

export function pageCards(response, query, evidence, now) {
  validateQuery(query);
  if (!response || !Array.isArray(response.cards) || !Array.isArray(response.boards)) throw new Error('Incomplete native response');
  const ids = new Set();
  const counts = new Map();
  for (const card of response.cards) {
    if (!card || !UUID.test(card.id) || ids.has(card.id) || !STATUSES.has(card.status) || !Number.isFinite(card.updatedAt)) throw new Error('Invalid or duplicate native card');
    ids.add(card.id);
    const board = card.metadata?.automation?.boardId ?? 'default';
    if (query.boardId && board !== query.boardId) throw new Error('Native board scope mismatch');
    counts.set(board, (counts.get(board) ?? 0) + 1);
  }
  // The native RPC has no cursor or limit. Check its full result against board totals.
  const boards = new Map();
  for (const board of response.boards) {
    if (!board || typeof board.id !== 'string' || boards.has(board.id) || !Number.isSafeInteger(board.total) || board.total < 0) throw new Error('Invalid native board totals');
    boards.set(board.id, board.total);
  }
  for (const id of counts.keys()) if (!boards.has(id)) throw new Error('Missing board total');
  for (const [id, total] of boards) {
    if ((!query.boardId || id === query.boardId) && total !== (counts.get(id) ?? 0)) throw new Error('Native enumeration changed or was truncated; restart scan');
  }
  if (query.boardId && !boards.has(query.boardId)) throw new Error('Unknown board');
  const classifications = query.view ? classifyCards(response.cards, evidence, now) : null;
  const cards = response.cards.filter(card =>
    (query.includeArchived || !card.metadata?.archivedAt) &&
    (!query.agentId || card.agentId === query.agentId) &&
    (!query.tenant || card.metadata?.automation?.tenant === query.tenant) &&
    (!query.view || (query.view === 'delegated' ? classifications.get(card.id).delegated && card.status !== 'done' :
      query.view === 'todoUndelegated' ? ['todoUndelegated', 'capacity-wait'].includes(classifications.get(card.id).stage) :
      query.view === 'queue' ? ['todoUndelegated', 'capacity-wait', 'orchestration', 'action'].includes(classifications.get(card.id).stage) :
       !['settled', 'held', 'awaiting-product-answer', 'handoff-waiting-answer', 'running', 'queued', 'children-wait', 'dependency-wait', 'parent-wait', 'capacity-wait', 'hosted-ci-wait'].includes(classifications.get(card.id).stage)))
  ).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const scope = { agentId: query.agentId, boardId: query.boardId, tenant: query.tenant, includeArchived: query.includeArchived, view: query.view };
  const membership = createHash('sha256').update(JSON.stringify([scope, cards.map(card => card.id)])).digest('hex');
  if (query.membership && query.membership !== membership) throw new Error('Scan membership changed; restart at first page');
  const index = query.after ? cards.findIndex(card => card.id === query.after) : -1;
  if (query.after && index < 0) throw new Error('Continuation card missing');
  const selected = cards.slice(index + 1, index + 1 + PAGE_CANDIDATE_LIMIT);
  const result = {
    source: 'workboard.cards.list', total: cards.length, membership,
    ...(query.view ? { capacity: childCapacity(evidence ?? {}) } : {}),
    hasMore: false, nextAfter: null,
    fields: ['id', 'status', 'priority', 'title', 'updatedAt', ...(query.view ? ['feature', 'delegated', 'stage', 'taskId', 'workerState', 'startedAt', 'lastUpdate', 'live', 'deadline', 'hasActiveRun', 'controller', 'backend', 'runId', 'childSessionKey', 'wrapperTaskId'] : [])],
    cards: selected.map(card => [card.id, card.status, ['low', 'normal', 'high', 'urgent'].includes(card.priority) ? card.priority : 'normal', String(card.title ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0,32), card.updatedAt, ...(query.view ? Object.values(classifications.get(card.id)) : [])]),
  };
  const setContinuation = () => {
    result.hasMore = index + 1 + result.cards.length < cards.length;
    result.nextAfter = result.hasMore ? result.cards.at(-1)?.[0] ?? null : null;
  };
  setContinuation();
  while (result.cards.length > 1 && Buffer.byteLength(`${JSON.stringify(result)}\n`) > PAGE_OUTPUT_BYTES) {
    result.cards.pop();
    setContinuation();
  }
  if (Buffer.byteLength(`${JSON.stringify(result)}\n`) > PAGE_OUTPUT_BYTES) throw new Error('Page output exceeds bound');
  return result;
}

// Supported read-only RPCs only. Requests are batched in-process, never one model/CLI turn per card.
export async function readView(query, rpc) {
  const { productAgentId, workerAgentId } = topology();
  validateQuery(query);
  let bytes = 0;
  const read = async (method, params) => {
    const value = await rpc(method, params);
    bytes += Buffer.byteLength(JSON.stringify(value));
    if (bytes > 24 * 1024 * 1024) throw new Error('Native input exceeds bound');
    return value;
  };
  const response = await read('workboard.cards.list', query.boardId ? { boardId: query.boardId } : {});
  // Validate complete card enumeration before any task lookup.
  pageCards(response, { ...query, view: undefined, after: undefined, membership: undefined });
  if (!query.view) return pageCards(response, query);
  if (query.agentId === productAgentId) return pageCards(response, query, { available: false });
  const scoped = response.cards.filter(c => (query.includeArchived || !c.metadata?.archivedAt) && c.status !== 'done' &&
    (!query.agentId || c.agentId === query.agentId) && (!query.tenant || c.metadata?.automation?.tenant === query.tenant));
  const refs = [...new Set(scoped.flatMap(c => {
    const a = currentAttempt(c);
    return [a?.taskId, a?.wrapperTaskId].filter(Boolean);
  }))];
  if (refs.length > 64) throw new Error('Current task reference bound exceeded; controller reconciliation required');
  const snapshot = await read('tasks.list', { status: ['queued', 'running'], limit: 100 });
  if (!Array.isArray(snapshot.tasks) || snapshot.tasks.some(t => !t || !UUID.test(t.taskId) || !['queued', 'running'].includes(t.status) || typeof t.runtime !== 'string') ||
      new Set(snapshot.tasks.map(t => t.taskId)).size !== snapshot.tasks.length) throw new Error('Task snapshot unavailable');
  const tasks = new Map(snapshot.tasks.map(t => [t.taskId, t]));
  let lookupUncertain = false;
  // Exact lookups also resolve stale/late snapshot rows. Absence or denial stays unknown.
  await Promise.all(refs.map(async taskId => {
    tasks.delete(taskId);
    try {
      const result = await read('tasks.get', { taskId });
      if (result.task?.taskId === taskId) tasks.set(taskId, result.task);
      else lookupUncertain = true;
    } catch { lookupUncertain = true; }
  }));
  let sessions = [];
  if (refs.length) {
    const result = await read('sessions.list', { agentId: workerAgentId, limit: 100 });
    if (result.hasMore || !Array.isArray(result.sessions) || result.sessions.some(s => typeof s?.key !== 'string') ||
        new Set(result.sessions.map(s => s.key)).size !== result.sessions.length) throw new Error('Live session enumeration incomplete');
    sessions = result.sessions;
  }
  if (bytes > 24 * 1024 * 1024) throw new Error('Native input exceeds bound');
  return pageCards(response, query, { available: !snapshot.nextCursor && !lookupUncertain, capacityTasks: snapshot.tasks, tasks: [...tasks.values()], sessions });
}
