import { createHash } from 'node:crypto';
import { topology } from '../topology.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCOPE = /^[a-zA-Z0-9:_-]{1,160}$/;
const STATUSES = new Set([
  'triage',
  'backlog',
  'todo',
  'scheduled',
  'ready',
  'running',
  'review',
  'blocked',
  'done',
]);
const VIEWS = new Set(['queue', 'todoUndelegated', 'delegated', 'attention']);
export const PAGE_CANDIDATE_LIMIT = 96;
export const PAGE_OUTPUT_BYTES = 12000;

export function controllerKey(records, card, agentId = topology().engineeringAgentId) {
  const obligation = records.obligations.find((row) => row.card === card.id);
  const feature = obligation && records.features.find((row) => row.id === obligation.feature);
  return feature
    ? `agent:${agentId}:${topology().sessionNamespace}:${feature.id}`
    : `agent:${agentId}:main`;
}

const current = (records, obligation) =>
  records.attempts
    .filter((attempt) => attempt.obligation === obligation.id)
    .sort((a, b) => b.sequence - a.sequence)[0] ?? null;

export function workerCapacity(evidence) {
  const { workerAgentId, workerRuntime } = topology();
  const running = (evidence.capacityTasks ?? evidence.tasks ?? []).filter(
    (task) =>
      task.agentId === workerAgentId &&
      task.runtime === workerRuntime &&
      ['queued', 'running'].includes(task.status),
  );
  return {
    limit: topology().workerLimit,
    occupied: new Set(running.map((task) => task.runId ?? task.taskId)).size,
    complete: evidence.available === true,
  };
}

export function classifyCards(cards, records, evidence = {}, now = Date.now()) {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const tasks = new Map((evidence.tasks ?? []).map((task) => [task.taskId, task]));
  const sessions = new Map((evidence.sessions ?? []).map((session) => [session.key, session]));
  const rows = new Map();
  const ordered = [...records.obligations].sort(
    (a, b) => Number(a.kind === 'feature') - Number(b.kind === 'feature'),
  );
  for (const obligation of ordered) {
    const card = byId.get(obligation.card);
    const feature = records.features.find((row) => row.id === obligation.feature);
    if (!card || !feature || card.metadata?.archivedAt) continue;
    const attempt = current(records, obligation);
    let stage = 'orchestration';
    let task = null;
    let session = null;
    if (card.status === 'done') {
      const checkpoint = records.terminalCheckpoints?.find((row) => row.feature === feature.id);
      if (obligation.kind === 'feature') {
        let completed = false;
        if (checkpoint?.state === 'completed') {
          const evidence = JSON.parse(checkpoint.evidence);
          completed =
            card.metadata?.automation?.summary === checkpoint.summary &&
            card.metadata?.proof?.some(
              (proof) =>
                proof.status === evidence.status &&
                proof.label === evidence.label &&
                proof.note === evidence.note,
            );
        }
        stage = completed
          ? 'settled'
          : checkpoint?.state === 'staged'
            ? 'terminal-reconciliation'
            : 'terminal-uncertain';
      } else if (attempt && !attempt.bound) stage = 'binding-pending';
      else if (attempt) {
        task = tasks.get(attempt.task_id);
        session = sessions.get(attempt.child_session);
        if (!task) stage = 'task-uncertain';
        else if (['queued', 'running'].includes(task.status) || session?.hasActiveRun)
          stage = 'terminal-live-conflict';
        else if (
          ['completed', 'succeeded', 'failed', 'lost', 'timed_out', 'cancelled'].includes(
            task.status,
          )
        )
          stage = 'settled';
        else stage = 'task-uncertain';
      } else stage = 'settled';
    } else if (obligation.kind === 'feature') {
      const decision = records.decisions.find(
        (row) => row.feature === feature.id && row.phase !== 'applied',
      );
      const publication = records.publications.find((row) => row.feature === feature.id);
      const control = records.controls.find(
        (row) => row.feature === feature.id && row.state === 'pending',
      );
      if (control) stage = 'control-pending';
      else if (decision) stage = decision.phase === 'sent' ? 'decision-wait' : 'decision-action';
      else if (publication?.state === 'waiting')
        stage = publication.next_check > now ? 'publication-wait' : 'publication-due';
      else if (publication?.state === 'merged') stage = 'publication-completion';
      else if (['backlog', 'scheduled'].includes(card.status)) stage = 'held';
      else if (card.status === 'blocked') stage = 'held';
      else {
        const children = records.obligations
          .filter((row) => row.feature === feature.id && row.kind !== 'feature')
          .map((row) => rows.get(row.card))
          .filter(Boolean);
        if (
          children.length &&
          children.every((row) =>
            ['settled', 'running', 'queued', 'dependency-wait'].includes(row.stage),
          )
        )
          stage = 'children-wait';
        else if (card.status === 'triage') stage = 'triage';
        else if (!['todo', 'ready', 'running', 'review'].includes(card.status)) stage = 'uncertain';
      }
    } else if (['backlog', 'scheduled'].includes(card.status)) stage = 'held';
    else {
      const decision = records.decisions.find(
        (row) => row.obligation === obligation.id && row.phase !== 'applied',
      );
      if (decision) stage = decision.phase === 'sent' ? 'decision-wait' : 'decision-action';
      else if (card.status === 'blocked') stage = 'held';
      else if (obligation.kind === 'intervention')
        stage = card.status === 'triage' ? 'triage' : 'intervention';
      else if (card.status === 'triage') stage = 'triage';
      else if (!attempt && card.status === 'running') stage = 'manager-reconciliation';
      else if (!attempt && card.status === 'review') stage = 'pending-verification';
      else if (!attempt && !['todo', 'ready'].includes(card.status)) stage = 'uncertain';
      else if (!attempt) {
        const dependencies = records.dependencies
          .filter((row) => row.obligation === obligation.id)
          .map((row) => records.obligations.find((candidate) => candidate.id === row.requires));
        stage = dependencies.every((dependency) => byId.get(dependency?.card)?.status === 'done')
          ? 'todoUndelegated'
          : 'dependency-wait';
      } else if (!attempt.bound) stage = 'binding-pending';
      else {
        task = tasks.get(attempt.task_id);
        session = sessions.get(attempt.child_session);
        const match =
          task &&
          task.runId === attempt.run_id &&
          task.childSessionKey === attempt.child_session &&
          task.ownerKey === controllerKey(records, card) &&
          task.sessionKey === task.ownerKey;
        if (!match) stage = 'task-uncertain';
        else if (['completed', 'succeeded'].includes(task.status))
          stage = session?.hasActiveRun ? 'terminal-live-conflict' : 'pending-verification';
        else if (['failed', 'lost', 'timed_out', 'cancelled'].includes(task.status))
          stage = 'recovery-required';
        else if (task.status === 'queued') stage = 'queued';
        else if (task.status === 'running' && session?.hasActiveRun === true)
          stage =
            now > task.startedAt + attempt.timeout_seconds * 1000 ? 'deadline-exceeded' : 'running';
        else stage = 'liveness-uncertain';
      }
    }
    if (stage === 'todoUndelegated' && !workerCapacity(evidence).complete)
      stage = 'task-snapshot-uncertain';
    else if (
      stage === 'todoUndelegated' &&
      workerCapacity(evidence).occupied >= workerCapacity(evidence).limit
    )
      stage = 'capacity-wait';
    rows.set(card.id, {
      feature: feature.card,
      obligation: obligation.id,
      delegated: Boolean(attempt?.bound),
      stage,
      taskId: attempt?.task_id ?? null,
      workerState: task?.status ?? null,
      startedAt: task?.startedAt ?? null,
      lastUpdate: task?.updatedAt ?? null,
      live: Boolean(session?.hasActiveRun),
      deadline: task?.startedAt ? task.startedAt + attempt.timeout_seconds * 1000 : null,
      hasActiveRun: session?.hasActiveRun ?? null,
      controller: controllerKey(records, card),
      backend: attempt ? topology().workerRuntime : null,
      runId: attempt?.run_id ?? null,
      childSessionKey: attempt?.child_session ?? null,
      wrapperTaskId: attempt?.wrapper_task_id ?? null,
    });
  }
  return rows;
}

export function validateQuery(query) {
  const { productAgentId, engineeringAgentId } = topology();
  if (!query || typeof query !== 'object' || Array.isArray(query))
    throw new Error('Expected query object');
  for (const key of Object.keys(query))
    if (
      !['agentId', 'boardId', 'tenant', 'includeArchived', 'after', 'membership', 'view'].includes(
        key,
      )
    )
      throw new Error('Unknown query field');
  if (query.agentId !== undefined && ![productAgentId, engineeringAgentId].includes(query.agentId))
    throw new Error('Invalid manager');
  for (const key of ['boardId', 'tenant'])
    if (query[key] !== undefined && (typeof query[key] !== 'string' || !SCOPE.test(query[key])))
      throw new Error(`Invalid ${key}`);
  if (!query.agentId && !query.boardId && !query.tenant) throw new Error('Explicit scope required');
  if (typeof query.includeArchived !== 'boolean')
    throw new Error('Explicit includeArchived required');
  if (query.view !== undefined && !VIEWS.has(query.view)) throw new Error('Invalid view');
  if (query.after !== undefined && !UUID.test(query.after)) throw new Error('Invalid after');
  if (query.membership !== undefined && !/^[0-9a-f]{64}$/.test(query.membership))
    throw new Error('Invalid membership');
  if (Boolean(query.after) !== Boolean(query.membership))
    throw new Error('Continuation requires after and membership together');
  return query;
}

export function pageCards(response, query, records = null, evidence = {}, now = Date.now()) {
  validateQuery(query);
  if (!response || !Array.isArray(response.cards) || !Array.isArray(response.boards))
    throw new Error('Incomplete native response');
  const boardTotals = new Map(response.boards.map((board) => [board.id, board.total]));
  const ids = new Set();
  const counts = new Map();
  for (const card of response.cards) {
    if (
      !card ||
      !UUID.test(card.id) ||
      ids.has(card.id) ||
      !STATUSES.has(card.status) ||
      !Number.isFinite(card.updatedAt)
    )
      throw new Error('Invalid or duplicate native card');
    ids.add(card.id);
    const board = card.metadata?.automation?.boardId ?? 'default';
    if (query.boardId && board !== query.boardId) throw new Error('Native board scope mismatch');
    counts.set(board, (counts.get(board) ?? 0) + 1);
  }
  for (const [board, total] of boardTotals)
    if ((!query.boardId || board === query.boardId) && total !== (counts.get(board) ?? 0))
      throw new Error('Native enumeration changed or was truncated; restart scan');
  if (query.boardId && !boardTotals.has(query.boardId)) throw new Error('Unknown board');
  const classifications = query.view ? classifyCards(response.cards, records, evidence, now) : null;
  const registered = records ? new Set(records.obligations.map((row) => row.card)) : null;
  const cards = response.cards
    .filter((card) => {
      if (registered && !registered.has(card.id)) return false;
      if (!query.includeArchived && card.metadata?.archivedAt) return false;
      if (query.agentId && card.agentId !== query.agentId) return false;
      if (query.tenant) {
        const feature = records?.features.find(
          (row) => row.id === query.tenant || row.card === query.tenant,
        );
        const obligation = records?.obligations.find((row) => row.card === card.id);
        if (!feature || obligation?.feature !== feature.id) return false;
      }
      if (!query.view) return true;
      const row = classifications.get(card.id);
      if (!row) return false;
      if (query.view === 'delegated') return row.delegated && card.status !== 'done';
      if (query.view === 'todoUndelegated')
        return ['todoUndelegated', 'capacity-wait'].includes(row.stage);
      if (query.view === 'queue')
        return ['todoUndelegated', 'capacity-wait', 'orchestration', 'intervention'].includes(
          row.stage,
        );
      return ![
        'settled',
        'decision-wait',
        'running',
        'queued',
        'children-wait',
        'dependency-wait',
        'capacity-wait',
        'publication-wait',
      ].includes(row.stage);
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const scope = {
    agentId: query.agentId,
    boardId: query.boardId,
    tenant: query.tenant,
    includeArchived: query.includeArchived,
    view: query.view,
  };
  const membership = createHash('sha256')
    .update(JSON.stringify([scope, cards.map((card) => card.id)]))
    .digest('hex');
  if (query.membership && query.membership !== membership)
    throw new Error('Scan membership changed; restart at first page');
  const index = query.after ? cards.findIndex((card) => card.id === query.after) : -1;
  if (query.after && index < 0) throw new Error('Continuation card missing');
  const fields = [
    'id',
    'status',
    'priority',
    'title',
    'updatedAt',
    ...(query.view
      ? [
          'feature',
          'obligation',
          'delegated',
          'stage',
          'taskId',
          'workerState',
          'startedAt',
          'lastUpdate',
          'live',
          'deadline',
          'hasActiveRun',
          'controller',
          'backend',
          'runId',
          'childSessionKey',
          'wrapperTaskId',
        ]
      : []),
  ];
  const result = {
    source: 'workboard.cards.list',
    total: cards.length,
    membership,
    ...(query.view ? { capacity: workerCapacity(evidence) } : {}),
    hasMore: false,
    nextAfter: null,
    fields,
    cards: cards.slice(index + 1, index + 1 + PAGE_CANDIDATE_LIMIT).map((card) => [
      card.id,
      card.status,
      ['low', 'normal', 'high', 'urgent'].includes(card.priority) ? card.priority : 'normal',
      String(card.title ?? '')
        .replace(/[\x00-\x1f\x7f]/g, '')
        .slice(0, 32),
      card.updatedAt,
      ...(query.view ? Object.values(classifications.get(card.id)) : []),
    ]),
  };
  const continuation = () => {
    result.hasMore = index + 1 + result.cards.length < cards.length;
    result.nextAfter = result.hasMore ? (result.cards.at(-1)?.[0] ?? null) : null;
  };
  continuation();
  while (result.cards.length > 1 && Buffer.byteLength(JSON.stringify(result)) > PAGE_OUTPUT_BYTES) {
    result.cards.pop();
    continuation();
  }
  if (Buffer.byteLength(JSON.stringify(result)) > PAGE_OUTPUT_BYTES)
    throw new Error('Page output exceeds bound');
  return result;
}

export async function readView(query, rpc, records) {
  validateQuery(query);
  if (!records) throw new Error('Registered project records required');
  const response = await rpc(
    'workboard.cards.list',
    query.boardId ? { boardId: query.boardId } : {},
  );
  pageCards(
    response,
    { ...query, view: undefined, after: undefined, membership: undefined },
    records,
  );
  if (!query.view) return pageCards(response, query, records);
  const attempts = records.attempts.filter((attempt) => attempt.bound);
  const snapshot = await rpc('tasks.list', { status: ['queued', 'running'], limit: 100 });
  const tasks = new Map((snapshot.tasks ?? []).map((task) => [task.taskId, task]));
  await Promise.all(
    attempts
      .flatMap((attempt) => [attempt.task_id, attempt.wrapper_task_id])
      .filter(Boolean)
      .map(async (taskId) => {
        try {
          const value = await rpc('tasks.get', { taskId });
          if (value.task?.taskId === taskId) tasks.set(taskId, value.task);
        } catch {
          tasks.delete(taskId);
        }
      }),
  );
  const sessionKeys = [
    ...new Set(attempts.map((attempt) => attempt.child_session).filter(Boolean)),
  ];
  if (sessionKeys.length > 64) throw new Error('Current session reference bound exceeded');
  const sessions = [];
  for (const key of sessionKeys) {
    const result = await rpc('sessions.list', {
      agentId: topology().workerAgentId,
      search: key,
      limit: 10,
      archived: 'all',
    });
    if (result.hasMore) throw new Error('Exact live session search incomplete');
    const exact = result.sessions.filter((session) => session.key === key);
    if (exact.length > 1) throw new Error('Exact live session is ambiguous');
    sessions.push(...exact);
  }
  return pageCards(response, query, records, {
    available: !snapshot.nextCursor,
    capacityTasks: snapshot.tasks ?? [],
    tasks: [...tasks.values()],
    sessions,
  });
}
