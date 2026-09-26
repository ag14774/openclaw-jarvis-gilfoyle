import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { hash, text, conversation } from './store.js';
import {
  ensureCreatedCard,
  sealCreationPayload,
  createProductCard,
} from './helpers/create-card.js';
import { readView, pageCards } from './helpers/workboard-page.js';
import { finalizeFeature } from './helpers/finalize-feature.js';
import { handoffCard, assertCommentCapacity } from './helpers/handoff-card.js';
import { handoffMarker, controllerKey, currentAttempt } from './helpers/record-contracts.js';
import { topology, isProjectSessionKey, roleForAgent, agentForRole } from './topology.js';

const sourcePart = (value) =>
  String(value).replace(/[^A-Za-z0-9._:@+-]+/g, (s) =>
    encodeURIComponent(s).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    ),
  );
export const sourceString = (r) =>
  `channel=${sourcePart(r.channel)};account=${sourcePart(r.accountId)};recipient=${sourcePart(r.target)};thread=${sourcePart(r.threadId ?? 'none')}`;
export const isProjectSession = isProjectSessionKey;
const fallbackDestination = (value) => {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  const keys = Object.keys(value).sort().join(',');
  assert(
    ['accountId,channel,kind,to', 'accountId,channel,kind,threadId,to'].includes(keys),
    'Invalid fallback destination fields',
  );
  assert(value.kind === 'direct', 'Fallback destination must be direct');
  return {
    channel: text(value.channel, 60),
    accountId: text(value.accountId, 100),
    to: text(value.to, 240),
    kind: 'direct',
    ...(value.threadId ? { threadId: String(value.threadId) } : {}),
  };
};
const type = (c) => /^Type: ([a-z-]+)$/im.exec(c.notes ?? '')?.[1];
const field = (c, n) => new RegExp(`^${n}: (.+)$`, 'm').exec(c.notes ?? '')?.[1];
const quiet = new Set([
  'settled',
  'held',
  'awaiting-product-answer',
  'handoff-waiting-answer',
  'running',
  'queued',
  'children-wait',
  'dependency-wait',
  'parent-wait',
  'capacity-wait',
  'hosted-ci-wait',
]);
export const orderReady = (requests) =>
  [...requests].sort(
    (a, b) =>
      Number(b.ownsClaim) - Number(a.ownsClaim) ||
      (b.project.priority ?? 0) - (a.project.priority ?? 0) ||
      b.priority - a.priority ||
      a.created - b.created ||
      a.feature.localeCompare(b.feature),
  );
export class ProjectRuntime {
  constructor(
    store,
    rpc,
    { fallbackDestinations = {}, now = () => Date.now(), log = () => {} } = {},
  ) {
    this.store = store;
    this.rpc = rpc;
    this.fallbackDestinations = Object.fromEntries(
      Object.entries(fallbackDestinations).map(([role, value]) => {
        assert(['product', 'engineering'].includes(role), 'Invalid fallback role');
        return [role, fallbackDestination(value)];
      }),
    );
    this.now = now;
    this.log = log;
    this.busy = false;
    this.running = new Set();
    this.roleAdmission = new Set();
    this.stopped = false;
    this.health = { lastScan: null, lastDispatchFailure: null };
  }
  async conversations(agentId, query, channel) {
    const r = await this.rpc('conversations.list', {
      agentId,
      ...(query ? { query } : {}),
      ...(channel ? { channel } : {}),
      limit: 100,
    });
    assert(
      Array.isArray(r.conversations) && r.conversations.length < 100,
      'Conversation discovery incomplete; narrow the query',
    );
    return r.conversations;
  }
  async fallbackRoute(managerRole) {
    const destination = this.fallbackDestinations[managerRole];
    assert(destination, 'Fallback destination is not configured');
    const routes = await this.conversations(
      agentForRole(managerRole),
      destination.to,
      destination.channel,
    );
    const matches = routes.filter(
      (route) =>
        route.channel === destination.channel &&
        route.accountId === destination.accountId &&
        route.target === destination.to &&
        route.kind === destination.kind &&
        String(route.threadId ?? '') === String(destination.threadId ?? ''),
    );
    assert.equal(matches.length, 1, 'Fallback destination is unavailable or ambiguous');
    return conversation(matches[0]);
  }
  async route(agentId, ref) {
    const routes = await this.conversations(agentId, ref);
    const found = routes.filter((r) => r.conversationRef === ref);
    assert.equal(found.length, 1, 'Conversation not available for this manager');
    return conversation(found[0]);
  }
  visibleContext(agentId, ref) {
    const managerRole = roleForAgent(agentId);
    assert(managerRole, 'Manager role required');
    const seen = new Set(),
      messages = [];
    for (const d of this.store.all(
      "SELECT id,text,receipt,due FROM deliveries WHERE role=? AND status='sent' AND json_extract(route,'$.conversationRef')=? ORDER BY due DESC LIMIT 12",
      managerRole,
      ref,
    )) {
      const receipt = JSON.parse(d.receipt);
      if (!receipt.messageId || seen.has(receipt.messageId)) continue;
      seen.add(receipt.messageId);
      messages.push({ messageId: receipt.messageId, text: d.text, deliveryId: d.id });
      if (messages.length === 3) break;
    }
    return {
      messages,
      coverage:
        'Verified project deliveries only. Combine with native channel-visible dialogue; this is not complete channel history.',
    };
  }
  async current(ctx) {
    const saved = this.store.getSource(
      ctx.sourceToken ? `token:${ctx.sourceToken}` : ctx.sessionKey,
    );
    if (ctx.sourceToken)
      assert(
        saved?.sessionKey === ctx.sessionKey,
        'Source token belongs to a different conversation',
      );
    if (saved?.sourceToken)
      assert(
        ctx.sourceToken === saved.sourceToken,
        'Use the injected current-turn sourceToken; do not substitute the most recent queued message',
      );
    if (saved?.senderId && ctx.requesterSenderId && !saved.testing)
      assert.equal(
        String(saved.senderId),
        String(ctx.requesterSenderId),
        'Source token belongs to a different sender',
      );
    if (saved?.route)
      return {
        route: await this.route(ctx.agentId, saved.route.conversationRef),
        messageId: saved.messageId,
        senderId: saved.senderId,
        replyTo: saved.replyTo,
        sessionKey: ctx.sessionKey,
      };
    const d = ctx.deliveryContext ?? {};
    const channel = d.channel ?? ctx.messageChannel ?? saved?.raw?.channel;
    const normalize = (s) => {
      let v = String(s ?? '');
      if (v.startsWith(`${channel}:`)) v = v.slice(channel.length + 1);
      if (channel === 'discord') v = v.replace(/^(channel|user):/, '');
      return v.replace(/:topic:.+$/, '');
    };
    const target = d.to ?? ctx.nativeChannelId ?? saved?.raw?.conversationId;
    const routes = await this.conversations(ctx.agentId, normalize(target));
    const matches = routes.filter(
      (r) =>
        r.channel === channel &&
        r.accountId === (d.accountId ?? ctx.agentAccountId ?? saved?.raw?.accountId ?? 'default') &&
        normalize(r.target) === normalize(target) &&
        String(r.threadId ?? '') === String(d.threadId ?? saved?.raw?.threadId ?? ''),
    );
    assert.equal(
      matches.length,
      1,
      'Current channel route unavailable; use an explicit native conversation reference',
    );
    return {
      route: conversation(matches[0]),
      messageId: saved?.messageId,
      senderId: ctx.requesterSenderId,
      sessionKey: ctx.sessionKey,
    };
  }
  async cards(project) {
    let result = [];
    for (const board of project.boards) {
      const r = await this.rpc('workboard.cards.list', { boardId: board.id });
      pageCards(r, { boardId: board.id, includeArchived: true });
      result.push(...r.cards);
    }
    return result;
  }
  milestoneCandidates(p, cards, includeTerminal = false) {
    if (p.state !== 'active' && !includeTerminal) return [];
    const candidates = [];
    for (const f of cards.filter(
      (c) =>
        type(c) === 'feature' &&
        (includeTerminal || c.status !== 'done') &&
        !c.metadata?.archivedAt,
    )) {
      const children = cards.filter(
        (c) => c.metadata?.automation?.tenant === f.id && type(c) === 'work-item',
      );
      const started = children
        .filter((c) => !c.labels?.includes('review') && currentAttempt(c)?.taskId)
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (started) {
        const a = currentAttempt(started);
        candidates.push({
          event: `start:${f.id}`,
          featureId: f.id,
          kind: 'engineering-start',
          created: started.createdAt,
          evidence: { workItem: started.id, taskId: a.taskId, runId: a.runId },
          terminal: f.status === 'done',
        });
      }
      for (const review of children.filter(
        (c) => c.status === 'done' && c.labels?.includes('review'),
      )) {
        const proof = review.metadata?.proof?.find(
          (p) =>
            p.status === 'passed' &&
            p.label === 'Independent review' &&
            /^Candidate: [0-9a-f]{40}(?:$|\n|\. )/.test(p.note ?? ''),
        );
        if (proof) {
          const candidate = proof.note.slice(11, 51);
          candidates.push({
            event: `review:${f.id}:${candidate}`,
            featureId: f.id,
            kind: 'review-passed',
            created: proof.createdAt ?? review.updatedAt,
            evidence: { workItem: review.id, candidate, proofId: proof.id },
            terminal: f.status === 'done',
          });
        }
      }
    }
    return [...new Map(candidates.map((c) => [c.event, c])).values()].filter(
      (c) =>
        !this.store.get(
          'SELECT key FROM receipts WHERE key=?',
          `milestone-decision:${p.id}:${c.event}`,
        ),
    );
  }
  async summary(id) {
    const p = this.store.project(id),
      cards = await this.cards(p);
    return {
      id: p.id,
      name: p.name,
      purpose: p.purpose,
      context: p.context,
      state: p.state,
      revision: p.revision,
      priority: p.priority,
      productConversation: p.productConversation,
      engineeringConversation: p.engineeringConversation,
      repositories: p.boards.map((b) => ({
        ...b,
        metadata:
          cards.find((c) => type(c) === 'project-info' && c.metadata.automation.boardId === b.id)
            ?.notes ?? null,
      })),
      features: cards
        .filter((c) => type(c) === 'feature')
        .map((c) => ({
          id: c.id,
          title: c.title,
          status: c.status,
          boardId: c.metadata.automation.boardId,
          scope: field(c, 'Scope'),
          authorization:
            'This is an accepted request. Its current scope, stops and handoffs govern execution; declaration-time brainstorming language is historical.',
          outcome: c.metadata.automation.summary ?? null,
          notification:
            this.store.get(
              'SELECT id,event,status FROM deliveries WHERE project=? AND event=? AND role=?',
              id,
              `result:${c.id}`,
              'product',
            ) ?? null,
        })),
      decisions: cards
        .filter(
          (c) =>
            handoffMarker(c) &&
            !['applied', 'resolved-internally'].includes(handoffMarker(c).phase),
        )
        .map((c) => ({
          id: c.id,
          checkpoint: handoffMarker(c),
          question: JSON.parse(
            c.metadata.comments.find((m) => m.id === handoffMarker(c).question)?.body ?? '{}',
          ).data?.question,
          reason: JSON.parse(
            c.metadata.comments.find((m) => m.id === handoffMarker(c).question)?.body ?? '{}',
          ).data?.reason,
          suggestedResolution: JSON.parse(
            c.metadata.comments.find((m) => m.id === handoffMarker(c).question)?.body ?? '{}',
          ).data?.resolution,
        })),
      nextSteps: cards.some((c) => handoffMarker(c)?.phase === 'sent')
        ? 'Await the outstanding product answer, then resume the same Feature.'
        : cards.some((c) => type(c) === 'feature' && c.status !== 'done')
          ? 'Continue the accepted Feature through its current native checkpoint.'
          : 'Discuss the next desired outcome; no unrequested implementation.',
      schedules: this.store.all(
        'SELECT id,next,intervalMs,enabled FROM schedules WHERE project=?',
        id,
      ),
      pendingNotifications: this.store.all(
        "SELECT id,event,status FROM deliveries WHERE project=? AND status NOT IN ('sent','cancelled','fallback-sent')",
        id,
      ),
      communicationIntents: this.store
        .all(
          "SELECT id,event,scope,kind,facts,status FROM communication_intents WHERE project=? AND status='pending' ORDER BY created",
          id,
        )
        .map((intent) => ({ ...intent, facts: JSON.parse(intent.facts) })),
      milestoneCandidates: this.milestoneCandidates(p, cards),
    };
  }
  async inventory(id) {
    const p = this.store.project(id),
      cards = await this.cards(p);
    return {
      revision: p.revision,
      cards: cards
        .filter((c) => type(c) !== 'project-info' && c.status !== 'done' && !c.metadata?.archivedAt)
        .map((c) => ({
          id: c.id,
          title: c.title,
          status: c.status,
          feature: type(c) === 'feature' ? c.id : c.metadata.automation.tenant,
        })),
      notifications: this.store.all(
        "SELECT id,event,status FROM deliveries WHERE project=? AND status NOT IN ('sent','cancelled','fallback-sent')",
        id,
      ),
      communicationIntents: this.store.all(
        "SELECT id,event,scope,kind,status FROM communication_intents WHERE project=? AND status='pending'",
        id,
      ),
      schedules: this.store.all(
        'SELECT id,next,intervalMs FROM schedules WHERE project=? AND enabled=1',
        id,
      ),
    };
  }
  async hasActiveExecution(p, cards) {
    if (cards.some((c) => c.metadata?.claim)) return true;
    for (const c of cards.filter((c) => c.status !== 'done' && type(c) === 'work-item')) {
      const a = currentAttempt(c);
      if (!a) continue;
      if (a.uncertain || !a.taskId) return true;
      const t = (await this.rpc('tasks.get', { taskId: a.taskId })).task;
      if (
        !t ||
        !['completed', 'succeeded', 'failed', 'lost', 'timed_out', 'cancelled'].includes(t.status)
      )
        return true;
      const sessions = await this.rpc('sessions.list', {
        agentId: topology().workerAgentId,
        search: a.childSessionKey,
        archived: 'all',
        limit: 10,
      });
      if (
        sessions.hasMore ||
        sessions.sessions.length !== 1 ||
        sessions.sessions[0].hasActiveRun !== false
      )
        return true;
    }
    for (const e of this.store.all(
      'SELECT * FROM exchanges WHERE project=? AND closed IS NULL',
      p.id,
    )) {
      const s = await this.rpc('sessions.list', {
        agentId: agentForRole(e.role),
        search: e.session,
        archived: 'all',
        limit: 10,
      });
      if (s.hasMore || s.sessions.some((s) => s.key === e.session && s.hasActiveRun)) return true;
    }
    return false;
  }
  async createBoard(id, name) {
    const listed = await this.rpc('workboard.boards.list', {});
    if (!listed.boards.some((b) => b.id === id))
      await this.rpc('workboard.boards.upsert', { id, name });
  }
  async intake(p, input, source) {
    const { engineeringAgentId } = topology();
    p = this.store.project(p.id);
    assert(
      p.state === 'active',
      'Project is inactive or draining; explicit reactivation is required',
    );
    assert(source.messageId, 'Actual source message identity required');
    text(input.title, 180);
    text(input.scope, 1400);
    if (!p.boards.length) {
      const board = `jg-${p.id}`;
      await this.createBoard(board, p.name);
      this.store.attach(p.id, board);
      p = this.store.project(p.id);
    }
    let boards = input.boards ?? (p.boards.length === 1 ? [p.boards[0].id] : []);
    assert(
      boards.length > 0 && boards.length <= 8 && new Set(boards).size === boards.length,
      'Clarify intended repository scope',
    );
    const features = [];
    for (const boardId of boards) {
      const b = p.boards.find((b) => b.id === boardId);
      assert(b, 'Repository is not associated with project');
      assert(this.store.project(p.id).state === 'active', 'Project became inactive during intake');
      const sourceKey = hash([source.route, source.messageId]).slice(0, 40),
        delivery = sourceString(source.route);
      const expected = sealCreationPayload({
        boardId,
        tenant: boardId,
        idempotencyKey: `feature:${boardId}:source-${sourceKey}`,
        title: input.title,
        agentId: engineeringAgentId,
        status: 'todo',
        priority: 'normal',
        labels: ['type:feature'],
        workspace: { kind: 'scratch' },
        maxRuntimeSeconds: 1,
        maxRetries: 1,
        notes: `Type: feature\nRequest: source-${sourceKey}\nSource message: ${source.messageId}\nScope: ${input.scope}\nDelivery: ${delivery}\nDelivery source: ${delivery}\nProject identity: ${p.id}\nRepository scope: ${b.repository ? 'selected' : 'pending'}`,
      });
      const result = await ensureCreatedCard(expected, this.rpc);
      features.push(result.card.id);
      this.store.exchange(p.id, result.card.id, 'engineering');
    }
    return {
      durable: true,
      features,
      acknowledgementReady: true,
      engineeringStarted: false,
      replyInCurrentConversation: true,
    };
  }
  async operation(operation, input, ctx = {}) {
    const { productAgentId, engineeringAgentId } = topology();
    ctx = { ...ctx, sourceToken: input.sourceToken };
    const agentId = ctx.agentId ?? productAgentId,
      managerRole = roleForAgent(agentId);
    assert(managerRole, 'Manager role required');
    const internal = Boolean(ctx.operator || isProjectSession(ctx.sessionKey));
    const p = input.projectId ? this.store.project(input.projectId) : null;
    const exchange =
      !ctx.operator && isProjectSession(ctx.sessionKey)
        ? this.store.get('SELECT * FROM exchanges WHERE session=?', ctx.sessionKey)
        : null;
    if (!ctx.operator && isProjectSession(ctx.sessionKey))
      assert(exchange, 'Registered purpose context required');
    if (exchange && p)
      assert.equal(p.id, exchange.project, 'Internal context cannot cross project boundaries');
    if (operation === 'list')
      return this.store
        .list()
        .filter((p) => !exchange || p.id === exchange.project)
        .map((p) => ({
          id: p.id,
          name: p.name,
          purpose: p.purpose,
          state: p.state,
          revision: p.revision,
          repositories: p.boards,
        }));
    if (operation === 'conversations') return this.conversations(agentId, input.query);
    if (operation === 'current') return this.current(ctx);
    if (operation === 'visible-context') {
      await this.route(agentId, input.conversationRef);
      return this.visibleContext(agentId, input.conversationRef);
    }
    if (operation === 'summary') return this.summary(p.id);
    if (operation === 'inventory') return this.inventory(p.id);
    if (operation === 'guard') {
      assert(p.state !== 'inactive', 'Project inactive');
      return { active: true, state: p.state };
    }
    if (operation === 'declare') {
      assert(agentId === productAgentId, 'Project declaration belongs to the product agent');
      assert(input.explicit === true, 'User must explicitly declare a project');
      const source = ctx.operator && input.source ? input.source : await this.current(ctx);
      assert(source.messageId, 'Actual declaration message identity required');
      const r = input.conversationRef
        ? await this.route(productAgentId, input.conversationRef)
        : source.route;
      const productFallback = await this.fallbackRoute('product'),
        engineeringFallback = await this.fallbackRoute('engineering');
      const created = this.store.declare({
        key: hash([source.route, source.messageId]),
        name: input.name,
        purpose: input.purpose,
        route: r,
        productFallback,
        engineeringFallback,
      });
      return this.summary(created.id);
    }
    if (operation === 'move') {
      assert(input.explicit === true, 'Only explicit user intent changes a preferred conversation');
      const source = ctx.operator && input.source ? input.source : await this.current(ctx);
      assert(source.messageId, 'Actual move message required');
      const route = input.conversationRef
        ? await this.route(agentId, input.conversationRef)
        : source.route;
      this.store.move({
        key: hash([source.route, source.messageId, managerRole]),
        id: p.id,
        managerRole,
        route,
        revision: input.revision,
      });
      return {
        ...(await this.summary(p.id)),
        confirmInNewConversation: true,
        continuityFields: ['purpose', 'repositories', 'features', 'decisions', 'nextSteps'],
      };
    }
    if (operation === 'context') {
      assert(agentId === productAgentId, 'Product context belongs to the product agent');
      return this.store.context(p.id, input.context, input.revision);
    }
    if (operation === 'priority') {
      assert(
        agentId === productAgentId &&
          Number.isSafeInteger(input.priority) &&
          Math.abs(input.priority) <= 100,
      );
      this.store.run(
        'UPDATE projects SET priority=?,revision=revision+1 WHERE id=?',
        input.priority,
        p.id,
      );
      return this.store.project(p.id);
    }
    if (operation === 'associate') {
      assert(input.explicit === true, 'Explicit repository association required');
      const info = input.repository;
      assert(info && typeof info.repository === 'string', 'Repository setup fields required');
      const existing = p.boards.find((b) => b.repository === info.repository),
        empty = p.boards.find((b) => !b.repository);
      const boardId =
        existing?.id ?? empty?.id ?? `jg-${hash([p.id, info.repository]).slice(0, 32)}`;
      await this.createBoard(boardId, `${p.name} repository`);
      const result = await createProductCard('project-info', { ...info, boardId }, this.rpc);
      this.store.attach(p.id, boardId, info.repository);
      return { boardId, project: await this.summary(p.id), metadataId: result.card.id };
    }
    if (operation === 'intake') {
      assert(
        agentId === productAgentId && input.implementationIntent === true,
        'Only explicit implementation intent through the product agent starts work',
      );
      const source = ctx.operator && input.source ? input.source : await this.current(ctx);
      const r = await this.intake(p, input, source);
      this.requestTick();
      return r;
    }
    if (operation === 'notify') {
      assert(internal, 'Proactive notification composition belongs to an internal purpose context');
      assert(
        agentId === productAgentId,
        'Normal project notifications belong to the product agent',
      );
      if (exchange)
        assert(
          String(input.event).split(':').includes(exchange.scope),
          'Notification event belongs to another topic',
        );
      const prior = this.store.get(
        'SELECT * FROM deliveries WHERE project=? AND event=? AND role=?',
        p.id,
        input.event,
        'product',
      );
      const d =
        prior ??
        this.store.enqueue({
          project: p.id,
          event: input.event,
          kind: input.kind ?? 'milestone',
          message: text(input.message, 6000),
          due: this.now() + (input.kind === 'milestone' ? 45000 : 0),
        });
      this.requestTick();
      return {
        durable: true,
        id: d.id,
        status: d.status,
        reused: Boolean(prior),
        retainedMessage: d.text,
        receipt: d.receipt ? JSON.parse(d.receipt) : null,
      };
    }
    if (operation === 'communication-decision') {
      assert(
        agentId === productAgentId && internal && typeof input.notify === 'boolean',
        'The product agent decides project communication',
      );
      const intent = this.store.get(
        'SELECT * FROM communication_intents WHERE project=? AND event=?',
        p.id,
        input.event,
      );
      assert(intent, 'Unknown communication intent');
      if (exchange)
        assert.equal(intent.scope, exchange.scope, 'Communication belongs to another topic');
      if (intent.status !== 'pending')
        return {
          event: intent.event,
          status: intent.status,
          delivery: this.store.get(
            'SELECT id,status FROM deliveries WHERE project=? AND event=? AND role=?',
            p.id,
            intent.event,
            'product',
          ),
        };
      const delivery = input.notify
        ? this.store.enqueue({
            project: p.id,
            event: intent.event,
            kind: intent.kind,
            message: text(input.message, 6000),
          })
        : null;
      this.store.run(
        'UPDATE communication_intents SET status=?,reason=?,updated=? WHERE id=?',
        input.notify ? 'composed' : 'dismissed',
        text(input.reason ?? 'Jarvis communication judgment', 1000),
        this.now(),
        intent.id,
      );
      this.requestTick();
      return {
        event: intent.event,
        status: input.notify ? 'composed' : 'dismissed',
        deliveryId: delivery?.id ?? null,
      };
    }
    if (operation === 'milestone-decision') {
      assert(
        agentId === productAgentId && internal && typeof input.notify === 'boolean',
        'The product agent decides milestone visibility',
      );
      const key = `milestone-decision:${p.id}:${input.event}`,
        old = this.store.get('SELECT result FROM receipts WHERE key=?', key);
      if (old) return JSON.parse(old.result);
      const candidate = this.milestoneCandidates(p, await this.cards(p), true).find(
        (c) => c.event === input.event,
      );
      assert(candidate, 'Native milestone evidence required');
      if (exchange)
        assert.equal(candidate.featureId, exchange.scope, 'Milestone belongs to another topic');
      const shouldNotify = input.notify && !candidate.terminal && p.state === 'active';
      const prior = this.store.get(
        'SELECT * FROM deliveries WHERE project=? AND event=? AND role=?',
        p.id,
        input.event,
        'product',
      );
      const delivery =
        prior ??
        (shouldNotify
          ? this.store.enqueue({
              project: p.id,
              event: input.event,
              kind: 'milestone',
              message: text(input.message, 6000),
              due: this.now() + 45000,
            })
          : null);
      const result = {
        event: input.event,
        notified: Boolean(delivery),
        deliveryId: delivery?.id ?? null,
        reason: prior
          ? 'retained prior notification'
          : candidate.terminal
            ? 'superseded by terminal result'
            : text(input.reason ?? 'Jarvis milestone judgment', 1000),
      };
      this.store.once(key, { event: input.event, evidence: candidate.evidence }, () => result);
      this.requestTick();
      return result;
    }
    if (operation === 'delivery') {
      const d = this.store.get('SELECT * FROM deliveries WHERE project=? AND id=?', p.id, input.id);
      assert(d);
      const actual =
        d.status === 'fallback-sent'
          ? this.store.get(
              'SELECT * FROM deliveries WHERE project=? AND event=?',
              p.id,
              `fallback:${d.id}`,
            )
          : d;
      return {
        ...d,
        delivered: actual?.status === 'sent',
        receipt: actual?.receipt ? JSON.parse(actual.receipt) : null,
        actualRoute: actual?.route ? JSON.parse(actual.route) : null,
      };
    }
    if (operation === 'also-notify') {
      assert(input.explicit === true, 'Additional copies need explicit event-scoped request');
      const source = ctx.operator && input.source ? input.source : await this.current(ctx);
      const r = input.conversationRef
        ? await this.route(agentId, input.conversationRef)
        : source.route;
      const result = this.store.copy({
        project: p.id,
        event: input.event,
        managerRole,
        route: r,
        recurring: input.recurring ?? false,
      });
      const prior = this.store.get(
        "SELECT * FROM deliveries WHERE project=? AND event=? AND role=? AND status='sent'",
        p.id,
        input.event,
        'product',
      );
      if (prior) await this.processCopies(prior);
      this.requestTick();
      return result;
    }
    if (operation === 'question-delivery') {
      assert(agentId === productAgentId && internal);
      const cards = await this.cards(p),
        c = cards.find((c) => c.id === input.cardId),
        h = c && handoffMarker(c);
      assert(h && !h.uncertain);
      if (exchange)
        assert(
          c.id === exchange.scope || c.metadata?.automation?.tenant === exchange.scope,
          'Question belongs to another topic',
        );
      const existing = this.store.get(
        'SELECT * FROM deliveries WHERE project=? AND event=? AND role=?',
        p.id,
        `question:${h.checkpoint}`,
        'product',
      );
      const d =
        existing ??
        this.store.enqueue({
          project: p.id,
          event: `question:${h.checkpoint}`,
          kind: 'question',
          message: text(input.message, 6000),
        });
      await this.deliver(d);
      const sent = this.store.get('SELECT * FROM deliveries WHERE id=?', d.id);
      const actual =
        sent.status === 'fallback-sent'
          ? this.store.get(
              'SELECT * FROM deliveries WHERE project=? AND event=?',
              p.id,
              `fallback:${sent.id}`,
            )
          : sent;
      if (actual?.status === 'sent') {
        const receipt = JSON.parse(actual.receipt);
        await handoffCard(
          'handoff-receipt',
          {
            boardId: c.metadata.automation.boardId,
            id: c.id,
            checkpoint: h.checkpoint,
            actor: ctx.sessionKey,
            delivery: 'sent',
            channel: sourceString(JSON.parse(actual.route)),
            message: receipt.messageId,
          },
          this.rpc,
        );
      }
      return { status: sent.status, deliveryId: d.id };
    }
    if (operation === 'answer') {
      assert(
        agentId === productAgentId && input.correlated === true,
        'Clarify ambiguous answers before recording',
      );
      const source = ctx.operator && input.source ? input.source : await this.current(ctx);
      assert(source.messageId, 'Actual user answer message required');
      const cards = await this.cards(p),
        c = cards.find((c) => c.id === input.cardId),
        h = c && handoffMarker(c);
      assert(
        h && !h.uncertain && h.checkpoint === input.checkpoint,
        'Exact open question required',
      );
      const receipt = JSON.parse(
        c.metadata.comments.find((x) => x.id === h.receipt)?.body ?? '{}',
      ).data;
      assert(receipt?.delivery === 'sent');
      const result = await handoffCard(
        'handoff-correlated-answer',
        {
          boardId: c.metadata.automation.boardId,
          id: c.id,
          checkpoint: h.checkpoint,
          actor: ctx.sessionKey ?? `agent:${productAgentId}:main`,
          channel: sourceString(source.route),
          questionMessage: receipt.message,
          message: String(source.messageId),
          answer: text(input.answer, 1400),
        },
        this.rpc,
      );
      this.store.run(
        'UPDATE exchanges SET attempts=0,lastDispatch=0 WHERE project=? AND closed IS NULL',
        p.id,
      );
      this.requestTick();
      return result;
    }
    if (operation === 'schedule') {
      assert(
        agentId === productAgentId && input.implementationIntent === true,
        'Schedule requires explicit work authorization',
      );
      assert(p.state === 'active', 'Reactivate project before new scheduled work');
      const spec = {
        title: text(input.title, 180),
        scope: text(input.scope, 1400),
        boards: input.boards ?? p.boards.map((b) => b.id),
      };
      assert(spec.boards.length && spec.boards.every((id) => p.boards.some((b) => b.id === id)));
      return this.store.schedule({
        project: p.id,
        spec,
        next: input.next,
        intervalMs: input.intervalMs ?? null,
      });
    }
    if (operation === 'schedule-disable') {
      const s = this.store.get('SELECT * FROM schedules WHERE id=? AND project=?', input.id, p.id);
      assert(s);
      this.store.run('UPDATE schedules SET enabled=0 WHERE id=?', s.id);
      return { disabled: true };
    }
    if (operation === 'inactivate') {
      assert(
        agentId === productAgentId && input.confirmed === true,
        'Discuss each unfinished obligation before inactivation',
      );
      const inventory = await this.inventory(p.id);
      assert.equal(input.revision, inventory.revision, 'Project changed; show refreshed inventory');
      const expected = [
        ...inventory.cards,
        ...inventory.notifications,
        ...inventory.communicationIntents,
        ...inventory.schedules,
      ]
        .map((x) => x.id)
        .sort();
      const choices = input.dispositions ?? {};
      assert.deepEqual(
        Object.keys(choices).sort(),
        expected,
        'Every unfinished card, delivery and schedule needs an explicit disposition',
      );
      assert(
        Object.values(choices).every((c) => ['finish', 'stop', 'pending'].includes(c)),
        'Disposition must be finish, stop, or pending',
      );
      for (const item of inventory.cards.filter((x) => choices[x.id] === 'stop')) {
        const all = await this.cards(p),
          feature = all.find((c) => c.id === item.feature);
        if (feature && feature.status !== 'done')
          await createProductCard(
            'stop',
            {
              boardId: feature.metadata.automation.boardId,
              featureId: feature.id,
              title: 'Stop before project inactivation',
              reason: 'Explicit user stop disposition before inactivation',
            },
            this.rpc,
          );
      }
      // Active execution cannot be parked: finish/stop must first reconcile through Gilfoyle.
      const cards = await this.cards(p);
      const live = await this.hasActiveExecution(p, cards);
      const drain =
        live ||
        inventory.cards.some((c) => choices[c.id] !== 'pending') ||
        inventory.notifications.some((n) => choices[n.id] === 'finish') ||
        inventory.communicationIntents.some((intent) => choices[intent.id] === 'finish');
      for (const n of inventory.notifications.filter((n) => choices[n.id] === 'stop')) {
        const d = this.store.get('SELECT * FROM deliveries WHERE id=?', n.id);
        assert(!d.route, 'In-flight delivery must reconcile before cancellation');
        this.store.run("UPDATE deliveries SET status='cancelled' WHERE id=?", n.id);
      }
      for (const intent of inventory.communicationIntents.filter(
        (intent) => choices[intent.id] === 'stop',
      ))
        this.store.run(
          "UPDATE communication_intents SET status='dismissed',reason=?,updated=? WHERE id=?",
          'Explicit user stop disposition before inactivation',
          this.now(),
          intent.id,
        );
      for (const s of inventory.schedules.filter((s) => choices[s.id] === 'stop'))
        this.store.run('UPDATE schedules SET enabled=0 WHERE id=?', s.id);
      const updated = this.store.run(
        'UPDATE projects SET state=?,revision=revision+1 WHERE id=? AND revision=?',
        drain ? 'draining' : 'inactive',
        p.id,
        input.revision,
      );
      assert.equal(updated.changes, 1, 'Project changed; show refreshed inventory');
      this.store.run(
        'INSERT OR REPLACE INTO receipts VALUES(?,?,?,?)',
        `inactivate:${p.id}`,
        hash(choices),
        JSON.stringify(choices),
        this.now(),
      );
      this.requestTick();
      return { state: drain ? 'draining' : 'inactive', inventory };
    }
    if (operation === 'reactivate') {
      assert(
        agentId === productAgentId && input.explicit === true,
        'Explicit reactivation required',
      );
      const result = this.store.reactivate(p.id, this.now());
      this.requestTick();
      return result;
    }
    if (operation === 'recover') {
      assert(
        agentId === productAgentId && p.state !== 'inactive',
        'Recovery cannot reactivate an inactive project',
      );
      this.store.run('UPDATE exchanges SET attempts=0,lastDispatch=0 WHERE project=?', p.id);
      this.requestTick();
      return { reconciliationRequested: true, executionRestarted: false };
    }
    if (operation === 'conclude') {
      assert(internal);
      const e = this.store.get('SELECT * FROM exchanges WHERE session=?', ctx.sessionKey);
      assert(e && e.project === p.id);
      text(input.conclusion, 2000);
      this.store.once(
        `conclusion:${e.id}:${hash(input.conclusion).slice(0, 24)}`,
        { scope: e.scope, role: e.role, conclusion: input.conclusion },
        () => ({ scope: e.scope, role: e.role, conclusion: input.conclusion }),
      );
      this.store.run('UPDATE exchanges SET conclusion=? WHERE id=?', input.conclusion, e.id);
      return { durable: true, cleanup: 'after native obligations settle' };
    }
    throw new Error('Unknown project operation');
  }
  requestTick() {
    if (!this.stopped)
      setTimeout(
        () =>
          this.tick().catch(() => this.log('Project scan failed; durable obligations retained')),
        100,
      ).unref();
  }
  async deliver(d) {
    const { productAgentId } = topology();
    const p = this.store.project(d.project);
    if (
      p.state === 'inactive' ||
      ['sent', 'cancelled', 'fallback-sent', 'batched'].includes(d.status) ||
      d.due > this.now()
    )
      return;
    // Resolve at the first real send, never at Feature creation or event enqueue.
    let route = d.route
      ? JSON.parse(d.route)
      : d.role === 'product'
        ? p.productConversation
        : p.engineeringConversation;
    assert(route, 'Notification route missing');
    if (!d.route) {
      this.store.run(
        'UPDATE deliveries SET route=?,status=? WHERE id=? AND route IS NULL',
        JSON.stringify(route),
        'sending',
        d.id,
      );
      d = this.store.get('SELECT * FROM deliveries WHERE id=?', d.id);
      route = JSON.parse(d.route);
    }
    let receipt;
    try {
      receipt = await this.rpc('conversations.send', {
        agentId: agentForRole(d.role),
        operationId: `jarvis-gilfoyle-${d.id}`,
        conversationRef: route.conversationRef,
        message: d.text,
      });
      assert(
        ['sent', 'queued', 'suppressed', 'unknown'].includes(receipt.status),
        'Unrecognized native delivery state',
      );
    } catch {
      await this.failure(d, 'Preferred conversation delivery failed or could not be reconciled');
      return;
    }
    this.store.run(
      'UPDATE deliveries SET status=?,receipt=?,attempts=attempts+1,error=NULL,due=? WHERE id=?',
      receipt.status,
      JSON.stringify(receipt),
      this.now() + 60000,
      d.id,
    );
    if (receipt.status === 'sent') {
      const members = this.store.all(
        "SELECT * FROM deliveries WHERE project=? AND status='batched' AND receipt=?",
        p.id,
        JSON.stringify({ batch: d.id }),
      );
      for (const member of members)
        this.store.run(
          "UPDATE deliveries SET status='sent',receipt=?,route=? WHERE id=?",
          JSON.stringify(receipt),
          JSON.stringify(route),
          member.id,
        );
      for (const member of [d, ...members])
        await this.processCopies(member).catch(() =>
          this.log('Additional notification enqueue pending; original delivery is already sent'),
        );
    } else if (receipt.status === 'suppressed')
      await this.failure(d, 'Preferred conversation rejected delivery');
  }
  async processCopies(d) {
    if (d.role !== 'product' || ['copy', 'fallback'].includes(d.kind)) return;
    const events = [d.event];
    if (d.event.startsWith('result:')) {
      const cards = await this.cards(this.store.project(d.project)),
        f = cards.find((c) => c.id === d.event.slice(7)),
        source = f && field(f, 'Source message'),
        match = /^([0-9a-f-]{36})-[0-9]+$/.exec(source ?? '');
      if (
        match &&
        this.store.get('SELECT id FROM schedules WHERE id=? AND project=?', match[1], d.project)
      )
        events.push(`schedule:${match[1]}:result`);
    }
    for (const copy of this.store
      .all('SELECT * FROM copies WHERE project=? AND (consumed IS NULL OR recurring=1)', d.project)
      .filter((c) => events.includes(c.event))) {
      const event = copy.recurring ? `copy:${copy.id}:${d.id}` : `copy:${copy.id}`;
      const extra = this.store.enqueue({
        project: d.project,
        event,
        kind: 'copy',
        managerRole: copy.role,
        message: d.text,
        route: JSON.parse(copy.route),
      });
      if (!copy.recurring)
        this.store.run('UPDATE copies SET consumed=? WHERE id=?', extra.id, copy.id);
    }
    this.store.run(
      'INSERT OR REPLACE INTO receipts VALUES(?,?,?,?)',
      `copies:${d.id}`,
      hash(d.text),
      JSON.stringify({ complete: true }),
      this.now(),
    );
  }
  async settleNotice(d) {
    const { productAgentId } = topology();
    if (
      d.role !== 'product' ||
      !d.event.startsWith('result:') ||
      !['sent', 'fallback-sent'].includes(d.status)
    )
      return;
    const p = this.store.project(d.project),
      cards = await this.cards(p),
      feature = cards.find((c) => c.id === d.event.slice(7));
    assert(
      feature?.status === 'done' &&
        typeof feature.metadata?.automation?.summary === 'string' &&
        feature.metadata.automation.summary.trim() &&
        feature.metadata?.proof?.some((p) => p.status === 'passed'),
      'Terminal Feature proof required',
    );
    const notices = cards.filter(
      (c) => c.metadata?.automation?.idempotencyKey === `action:${feature.id}:owner-notification`,
    );
    assert.equal(notices.length, 1, 'Canonical notification required');
    let notice = notices[0];
    assert(
      notice.agentId === productAgentId &&
        notice.metadata.automation.tenant === feature.id &&
        field(notice, 'Feature') === feature.id &&
        type(notice) === 'action' &&
        !notice.metadata?.archivedAt,
      'Notification identity mismatch',
    );
    const actual =
      d.status === 'fallback-sent'
        ? this.store.get(
            'SELECT * FROM deliveries WHERE project=? AND event=?',
            p.id,
            `fallback:${d.id}`,
          )
        : d;
    const receipt = JSON.parse(actual.receipt),
      route = JSON.parse(actual.route);
    assert(
      receipt.status === 'sent' &&
        receipt.messageId &&
        receipt.conversationRef === route.conversationRef,
      'Actual sent native receipt required',
    );
    const summary = `Native delivery receipt recorded: ${receipt.messageId}.`;
    const note = `Native ${receipt.channel ?? route.channel} receipt messageId: ${receipt.messageId}; conversation: ${route.conversationRef}; delivery: ${d.id}; event: ${d.event}.${d.status === 'fallback-sent' ? ' Preferred route failed; actual fallback receipt retained.' : ''}`;
    const proof = { status: 'passed', label: 'Native project notification receipt', note };
    const priorFailures = notice.metadata.failureCount;
    if (notice.status !== 'done') {
      assert((notice.metadata.proof ?? []).length < 40, 'Proof capacity exhausted');
      assertCommentCapacity(notice, [summary, note]);
      if (!notice.metadata.claim) {
        await this.rpc('workboard.cards.claim', {
          id: notice.id,
          ownerId: productAgentId,
          ttlSeconds: 60,
        });
        notice = (await this.cards(p)).find((c) => c.id === notice.id);
      }
      assert(
        notice.metadata?.claim?.ownerId === productAgentId,
        'Notification claim belongs to another owner',
      );
      await this.rpc('workboard.cards.complete', { id: notice.id, summary, proof });
    } else if (!notice.metadata.proof?.some((p) => p.status === 'passed' && p.note === note)) {
      assert((notice.metadata.proof ?? []).length < 40, 'Proof capacity exhausted');
      assertCommentCapacity(notice, [note]);
      await this.rpc('workboard.cards.proof', { id: notice.id, ...proof });
    }
    notice = (await this.cards(p)).find((c) => c.id === notice.id);
    const metadata = {};
    if (notice.metadata.automation.summary !== summary) metadata.automation = { summary };
    if (priorFailures !== undefined && notice.metadata.failureCount !== priorFailures)
      metadata.failureCount = priorFailures;
    if (Object.keys(metadata).length)
      await this.rpc('workboard.cards.update', {
        id: notice.id,
        expectedUpdatedAt: notice.updatedAt,
        patch: { metadata },
      });
    const settled = (await this.cards(p)).find((c) => c.id === notice.id);
    assert(
      settled.status === 'done' &&
        settled.metadata.automation.summary === summary &&
        settled.metadata.proof.some((p) => p.note === note && p.status === 'passed'),
      'Receipt-backed settlement readback failed',
    );
    this.store.run(
      'INSERT OR REPLACE INTO receipts VALUES(?,?,?,?)',
      `settled:${d.id}`,
      hash([feature.id, notice.id, receipt.messageId]),
      JSON.stringify({ noticeId: notice.id }),
      this.now(),
    );
  }
  batchMilestones(p) {
    const pending = this.store.all(
      "SELECT * FROM deliveries WHERE project=? AND role=? AND kind IN ('milestone','result') AND status='pending' AND route IS NULL ORDER BY created",
      p.id,
      'product',
    );
    if (
      pending.length < 2 ||
      !pending.some((d) => d.kind === 'milestone') ||
      !pending.some((d) => d.due <= this.now())
    )
      return;
    let length = 0;
    const batch = pending.filter((d) => {
      if (length + d.text.length + 2 > 5800) return false;
      length += d.text.length + 2;
      return true;
    });
    if (batch.length < 2) return;
    this.store.tx(() => {
      const leader = this.store.enqueue({
        project: p.id,
        event: `milestones:${hash(batch.map((d) => d.id)).slice(0, 32)}`,
        kind: 'milestone-batch',
        message: batch.map((d) => d.text).join('\n\n'),
      });
      for (const d of batch)
        this.store.run(
          "UPDATE deliveries SET status='batched',receipt=? WHERE id=?",
          JSON.stringify({ batch: leader.id }),
          d.id,
        );
    });
  }
  async failure(d, error) {
    const attempts = d.attempts + 1;
    this.store.run(
      "UPDATE deliveries SET status='retry',attempts=?,error=?,due=? WHERE id=?",
      attempts,
      error,
      this.now() + 60000,
      d.id,
    );
    if (attempts < 3) return;
    const p = this.store.project(d.project);
    if (d.kind === 'fallback') {
      this.log('Owner fallback is unavailable; delivery remains durable');
      return;
    }
    let route;
    try {
      route = await this.fallbackRoute(d.role);
    } catch {
      this.log('Role fallback is unavailable or ambiguous; delivery remains durable');
      return;
    }
    const column = d.role === 'product' ? 'product_fallback' : 'engineering_fallback';
    this.store.run(`UPDATE projects SET ${column}=? WHERE id=?`, JSON.stringify(route), p.id);
    const fallback = this.store.enqueue({
      project: p.id,
      event: `fallback:${d.id}`,
      kind: 'fallback',
      managerRole: d.role,
      message: d.text,
      route,
    });
    await this.deliver(fallback);
    const sent = this.store.get('SELECT status FROM deliveries WHERE id=?', fallback.id);
    if (sent.status === 'sent') {
      this.store.run("UPDATE deliveries SET status='fallback-sent' WHERE id=?", d.id);
      await this.processCopies(d).catch(() =>
        this.log('Additional notification remains pending after fallback'),
      );
    }
  }
  async runSchedules(p) {
    if (p.state !== 'active') return;
    for (const s of this.store.all(
      'SELECT * FROM schedules WHERE project=? AND enabled=1 AND next<=? ORDER BY next LIMIT 8',
      p.id,
      this.now(),
    )) {
      const spec = JSON.parse(s.spec),
        occurrence = `${s.id}-${s.next}`;
      await this.intake(p, spec, {
        route: { channel: 'schedule', accountId: 'project', target: p.id },
        messageId: occurrence,
      });
      this.store.run(
        'UPDATE schedules SET next=?,enabled=? WHERE id=? AND next=?',
        s.intervalMs
          ? s.next + (Math.floor((this.now() - s.next) / s.intervalMs) + 1) * s.intervalMs
          : s.next,
        s.intervalMs ? 1 : 0,
        s.id,
        s.next,
      );
    }
  }
  async dispatch(project, scope, managerRole, cardIds, attention = {}) {
    if (this.roleAdmission.has(managerRole)) return;
    this.roleAdmission.add(managerRole);
    const before = this.store.exchange(project.id, scope, managerRole),
      agentId = agentForRole(managerRole);
    this.running.add(before.session);
    try {
      return await this.dispatchAttempt(project, scope, managerRole, cardIds, attention);
    } catch (error) {
      this.health.lastDispatchFailure = {
        project: project.id,
        scope,
        agentId,
        at: this.now(),
        code: error.code ?? error.name,
      };
      const current = this.store.get('SELECT * FROM exchanges WHERE id=?', before.id);
      if (current.lastDispatch === before.lastDispatch)
        this.store.run(
          'UPDATE exchanges SET attempts=attempts+1,lastDispatch=? WHERE id=?',
          this.now(),
          before.id,
        );
      const failed = this.store.get('SELECT * FROM exchanges WHERE id=?', before.id);
      if (failed.attempts >= 3 && managerRole === 'engineering') {
        this.store.requestCommunication({
          project: project.id,
          event: `coordination:${failed.id}:${String(failed.observed ?? 'unknown').slice(0, 16)}`,
          kind: 'blocker',
          scope,
          facts: {
            condition: 'coordination-stalled',
            managerRole,
            attemptsAtLeast: 3,
            obligationRetained: true,
            replacementAuthorized: false,
          },
        });
        this.requestTick();
      }
      throw error;
    } finally {
      this.running.delete(before.session);
      this.roleAdmission.delete(managerRole);
    }
  }
  async dispatchAttempt(project, scope, managerRole, cardIds, attention = {}) {
    const agentId = agentForRole(managerRole);
    if (this.store.project(project.id).state === 'inactive') return;
    let e = this.store.exchange(project.id, scope, managerRole);
    const cards = await this.cards(project),
      observed = hash([
        ...cards
          .filter((c) => c.id === scope || c.metadata?.automation?.tenant === scope)
          .map((c) => [
            c.id,
            c.status,
            c.agentId,
            c.notes,
            c.metadata?.automation?.summary,
            c.metadata?.proof,
          ]),
        ...(managerRole === 'product'
          ? this.store
              .all(
                "SELECT event,kind,facts,status FROM communication_intents WHERE project=? AND scope=? AND status='pending' ORDER BY created",
                project.id,
                scope,
              )
              .map((intent) => [intent.event, intent.kind, intent.facts, intent.status])
          : []),
      ]);
    if (e.observed !== observed) {
      this.store.run(
        'UPDATE exchanges SET attempts=0,lastDispatch=0,observed=? WHERE id=?',
        observed,
        e.id,
      );
      e = this.store.get('SELECT * FROM exchanges WHERE id=?', e.id);
    }
    if (e.closed || this.now() - e.lastDispatch < 120000) return;
    if (e.attempts >= 3) {
      if (
        managerRole === 'engineering' &&
        !this.store.get(
          "SELECT id FROM communication_intents WHERE project=? AND scope=? AND status='pending' LIMIT 1",
          project.id,
          scope,
        )
      )
        this.store.requestCommunication({
          project: project.id,
          event: `coordination:${e.id}:${e.observed.slice(0, 16)}`,
          kind: 'blocker',
          scope,
          facts: {
            condition: 'coordination-stalled',
            managerRole,
            attemptsAtLeast: 3,
            obligationRetained: true,
            replacementAuthorized: false,
          },
        });
      if (this.now() - e.lastDispatch < 1800000) return;
      this.store.run('UPDATE exchanges SET attempts=0 WHERE id=?', e.id);
    }
    const sessions = await this.rpc('sessions.list', { agentId, limit: 500 });
    assert(!sessions.hasMore, 'Manager activity enumeration incomplete');
    if (
      sessions.sessions.some(
        (s) =>
          isProjectSession(s.key) &&
          (s.status === 'queued' || (s.status === 'running' && s.hasActiveRun)),
      )
    )
      return;
    const native = await this.rpc('workboard.cards.list', {});
    pageCards(native, { agentId, includeArchived: true });
    if (
      native.cards.some(
        (c) =>
          c.agentId === agentId &&
          c.metadata?.claim &&
          c.metadata.claim.expiresAt > this.now() &&
          controllerKey(native.cards, c, agentId) !== e.session,
      )
    )
      return;
    await this.rpc('sessions.create', {
      key: e.session,
      agentId,
      label: `Jarvis-Gilfoyle ${agentId} ${scope}`,
      category: 'project-internal',
    });
    if (this.store.project(project.id).state === 'inactive') return;
    const runId = randomUUID();
    this.store.run(
      'UPDATE exchanges SET runId=?,attempts=attempts+1,lastDispatch=? WHERE id=?',
      runId,
      this.now(),
      e.id,
    );
    let nativeReferences = [];
    if (
      cards.some(
        (c) =>
          c.metadata?.automation?.tenant === scope &&
          type(c) === 'work-item' &&
          c.notes?.includes('<!-- current-attempt -->') &&
          !currentAttempt(c)?.taskId,
      )
    ) {
      const candidates = await this.rpc('tasks.list', {
        sessionKey: e.session,
        sortBy: 'updatedAt',
        limit: 100,
      });
      nativeReferences = candidates.tasks
        .filter((t) => ['acp', 'subagent'].includes(t.runtime))
        .slice(0, 40)
        .map((t) => ({
          taskId: t.taskId,
          runtime: t.runtime,
          runId: t.runId,
          childSessionKey: t.childSessionKey,
          status: t.status,
        }));
    }
    this.running.add(e.session);
    try {
      await this.rpc('agent', {
        agentId,
        sessionKey: e.session,
        deliver: false,
        idempotencyKey: runId,
        timeout: 600,
        message: `PROJECT CONTINUATION\nProject: ${project.id}\nScope: ${scope}\nRelevant records: ${cardIds.join(', ')}\nAttention classifications: ${JSON.stringify(attention)}\nFeature scope: ${field(cards.find((c) => c.id === scope) ?? {}, 'Scope') ?? 'Read the scoped durable records.'}\nBounded native execution references: ${JSON.stringify(nativeReferences)}\nLoad jarvis-gilfoyle-protocol, read jarvis_project summary and the scoped native records, then perform the next safe action. Attention classifications are diagnostics, not authorization. This is an internal context, not a user chat. Preserve accepted evidence, use the product agent for user communication, record a durable conclusion, and end with NO_REPLY.`,
      });
      if (this.health.lastDispatchFailure?.scope === scope) this.health.lastDispatchFailure = null;
    } finally {
      this.running.delete(e.session);
    }
  }
  async cleanup(p, cards) {
    for (const e of this.store.all(
      'SELECT * FROM exchanges WHERE project=? AND closed IS NULL',
      p.id,
    )) {
      const scoped = cards.filter(
        (c) => c.id === e.scope || c.metadata?.automation?.tenant === e.scope,
      );
      const concludedCheckpoint =
        Boolean(e.conclusion) &&
        !scoped.some((c) => c.metadata?.claim) &&
        !(await this.hasActiveExecution(p, scoped));
      if (
        !scoped.length ||
        (!concludedCheckpoint && scoped.some((c) => c.status !== 'done')) ||
        this.running.has(e.session)
      )
        continue;
      const sessions = await this.rpc('sessions.list', {
        agentId: agentForRole(e.role),
        search: e.session,
        archived: 'all',
        limit: 10,
      });
      assert(!sessions.hasMore);
      const s = sessions.sessions.find((s) => s.key === e.session);
      if (s?.hasActiveRun || s?.hasActiveSubagentRun) continue;
      const conclusion =
        e.conclusion ??
        scoped
          .filter((c) => type(c) === 'feature')
          .map((c) => c.metadata.automation.summary)
          .join('\n');
      if (!conclusion) continue;
      this.store.run('UPDATE exchanges SET conclusion=? WHERE id=?', conclusion, e.id);
      const cleanupKey = `cleanup:${e.id}`;
      if (s) {
        const result = await this.rpc('jarvis-gilfoyle.session.cleanup', {
          agentId: agentForRole(e.role),
          sessionNamespace: topology().sessionNamespace,
          sessionKey: e.session,
          projectId: p.id,
          expectedSessionId: s.sessionId,
        });
        assert.equal(
          result.archivedTranscriptArtifacts,
          0,
          'Temporary context cleanup must not archive transcripts',
        );
      }
      const exported = this.store.get('SELECT * FROM receipts WHERE key=?', cleanupKey);
      if (exported) {
        // Native deletion exports a recovery transcript. This purpose context has
        // durable conclusions, so remove only the exact returned manager exports.
        // Worker/reviewer sessions and their evidence are never targeted.
        for (const path of JSON.parse(exported.result)) {
          assert(
            new RegExp(
              `/agents/${agentForRole(e.role)}/sessions/[0-9a-f-]{36}\\.jsonl\\.deleted\\.[A-Za-z0-9.:_-]+$`,
            ).test(path),
            'Unexpected native transcript export path',
          );
          await unlink(path).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
        this.store.run('DELETE FROM receipts WHERE key=?', cleanupKey);
      }
      this.store.run('UPDATE exchanges SET closed=? WHERE id=?', this.now(), e.id);
    }
  }
  async tick() {
    const { productAgentId, engineeringAgentId } = topology();
    if (this.busy || this.stopped) return { skipped: true, stopped: this.stopped };
    this.busy = true;
    const scan = { at: this.now(), complete: true, checked: [], errors: [] },
      dispatches = [];
    try {
      this.store.run('DELETE FROM sources WHERE updated<?', this.now() - 30 * 24 * 60 * 60 * 1000);
      for (const p of this.store.list()) {
        if (p.state === 'inactive') continue;
        scan.checked.push(p.id);
        try {
          await this.runSchedules(p);
          this.batchMilestones(p);
          for (const d of this.store.all(
            "SELECT * FROM deliveries WHERE project=? AND status NOT IN ('sent','cancelled','fallback-sent','batched') AND due<=? ORDER BY created LIMIT 20",
            p.id,
            this.now(),
          ))
            await this.deliver(d);
          for (const d of this.store.all(
            "SELECT d.* FROM deliveries d WHERE project=? AND role=? AND status IN ('sent','fallback-sent') AND kind NOT IN ('copy','fallback') AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.key='copies:'||d.id) ORDER BY created LIMIT 20",
            p.id,
            'product',
          ))
            await this.processCopies(d);
          for (const d of this.store.all(
            "SELECT d.* FROM deliveries d WHERE project=? AND role=? AND event LIKE 'result:%' AND status IN ('sent','fallback-sent') AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.key='settled:'||d.id) ORDER BY created LIMIT 20",
            p.id,
            'product',
          ))
            await this.settleNotice(d);
          const cards = await this.cards(p),
            ready = [];
          for (const intent of this.store.all(
            "SELECT * FROM communication_intents WHERE project=? AND status='pending' ORDER BY created",
            p.id,
          ))
            ready.push({
              feature: intent.scope,
              managerRole: 'product',
              agentId: productAgentId,
              id: `communication:${intent.id}`,
              created: intent.created,
              priority: 1000,
              ownsClaim: false,
              stage: 'communication-intent',
            });
          for (const milestone of this.milestoneCandidates(p, cards))
            ready.push({
              feature: milestone.featureId,
              managerRole: 'product',
              agentId: productAgentId,
              id: milestone.featureId,
              created: milestone.created,
              priority: 0,
              ownsClaim: false,
              stage: 'milestone-decision',
            });
          for (const board of p.boards) {
            for (const [managerRole, agentId] of [
              ['product', productAgentId],
              ['engineering', engineeringAgentId],
            ]) {
              let q = { agentId, boardId: board.id, includeArchived: false, view: 'attention' },
                pages = 0;
              do {
                const r = await readView(q, this.rpc);
                for (const row of r.cards) {
                  const item = Object.fromEntries(r.fields.map((k, i) => [k, row[i]]));
                  const c = cards.find((c) => c.id === item.id);
                  if (!c || type(c) === 'project-info' || quiet.has(item.stage)) continue;
                  if (
                    managerRole === 'engineering' &&
                    item.stage === 'notification-repair' &&
                    type(c) === 'feature' &&
                    c.status === 'done' &&
                    typeof c.metadata?.automation?.summary === 'string' &&
                    c.metadata.proof?.some((proof) => proof.status === 'passed')
                  ) {
                    await finalizeFeature(
                      {
                        boardId: board.id,
                        id: c.id,
                        summary: c.metadata.automation.summary,
                        evidence:
                          'Retained terminal outcome and passed Feature proof verified for notification repair.',
                      },
                      this.rpc,
                    );
                    continue;
                  }
                  const feature = type(c) === 'feature' ? c.id : c.metadata.automation.tenant;
                  const parent = cards.find((c) => c.id === feature);
                  if (!parent) continue;
                  ready.push({
                    feature,
                    managerRole,
                    agentId,
                    id: c.id,
                    created: c.createdAt,
                    priority: c.priority === 'urgent' ? 1000 : 0,
                    ownsClaim: Boolean(c.metadata?.claim),
                    stage: item.stage,
                  });
                }
                q = r.hasMore ? { ...q, after: r.nextAfter, membership: r.membership } : null;
                if (++pages > 64) throw Error('Bounded board scan incomplete');
              } while (q);
            }
          }
          if (p.state === 'draining') {
            const choices = JSON.parse(
              this.store.get('SELECT result FROM receipts WHERE key=?', `inactivate:${p.id}`)
                ?.result ?? '{}',
            );
            const unfinished = cards.filter(
              (c) => choices[c.id] && choices[c.id] !== 'pending' && c.status !== 'done',
            );
            const finishIntentEvents = new Set(
              this.store
                .all('SELECT id,event FROM communication_intents WHERE project=?', p.id)
                .filter((intent) => choices[intent.id] === 'finish')
                .map((intent) => intent.event),
            );
            const notices = this.store
              .all(
                "SELECT * FROM deliveries WHERE project=? AND status NOT IN ('sent','cancelled','fallback-sent')",
                p.id,
              )
              .filter((d) => choices[d.id] === 'finish' || finishIntentEvents.has(d.event));
            const intents = this.store
              .all("SELECT * FROM communication_intents WHERE project=? AND status='pending'", p.id)
              .filter((intent) => choices[intent.id] === 'finish');
            if (
              !unfinished.length &&
              !notices.length &&
              !intents.length &&
              !(await this.hasActiveExecution(p, cards))
            ) {
              this.store.run(
                "UPDATE projects SET state='inactive',revision=revision+1 WHERE id=?",
                p.id,
              );
              continue;
            }
            for (let i = ready.length - 1; i >= 0; i--)
              if (choices[ready[i].id] === 'pending' && choices[ready[i].feature] === 'pending')
                ready.splice(i, 1);
          }
          ready.sort((a, b) => b.priority - a.priority || a.created - b.created);
          const groups = new Map();
          for (const r of ready) {
            const k = `${r.managerRole}:${r.feature}`;
            if (!groups.has(k)) groups.set(k, { ...r, ids: [], attention: {} });
            if (!groups.get(k).ids.includes(r.id)) groups.get(k).ids.push(r.id);
            groups.get(k).attention[r.id] = r.stage;
            groups.get(k).ownsClaim ||= r.ownsClaim;
          }
          // Native one-owner claim and two-child capacity still govern engineering.
          // Collect across projects before admission: project age must not outrank
          // the age of a ready obligation in another project.
          for (const g of groups.values()) {
            const e = this.store.get(
                'SELECT * FROM exchanges WHERE project=? AND scope=? AND role=?',
                p.id,
                g.feature,
                g.managerRole,
              ),
              observed = hash([
                ...cards
                  .filter((c) => c.id === g.feature || c.metadata?.automation?.tenant === g.feature)
                  .map((c) => [
                    c.id,
                    c.status,
                    c.agentId,
                    c.notes,
                    c.metadata?.automation?.summary,
                    c.metadata?.proof,
                  ]),
                ...(g.managerRole === 'product'
                  ? this.store
                      .all(
                        "SELECT event,kind,facts,status FROM communication_intents WHERE project=? AND scope=? AND status='pending' ORDER BY created",
                        p.id,
                        g.feature,
                      )
                      .map((intent) => [intent.event, intent.kind, intent.facts, intent.status])
                  : []),
              ]);
            if (e?.observed === observed) {
              if (this.now() - e.lastDispatch < 120000) continue;
              if (e.attempts >= 3 && this.now() - e.lastDispatch < 1800000) {
                if (
                  g.managerRole === 'engineering' &&
                  !this.store.get(
                    "SELECT id FROM communication_intents WHERE project=? AND scope=? AND status='pending' LIMIT 1",
                    p.id,
                    g.feature,
                  )
                )
                  this.store.requestCommunication({
                    project: p.id,
                    event: `coordination:${e.id}:${e.observed.slice(0, 16)}`,
                    kind: 'blocker',
                    scope: g.feature,
                    facts: {
                      condition: 'coordination-stalled',
                      managerRole: g.managerRole,
                      attemptsAtLeast: 3,
                      obligationRetained: true,
                      replacementAuthorized: false,
                    },
                  });
                continue;
              }
            }
            dispatches.push({ ...g, project: p });
          }
          await this.cleanup(p, cards);
        } catch (error) {
          scan.complete = false;
          scan.errors.push({ project: p.id, code: error.code ?? error.name });
          this.log(`Project ${p.id} reconciliation incomplete; retained for next scan`);
        }
      }
      const used = new Set();
      for (const g of orderReady(dispatches)) {
        if (used.has(g.managerRole)) continue;
        used.add(g.managerRole);
        this.dispatch(g.project, g.feature, g.managerRole, g.ids, g.attention).catch(() =>
          this.log('Internal continuation failed; retry remains durable'),
        );
      }
      return scan;
    } finally {
      this.busy = false;
      this.health.lastScan = scan;
    }
  }
}
