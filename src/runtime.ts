import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { conversation, hash, text } from './store.js';
import { createFeatureCard, ensureNativeCard } from './helpers/create-card.js';
import { pageCards, readView } from './helpers/workboard-page.js';
import { amendFeature } from './helpers/amend-feature.js';
import { reconcileExecutionBindings } from './helpers/execution-bindings.js';
import { projectAnsweredDecision, scopedDecision } from './helpers/handoff-card.js';
import { topology, isProjectSessionKey, roleForAgent, agentForRole } from './topology.js';

const terminal = new Set(['completed', 'succeeded', 'failed', 'lost', 'timed_out', 'cancelled']);
const quiet = new Set([
  'settled',
  'decision-wait',
  'running',
  'queued',
  'children-wait',
  'dependency-wait',
  'capacity-wait',
  'publication-wait',
]);
const productOperations = new Set([
  'declare',
  'context',
  'priority',
  'associate',
  'intake',
  'amend',
  'control',
  'notify',
  'communication-decision',
  'milestone-decision',
  'also-notify',
  'question-delivery',
  'answer',
  'schedule',
  'schedule-disable',
  'inactivate',
  'reactivate',
]);
const mainConversationOperations = new Set([
  'declare',
  'move',
  'context',
  'priority',
  'associate',
  'intake',
  'schedule',
  'schedule-disable',
  'inactivate',
  'reactivate',
]);
const sourcePart = (value) =>
  String(value).replace(/[^A-Za-z0-9._:@+-]+/g, (part) =>
    encodeURIComponent(part).replace(
      /[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    ),
  );
export const sourceString = (route) =>
  `channel=${sourcePart(route.channel)};account=${sourcePart(route.accountId)};recipient=${sourcePart(route.target)};thread=${sourcePart(route.threadId ?? 'none')}`;
export const isProjectSession = isProjectSessionKey;
export const orderReady = (requests) =>
  [...requests].sort(
    (a, b) =>
      Number(b.ownsClaim) - Number(a.ownsClaim) ||
      (b.project.priority ?? 0) - (a.project.priority ?? 0) ||
      b.priority - a.priority ||
      a.created - b.created ||
      a.feature.localeCompare(b.feature),
  );

const fallbackDestination = (value) => {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert(value.kind === 'direct', 'Fallback destination must be direct');
  return {
    channel: text(value.channel, 60),
    accountId: text(value.accountId, 100),
    to: text(value.to, 240),
    kind: 'direct',
    ...(value.threadId ? { threadId: String(value.threadId) } : {}),
  };
};

export class ProjectRuntime {
  constructor(
    store,
    rpc,
    { fallbackDestinations = {}, now = () => Date.now(), log = () => {} } = {},
  ) {
    this.store = store;
    this.rpc = rpc;
    this.fallbackDestinations = Object.fromEntries(
      Object.entries(fallbackDestinations).map(([managerRole, value]) => [
        managerRole,
        fallbackDestination(value),
      ]),
    );
    this.now = now;
    this.log = log;
    this.busy = false;
    this.running = new Set();
    this.roleAdmission = new Set();
    this.stopped = false;
    this.health = { lastScan: null, lastDispatchFailure: null, bindingDiagnostics: [] };
  }
  async conversations(agentId, query, channel) {
    const result = await this.rpc('conversations.list', {
      agentId,
      ...(query ? { query } : {}),
      ...(channel ? { channel } : {}),
      limit: 100,
    });
    assert(Array.isArray(result.conversations) && result.conversations.length < 100);
    return result.conversations;
  }
  async fallbackRoute(managerRole) {
    const destination = this.fallbackDestinations[managerRole];
    assert(destination, 'Fallback destination is not configured');
    const matches = (
      await this.conversations(agentForRole(managerRole), destination.to, destination.channel)
    ).filter(
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
    const matches = (await this.conversations(agentId, ref)).filter(
      (route) => route.conversationRef === ref,
    );
    assert.equal(matches.length, 1, 'Conversation not available for this manager');
    return conversation(matches[0]);
  }
  visibleContext(agentId, ref) {
    const managerRole = roleForAgent(agentId);
    assert(managerRole);
    return {
      messages: this.store
        .all(
          "SELECT id,text,receipt FROM deliveries WHERE role=? AND status='sent' AND json_extract(route,'$.conversationRef')=? ORDER BY due DESC LIMIT 3",
          managerRole,
          ref,
        )
        .flatMap((delivery) => {
          const receipt = JSON.parse(delivery.receipt);
          return receipt.messageId
            ? [{ messageId: receipt.messageId, text: delivery.text, deliveryId: delivery.id }]
            : [];
        }),
      coverage:
        'Verified project deliveries only; native conversation history remains authoritative.',
    };
  }
  async current(ctx) {
    const saved = this.store.getSource(
      ctx.sourceToken ? `token:${ctx.sourceToken}` : ctx.sessionKey,
    );
    if (ctx.sourceToken)
      assert(saved?.sessionKey === ctx.sessionKey, 'Source token belongs to another conversation');
    if (saved?.sourceToken)
      assert.equal(ctx.sourceToken, saved.sourceToken, 'Use the current-turn sourceToken');
    if (saved?.route)
      return {
        route: await this.route(ctx.agentId, saved.route.conversationRef),
        messageId: saved.messageId,
        senderId: saved.senderId,
        replyTo: saved.replyTo,
        sessionKey: ctx.sessionKey,
      };
    const delivery = ctx.deliveryContext ?? {};
    const channel = delivery.channel ?? ctx.messageChannel ?? saved?.raw?.channel;
    const target = delivery.to ?? ctx.nativeChannelId ?? saved?.raw?.conversationId;
    const matches = (await this.conversations(ctx.agentId, target)).filter(
      (route) =>
        route.channel === channel &&
        route.accountId ===
          (delivery.accountId ?? ctx.agentAccountId ?? saved?.raw?.accountId ?? 'default') &&
        route.target === target &&
        String(route.threadId ?? '') === String(delivery.threadId ?? saved?.raw?.threadId ?? ''),
    );
    assert.equal(matches.length, 1, 'Current channel route unavailable');
    return {
      route: conversation(matches[0]),
      messageId: saved?.messageId,
      senderId: ctx.requesterSenderId,
      sessionKey: ctx.sessionKey,
    };
  }
  async cards(project) {
    const cards = [];
    for (const board of project.boards) {
      const response = await this.rpc('workboard.cards.list', { boardId: board.id });
      pageCards(response, { boardId: board.id, includeArchived: true });
      cards.push(...response.cards);
    }
    return cards;
  }
  registryContext(projectId, boardId) {
    const project = this.store.project(projectId);
    const board = project.boards.find((candidate) => candidate.id === boardId);
    assert(board, 'Board belongs to another project');
    return { store: this.store, project: project.id, repository: board.metadata };
  }
  async summary(id) {
    const project = this.store.project(id);
    const records = this.store.records(id);
    const cards = await this.cards(project);
    const byId = new Map(cards.map((card) => [card.id, card]));
    return {
      id: project.id,
      name: project.name,
      purpose: project.purpose,
      context: project.context,
      state: project.state,
      revision: project.revision,
      priority: project.priority,
      productConversation: project.productConversation,
      engineeringConversation: project.engineeringConversation,
      repositories: project.boards,
      requests: records.requests.map((request) => ({
        id: request.id,
        title: request.title,
        scope: request.scope,
        features: records.features
          .filter((feature) => feature.request === request.id)
          .map((feature) => feature.id),
      })),
      features: records.features.map((feature) => {
        const card = byId.get(feature.card);
        return {
          id: feature.id,
          cardId: feature.card,
          requestId: feature.request,
          boardId: feature.board,
          scope: feature.scope,
          scopeRevision: feature.scope_revision,
          title: card?.title ?? null,
          status: card?.status ?? 'missing',
          outcome: card?.metadata?.automation?.summary ?? null,
          notification:
            this.store.get(
              'SELECT id,event,status FROM deliveries WHERE project=? AND event=? AND role=?',
              id,
              `result:${feature.id}`,
              'product',
            ) ?? null,
        };
      }),
      decisions: records.decisions.filter((decision) => decision.phase !== 'applied'),
      controls: records.controls.filter((control) => control.state === 'pending'),
      publications: records.publications,
      openRecords: records.obligations.flatMap((obligation) => {
        const card = byId.get(obligation.card);
        return card && card.status !== 'done'
          ? [
              {
                id: obligation.id,
                cardId: card.id,
                title: card.title,
                owner: card.agentId,
                status: card.status,
              },
            ]
          : [];
      }),
      schedules: this.store.all(
        'SELECT id,next,intervalMs,enabled FROM schedules WHERE project=?',
        id,
      ),
      pendingNotifications: this.store.all(
        "SELECT id,event,status FROM deliveries WHERE project=? AND status NOT IN ('sent','cancelled','fallback-sent')",
        id,
      ),
      bindingDiagnostics: this.health.bindingDiagnostics.filter(
        (diagnostic) => diagnostic.project === id,
      ),
    };
  }
  async inventory(id) {
    const project = this.store.project(id);
    const records = this.store.records(id);
    const cards = new Map((await this.cards(project)).map((card) => [card.id, card]));
    return {
      revision: project.revision,
      obligations: records.obligations.flatMap((obligation) => {
        const card = cards.get(obligation.card);
        return !card || card.status !== 'done'
          ? [
              {
                id: `obligation:${obligation.id}`,
                recordId: obligation.id,
                cardId: card?.id ?? null,
                status: card?.status ?? 'projection-pending',
                feature: obligation.feature,
              },
            ]
          : [];
      }),
      controls: records.controls
        .filter((control) => control.state === 'pending')
        .map((control) => ({ ...control, recordId: control.id, id: `control:${control.id}` })),
      notifications: this.store
        .all(
          "SELECT id,event,status FROM deliveries WHERE project=? AND kind<>'milestone-batch' AND status NOT IN ('sent','cancelled','fallback-sent')",
          id,
        )
        .map((delivery) => ({
          ...delivery,
          recordId: delivery.id,
          id: `delivery:${delivery.id}`,
        })),
      communicationIntents: this.store
        .all(
          "SELECT id,event,scope,kind,status FROM communication_intents WHERE project=? AND status='pending'",
          id,
        )
        .map((intent) => ({
          ...intent,
          recordId: intent.id,
          id: `communication:${intent.id}`,
        })),
      schedules: this.store
        .all('SELECT id,next,intervalMs FROM schedules WHERE project=? AND enabled=1', id)
        .map((schedule) => ({
          ...schedule,
          recordId: schedule.id,
          id: `schedule:${schedule.id}`,
        })),
    };
  }
  async hasActiveExecution(project) {
    const records = this.store.records(project.id);
    for (const attempt of records.attempts.filter((row) => row.bound)) {
      const task = (await this.rpc('tasks.get', { taskId: attempt.task_id })).task;
      if (!task || !terminal.has(task.status)) return true;
      const sessions = await this.rpc('sessions.list', {
        agentId: topology().workerAgentId,
        search: attempt.child_session,
        archived: 'all',
        limit: 10,
      });
      if (
        sessions.hasMore ||
        sessions.sessions.some(
          (session) => session.key === attempt.child_session && session.hasActiveRun,
        )
      )
        return true;
    }
    return false;
  }
  async createBoard(id, name) {
    const response = await this.rpc('workboard.boards.list', {});
    if (!response.boards.some((board) => board.id === id))
      await this.rpc('workboard.boards.upsert', { id, name });
  }
  async reconcileRegistryProjections(project) {
    const diagnostics = [];
    const allowed = (obligation) => {
      if (project.state !== 'draining') return true;
      return (
        this.store.get(
          'SELECT disposition FROM inactivation_plans WHERE project=? AND kind=? AND item=?',
          project.id,
          'obligation',
          obligation,
        )?.disposition === 'finish'
      );
    };
    for (const feature of this.store.all(
      'SELECT * FROM features WHERE project=? AND card IS NULL ORDER BY created',
      project.id,
    )) {
      if (!allowed(feature.id)) continue;
      try {
        const result = await ensureNativeCard(JSON.parse(feature.creation_payload), this.rpc);
        this.store.bindFeatureCard(feature.id, result.card.id);
      } catch (error) {
        diagnostics.push({
          type: 'feature-creation',
          id: feature.id,
          error: String(error.message),
        });
      }
    }
    for (const obligation of this.store.all(
      "SELECT o.* FROM obligations o JOIN features f ON f.id=o.feature WHERE f.project=? AND o.card IS NULL AND o.kind<>'feature' ORDER BY o.created",
      project.id,
    )) {
      if (!allowed(obligation.id)) continue;
      try {
        const feature = this.store.feature(obligation.feature);
        assert(feature.card, 'Feature projection must bind before child obligation');
        const result = await ensureNativeCard(JSON.parse(obligation.creation_payload), this.rpc);
        this.store.bindObligationCard(obligation.id, result.card.id);
      } catch (error) {
        diagnostics.push({
          type: 'obligation-creation',
          id: obligation.id,
          error: String(error.message),
        });
      }
    }
    for (const revision of this.store.all(
      'SELECT r.*,f.board,f.card FROM feature_scope_revisions r JOIN features f ON f.id=r.feature WHERE f.project=? AND r.projected IS NULL AND f.card IS NOT NULL ORDER BY r.created',
      project.id,
    )) {
      if (!allowed(revision.feature)) continue;
      try {
        let response = await this.rpc('workboard.cards.list', { boardId: revision.board });
        let card = response.cards?.find((candidate) => candidate.id === revision.card);
        assert(card && !card.metadata?.archivedAt, 'Feature scope projection card missing');
        if (card.notes !== revision.scope) {
          await this.rpc('workboard.cards.update', {
            id: card.id,
            expectedUpdatedAt: card.updatedAt,
            patch: { notes: revision.scope },
          });
          response = await this.rpc('workboard.cards.list', { boardId: revision.board });
          card = response.cards?.find((candidate) => candidate.id === revision.card);
          assert.equal(card?.notes, revision.scope, 'Feature scope projection not confirmed');
        }
        this.store.markFeatureRevisionProjected(revision.feature, revision.revision);
      } catch (error) {
        diagnostics.push({
          type: 'feature-scope',
          id: `${revision.feature}:${revision.revision}`,
          error: String(error.message),
        });
      }
    }
    this.health.projectionDiagnostics = [
      ...(this.health.projectionDiagnostics ?? []).filter(
        (diagnostic) => diagnostic.project !== project.id,
      ),
      ...diagnostics.map((diagnostic) => ({ project: project.id, ...diagnostic })),
    ];
    return diagnostics;
  }
  async intake(project, input, source) {
    project = this.store.project(project.id);
    let drainingSchedule = null;
    if (project.state === 'draining' && source.route?.channel === 'schedule') {
      const match = /^([0-9a-f-]{36})-[0-9]+$/.exec(String(source.messageId ?? ''));
      drainingSchedule =
        match &&
        this.store.get(
          'SELECT * FROM inactivation_plans WHERE project=? AND kind=? AND item=? AND disposition=?',
          project.id,
          'schedule',
          match[1],
          'finish',
        );
    }
    assert(project.state === 'active' || drainingSchedule, 'Project is inactive or draining');
    assert(source.messageId, 'Actual source message identity required');
    if (!project.boards.length) {
      const board = `jg-${project.id}`;
      await this.createBoard(board, project.name);
      this.store.attach(project.id, board);
      project = this.store.project(project.id);
    }
    const boards = input.boards ?? (project.boards.length === 1 ? [project.boards[0].id] : []);
    assert(
      boards.length > 0 && boards.length <= 8 && new Set(boards).size === boards.length,
      'Clarify intended repository scope',
    );
    const request = this.store.createRequest({
      project: project.id,
      source: { route: source.route, messageId: source.messageId },
      title: input.title,
      scope: input.scope,
      requestKey: input.requestKey ?? null,
    });
    const features = [];
    for (const boardId of boards) {
      const board = project.boards.find((candidate) => candidate.id === boardId);
      assert(board, 'Repository is not associated with project');
      const result = await createFeatureCard(
        { boardId, title: input.title, scope: input.scope },
        this.rpc,
        { store: this.store, project: project.id, request: request.id },
      );
      features.push(result.featureId);
      this.store.exchange(project.id, result.featureId, 'engineering');
    }
    return {
      durable: true,
      requestId: request.id,
      features,
      acknowledgementReady: true,
      engineeringStarted: false,
      replyInCurrentConversation: true,
    };
  }
  async operation(operation, input, ctx = {}) {
    const { productAgentId } = topology();
    ctx = { ...ctx, sourceToken: input.sourceToken };
    const agentId = ctx.agentId ?? productAgentId;
    const managerRole = roleForAgent(agentId);
    assert(managerRole, 'Manager role required');
    const internal = Boolean(ctx.operator || isProjectSession(ctx.sessionKey));
    const project = input.projectId ? this.store.project(input.projectId) : null;
    const exchange =
      !ctx.operator && isProjectSession(ctx.sessionKey)
        ? this.store.get('SELECT * FROM exchanges WHERE session=?', ctx.sessionKey)
        : null;
    if (!ctx.operator && isProjectSession(ctx.sessionKey))
      assert(exchange, 'Registered purpose context required');
    if (exchange && project)
      assert.equal(project.id, exchange.project, 'Internal context cannot cross projects');
    if (productOperations.has(operation))
      assert(agentId === productAgentId, 'This project operation belongs to the product agent');
    if (exchange && mainConversationOperations.has(operation))
      throw new Error('Project-wide operation is unavailable inside a Feature context');
    const assertExchangeScope = (feature) => {
      const row = this.store.feature(feature);
      assert.equal(row.project, project.id, 'Feature belongs to another project');
      const id = row.id;
      if (exchange)
        assert.equal(exchange.scope, id, 'Internal context cannot mutate another Feature');
      return id;
    };
    if (operation === 'list')
      return this.store
        .list()
        .filter((candidate) => !exchange || candidate.id === exchange.project)
        .map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          purpose: candidate.purpose,
          state: candidate.state,
          revision: candidate.revision,
          repositories: candidate.boards,
        }));
    if (operation === 'conversations') return this.conversations(agentId, input.query);
    if (operation === 'current') return this.current(ctx);
    if (operation === 'visible-context') return this.visibleContext(agentId, input.conversationRef);
    if (operation === 'summary') return this.summary(project.id);
    if (operation === 'inventory') return this.inventory(project.id);
    if (operation === 'guard')
      return { active: project.state !== 'inactive', state: project.state };
    if (operation === 'declare') {
      assert(
        agentId === productAgentId && input.explicit === true,
        'Explicit product declaration required',
      );
      const source = ctx.operator && input.source ? input.source : await this.current(ctx);
      assert(source.messageId);
      const route = input.conversationRef
        ? await this.route(productAgentId, input.conversationRef)
        : source.route;
      const created = this.store.declare({
        key: hash([source.route, source.messageId]),
        name: input.name,
        purpose: input.purpose,
        route,
        productFallback: route,
      });
      return this.summary(created.id);
    }
    if (operation === 'move') {
      assert(input.explicit === true);
      const source = ctx.operator && input.source ? input.source : await this.current(ctx);
      const route = input.conversationRef
        ? await this.route(agentId, input.conversationRef)
        : source.route;
      this.store.move({
        key: hash([source.route, source.messageId, managerRole]),
        id: project.id,
        managerRole,
        route,
        revision: input.revision,
      });
      return this.summary(project.id);
    }
    if (operation === 'context')
      return this.store.context(project.id, input.context, input.revision);
    if (operation === 'priority') {
      assert(Number.isSafeInteger(input.priority) && Math.abs(input.priority) <= 100);
      this.store.run(
        'UPDATE projects SET priority=?,revision=revision+1 WHERE id=?',
        input.priority,
        project.id,
      );
      return this.store.project(project.id);
    }
    if (operation === 'associate') {
      assert(input.explicit === true && input.repository);
      const existing = project.boards.find(
        (board) => board.repository === input.repository.repository,
      );
      const empty = project.boards.find((board) => !board.repository);
      const boardId =
        existing?.id ??
        empty?.id ??
        `jg-${hash([project.id, input.repository.repository]).slice(0, 32)}`;
      await this.createBoard(boardId, `${project.name} repository`);
      this.store.attach(project.id, boardId, input.repository);
      return { boardId, project: await this.summary(project.id) };
    }
    if (operation === 'intake') {
      assert(
        agentId === productAgentId && input.authorized === true,
        'Explicit work authorization required',
      );
      const source = ctx.operator && input.source ? input.source : await this.current(ctx);
      const result = await this.intake(project, input, source);
      this.requestTick();
      return result;
    }
    if (operation === 'amend') {
      assert(agentId === productAgentId && input.authorized === true);
      assertExchangeScope(input.featureId ?? input.id);
      const source = ctx.operator && input.source ? input.source : await this.current(ctx);
      assert(source.messageId, 'Actual amendment source required');
      const result = await amendFeature(
        {
          ...input,
          source: JSON.stringify({ route: source.route, messageId: source.messageId }),
        },
        this.rpc,
        this.registryContext(project.id, input.boardId),
      );
      this.requestTick();
      return result;
    }
    if (operation === 'control') {
      assert(
        agentId === productAgentId && input.explicit === true,
        'Explicit control intent required',
      );
      assertExchangeScope(input.featureId);
      const feature = this.store.feature(input.featureId);
      const card = (await this.cards(project)).find((candidate) => candidate.id === feature.card);
      assert(card && card.status !== 'done', 'Cannot stop a completed Feature');
      const result = this.store.control({
        project: project.id,
        request: input.requestId ?? null,
        feature: input.featureId ?? null,
        kind: 'stop',
        reason: input.reason,
      });
      this.requestTick();
      return result;
    }
    if (operation === 'notify') {
      assert(internal && agentId === productAgentId);
      assertExchangeScope(input.featureId);
      assert(
        !String(input.event).startsWith('result:'),
        'Terminal results require communication-decision',
      );
      const prior = this.store.get(
        'SELECT * FROM deliveries WHERE project=? AND event=? AND role=?',
        project.id,
        input.event,
        'product',
      );
      const delivery =
        prior ??
        this.store.enqueue({
          project: project.id,
          event: input.event,
          kind: input.kind ?? 'milestone',
          message: text(input.message, 6000),
          fallbackMessage: input.fallbackMessage,
          due: this.now() + (input.kind === 'milestone' ? 45000 : 0),
        });
      this.requestTick();
      return {
        durable: true,
        id: delivery.id,
        status: delivery.status,
        reused: Boolean(prior),
        receipt: delivery.receipt ? JSON.parse(delivery.receipt) : null,
      };
    }
    if (operation === 'communication-decision') {
      assert(internal && agentId === productAgentId && typeof input.notify === 'boolean');
      const intent = this.store.get(
        'SELECT * FROM communication_intents WHERE project=? AND event=? AND eligible=1',
        project.id,
        input.event,
      );
      assert(intent);
      if (exchange)
        assert.equal(exchange.scope, intent.scope, 'Communication belongs to another scope');
      if (intent.kind === 'result')
        assert(input.notify === true, 'Terminal result communication must be composed');
      if (intent.status !== 'pending')
        return {
          event: intent.event,
          status: intent.status,
          deliveryId: this.store.get(
            'SELECT id FROM deliveries WHERE project=? AND event=? AND role=?',
            project.id,
            intent.event,
            'product',
          )?.id,
        };
      const delivery = input.notify
        ? this.store.enqueue({
            project: project.id,
            event: intent.event,
            kind: intent.kind,
            message: text(input.message, 6000),
            fallbackMessage: input.fallbackMessage,
          })
        : null;
      this.store.run(
        'UPDATE communication_intents SET status=?,reason=?,updated=? WHERE id=?',
        input.notify ? 'composed' : 'dismissed',
        text(input.reason ?? 'Product communication judgment', 1000),
        this.now(),
        intent.id,
      );
      return {
        event: intent.event,
        status: input.notify ? 'composed' : 'dismissed',
        deliveryId: delivery?.id ?? null,
      };
    }
    if (operation === 'milestone-decision') {
      assert(internal && agentId === productAgentId && typeof input.notify === 'boolean');
      assertExchangeScope(input.featureId);
      assert(
        !String(input.event).startsWith('result:'),
        'Terminal results require communication-decision',
      );
      const key = `milestone-decision:${project.id}:${text(input.event, 240)}`;
      return this.store.once(key, { notify: input.notify, reason: input.reason }, () => {
        const delivery = input.notify
          ? this.store.enqueue({
              project: project.id,
              event: input.event,
              kind: 'milestone',
              message: text(input.message, 6000),
              due: this.now() + 45000,
            })
          : null;
        return {
          event: input.event,
          notified: Boolean(delivery),
          deliveryId: delivery?.id ?? null,
          reason: text(input.reason ?? 'Product milestone judgment', 1000),
        };
      });
    }
    if (operation === 'delivery') {
      const delivery = this.store.get(
        'SELECT * FROM deliveries WHERE project=? AND id=?',
        project.id,
        input.id,
      );
      assert(delivery);
      return {
        ...delivery,
        delivered: ['sent', 'fallback-sent'].includes(delivery.status),
        receipt: delivery.receipt ? JSON.parse(delivery.receipt) : null,
      };
    }
    if (operation === 'also-notify') {
      assert(input.explicit === true);
      if (exchange) assertExchangeScope(input.featureId);
      const source = ctx.operator && input.source ? input.source : await this.current(ctx);
      return this.store.copy({
        project: project.id,
        event: input.event,
        managerRole,
        route: input.conversationRef
          ? await this.route(agentId, input.conversationRef)
          : source.route,
        recurring: input.recurring ?? false,
      });
    }
    if (operation === 'question-delivery') {
      assert(internal && agentId === productAgentId);
      const decision = scopedDecision(this.store, project.id, input.checkpoint);
      assertExchangeScope(decision.feature);
      assert(['open', 'sent'].includes(decision.phase), 'Open decision required');
      const existing = decision.question_delivery
        ? this.store.get(
            'SELECT * FROM deliveries WHERE id=? AND project=?',
            decision.question_delivery,
            project.id,
          )
        : null;
      const delivery =
        existing ??
        this.store.enqueue({
          project: project.id,
          event: `question:${decision.id}`,
          kind: 'question',
          message: text(input.message, 6000),
          fallbackMessage: input.fallbackMessage,
        });
      await this.deliver(delivery);
      const sent = this.store.get('SELECT * FROM deliveries WHERE id=?', delivery.id);
      if (['sent', 'fallback-sent'].includes(sent.status))
        this.store.run(
          "UPDATE decisions SET phase='sent',question_delivery=?,updated=? WHERE id=?",
          delivery.id,
          this.now(),
          decision.id,
        );
      return { checkpoint: decision.id, deliveryId: delivery.id, status: sent.status };
    }
    if (operation === 'answer') {
      assert(agentId === productAgentId && input.correlated === true);
      const source = ctx.operator && input.source ? input.source : await this.current(ctx);
      assert(source.messageId, 'Actual answer message required');
      const decision = scopedDecision(this.store, project.id, input.checkpoint);
      assertExchangeScope(decision.feature);
      assert(['sent', 'answered'].includes(decision.phase), 'Sent decision required');
      const answer = text(input.answer, 1400);
      if (decision?.phase === 'answered') {
        assert.equal(decision.answer, answer, 'Decision answer changed');
        assert.equal(decision.answer_message, String(source.messageId), 'Answer source changed');
      } else {
        assert(decision?.authority === 'user', 'Exact sent user decision required');
        this.store.run(
          "UPDATE decisions SET phase='answered',answer=?,answer_message=?,source=?,updated=? WHERE id=?",
          answer,
          String(source.messageId),
          JSON.stringify(source.route),
          this.now(),
          decision.id,
        );
      }
      this.requestTick();
      await projectAnsweredDecision(
        this.store,
        project.id,
        decision.id,
        this.rpc,
        input.expectedUpdatedAt,
      );
      return this.store.get('SELECT * FROM decisions WHERE id=?', decision.id);
    }
    if (operation === 'schedule') {
      assert(agentId === productAgentId && input.authorized === true && project.state === 'active');
      const source = ctx.operator && input.source ? input.source : await this.current(ctx);
      assert(source.messageId, 'Actual schedule source required');
      const boards = input.boards ?? project.boards.map((board) => board.id);
      assert(
        Array.isArray(boards) &&
          boards.length > 0 &&
          boards.length <= 8 &&
          new Set(boards).size === boards.length &&
          boards.every((id) => project.boards.some((board) => board.id === id)),
        'Schedule boards must be unique associated repositories',
      );
      const spec = {
        title: text(input.title, 180),
        scope: text(input.scope, 1400),
        boards,
      };
      return this.store.schedule({
        project: project.id,
        spec,
        next: input.next,
        intervalMs: input.intervalMs ?? null,
        sourceKey: hash([source.route, source.messageId]),
      });
    }
    if (operation === 'schedule-disable') {
      const schedule = this.store.get(
        'SELECT * FROM schedules WHERE id=? AND project=?',
        input.id,
        project.id,
      );
      assert(schedule);
      this.store.run('UPDATE schedules SET enabled=0 WHERE id=?', schedule.id);
      return { disabled: true };
    }
    if (operation === 'inactivate') {
      assert(agentId === productAgentId && input.confirmed === true);
      const inventory = await this.inventory(project.id);
      assert.equal(input.revision, inventory.revision, 'Project changed; show refreshed inventory');
      const items = [
        ...inventory.obligations.map((item) => ({ ...item, kind: 'obligation' })),
        ...inventory.notifications.map((item) => ({ ...item, kind: 'delivery' })),
        ...inventory.communicationIntents.map((item) => ({ ...item, kind: 'communication' })),
        ...inventory.controls.map((item) => ({ ...item, kind: 'control' })),
        ...inventory.schedules.map((item) => ({ ...item, kind: 'schedule' })),
      ];
      const dispositions = input.dispositions ?? {};
      assert.deepEqual(
        Object.keys(dispositions).sort(),
        items.map((item) => item.id).sort(),
        'Every unfinished item needs an explicit disposition',
      );
      assert(
        Object.values(dispositions).every((value) => ['finish', 'stop', 'pending'].includes(value)),
        'Disposition must be finish, stop, or pending',
      );
      for (const item of inventory.notifications.filter((item) => item.status === 'batched')) {
        const member = this.store.get('SELECT * FROM deliveries WHERE id=?', item.recordId);
        const leaderId = JSON.parse(member.receipt).batch;
        const leader = this.store.get('SELECT * FROM deliveries WHERE id=?', leaderId);
        if (leader.status !== 'pending' || leader.route)
          assert(
            inventory.notifications
              .filter((candidate) => {
                const row = this.store.get(
                  'SELECT receipt FROM deliveries WHERE id=?',
                  candidate.recordId,
                );
                return row?.receipt && JSON.parse(row.receipt).batch === leaderId;
              })
              .every((candidate) => dispositions[candidate.id] === 'finish'),
            'In-flight batch members must all finish before inactivation',
          );
      }
      this.store.tx(() => {
        this.store.run('DELETE FROM inactivation_plans WHERE project=?', project.id);
        for (const item of items)
          this.store.run(
            'INSERT INTO inactivation_plans VALUES(?,?,?,?,?)',
            project.id,
            item.recordId,
            item.kind,
            dispositions[item.id],
            this.now(),
          );
        for (const item of inventory.obligations.filter(
          (item) => dispositions[item.id] === 'stop',
        )) {
          const obligation = this.store.obligation(item.recordId);
          if (!this.store.pendingStop(obligation.feature))
            this.store.control({
              project: project.id,
              feature: obligation.feature,
              reason: 'Explicit stop disposition during project inactivation',
            });
        }
        for (const leader of this.store.all(
          "SELECT * FROM deliveries WHERE project=? AND kind='milestone-batch' AND status='pending' AND route IS NULL",
          project.id,
        )) {
          const members = this.store.all(
            "SELECT * FROM deliveries WHERE project=? AND status='batched' AND json_extract(receipt,'$.batch')=?",
            project.id,
            leader.id,
          );
          if (!members.length) continue;
          this.store.run("UPDATE deliveries SET status='cancelled' WHERE id=?", leader.id);
          for (const member of members)
            this.store.run(
              'UPDATE deliveries SET status=?,receipt=NULL WHERE id=?',
              dispositions[`delivery:${member.id}`] === 'stop' ? 'cancelled' : 'pending',
              member.id,
            );
        }
        for (const item of inventory.notifications.filter(
          (item) => dispositions[item.id] === 'stop',
        )) {
          const delivery = this.store.get('SELECT * FROM deliveries WHERE id=?', item.recordId);
          if (delivery.status === 'cancelled') continue;
          assert(
            delivery.status === 'pending' && !delivery.route,
            'In-flight delivery must reconcile before stop',
          );
          this.store.run("UPDATE deliveries SET status='cancelled' WHERE id=?", item.recordId);
        }
        for (const item of inventory.communicationIntents.filter(
          (item) => dispositions[item.id] === 'stop',
        ))
          this.store.run(
            "UPDATE communication_intents SET status='dismissed',reason=?,updated=? WHERE id=?",
            'Explicit stop disposition during project inactivation',
            this.now(),
            item.recordId,
          );
        for (const item of inventory.controls.filter((item) => dispositions[item.id] === 'stop'))
          this.store.run(
            "UPDATE control_intents SET state='dismissed',updated=? WHERE id=?",
            this.now(),
            item.recordId,
          );
        for (const item of inventory.schedules.filter((item) => dispositions[item.id] === 'stop'))
          this.store.run('UPDATE schedules SET enabled=0 WHERE id=?', item.recordId);
        this.store.run(
          "UPDATE projects SET state='draining',revision=revision+1 WHERE id=? AND revision=?",
          project.id,
          input.revision,
        );
      });
      const safe = (await this.inactivationReady(this.store.project(project.id))) === true;
      if (safe)
        this.store.run(
          "UPDATE projects SET state='inactive',revision=revision+1 WHERE id=?",
          project.id,
        );
      this.requestTick();
      return { state: safe ? 'inactive' : 'draining', inventory };
    }
    if (operation === 'reactivate') {
      assert(agentId === productAgentId && input.explicit === true);
      return this.store.reactivate(project.id, this.now());
    }
    if (operation === 'recover') {
      assert(project.state !== 'inactive');
      if (ctx.operator)
        this.store.run(
          'UPDATE exchanges SET attempts=0,lastDispatch=0 WHERE project=?',
          project.id,
        );
      this.requestTick();
      return {
        reconciliationRequested: true,
        executionRestarted: false,
        retryBudgetReset: Boolean(ctx.operator),
      };
    }
    if (operation === 'conclude') {
      assert(internal && exchange);
      text(input.conclusion, 2000);
      this.store.run('UPDATE exchanges SET conclusion=? WHERE id=?', input.conclusion, exchange.id);
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
  async deliver(delivery) {
    const project = this.store.project(delivery.project);
    if (
      project.state === 'inactive' ||
      ['sent', 'cancelled', 'fallback-sent', 'batched'].includes(delivery.status) ||
      delivery.due > this.now()
    )
      return;
    let route;
    try {
      route =
        delivery.kind === 'fallback'
          ? await this.fallbackRoute(delivery.role)
          : delivery.route
            ? JSON.parse(delivery.route)
            : delivery.role === 'product'
              ? project.productConversation
              : project.engineeringConversation;
    } catch {
      await this.failure(delivery, 'Fallback destination unavailable');
      return;
    }
    assert(route, 'Notification route missing');
    if (!delivery.route || delivery.kind === 'fallback') {
      this.store.run(
        "UPDATE deliveries SET route=?,status='sending' WHERE id=?",
        JSON.stringify(route),
        delivery.id,
      );
      delivery = this.store.get('SELECT * FROM deliveries WHERE id=?', delivery.id);
    }
    try {
      const receipt = await this.rpc('conversations.send', {
        agentId: agentForRole(delivery.role),
        operationId: `jarvis-gilfoyle-${delivery.id}`,
        conversationRef: route.conversationRef,
        message: delivery.text,
      });
      assert(['sent', 'queued', 'suppressed', 'unknown'].includes(receipt.status));
      this.store.run(
        'UPDATE deliveries SET status=?,receipt=?,attempts=attempts+1,error=NULL,due=? WHERE id=?',
        receipt.status,
        JSON.stringify(receipt),
        this.now() + 60000,
        delivery.id,
      );
      if (receipt.status === 'sent')
        await this.settleBatch({
          ...delivery,
          status: 'sent',
          receipt: JSON.stringify(receipt),
          route: JSON.stringify(route),
        });
      else if (receipt.status === 'suppressed')
        await this.failure(delivery, 'Preferred conversation rejected delivery');
    } catch {
      await this.failure(
        delivery,
        'Preferred conversation delivery failed or could not be reconciled',
      );
    }
  }
  async failure(delivery, error) {
    const attempts = delivery.attempts + 1;
    this.store.run(
      "UPDATE deliveries SET status='retry',attempts=?,error=?,due=? WHERE id=?",
      attempts,
      error,
      this.now() + 60000,
      delivery.id,
    );
    if (attempts < 3 || delivery.kind === 'fallback') return;
    let route;
    try {
      route = await this.fallbackRoute(delivery.role);
    } catch {
      this.log('Role fallback unavailable; delivery remains durable');
      return;
    }
    const fallback = this.store.enqueue({
      project: delivery.project,
      event: `fallback:${delivery.id}`,
      kind: 'fallback',
      managerRole: delivery.role,
      message: delivery.fallback_text ?? delivery.text,
      route,
    });
    await this.deliver(fallback);
    if (this.store.get('SELECT status FROM deliveries WHERE id=?', fallback.id).status === 'sent')
      await this.settleBatch(
        {
          ...delivery,
          status: 'fallback-sent',
          receipt: this.store.get('SELECT receipt FROM deliveries WHERE id=?', fallback.id).receipt,
          route: this.store.get('SELECT route FROM deliveries WHERE id=?', fallback.id).route,
        },
        true,
      );
  }
  async settleBatch(delivery, fallback = false) {
    this.store.run(
      'UPDATE deliveries SET status=?,receipt=?,route=? WHERE id=?',
      delivery.status,
      delivery.receipt,
      delivery.route,
      delivery.id,
    );
    const members = this.store.all(
      "SELECT * FROM deliveries WHERE project=? AND status='batched' AND json_extract(receipt,'$.batch')=?",
      delivery.project,
      delivery.id,
    );
    for (const member of members) {
      this.store.run(
        'UPDATE deliveries SET status=?,receipt=?,route=? WHERE id=?',
        fallback ? 'fallback-sent' : 'sent',
        delivery.receipt,
        delivery.route,
        member.id,
      );
      await this.processCopies({
        ...member,
        status: fallback ? 'fallback-sent' : 'sent',
        receipt: delivery.receipt,
        route: delivery.route,
      });
    }
    await this.processCopies(delivery);
  }
  async processCopies(delivery) {
    if (delivery.role !== 'product' || ['copy', 'fallback'].includes(delivery.kind)) return;
    const events = [delivery.event];
    if (delivery.event.startsWith('result:')) {
      const feature = this.store.get('SELECT * FROM features WHERE id=?', delivery.event.slice(7));
      const request =
        feature && this.store.get('SELECT * FROM requests WHERE id=?', feature.request);
      const source = request ? JSON.parse(request.source) : null;
      const match = /^([0-9a-f-]{36})-[0-9]+$/.exec(String(source?.messageId ?? ''));
      if (
        match &&
        this.store.get(
          'SELECT id FROM schedules WHERE id=? AND project=?',
          match[1],
          delivery.project,
        )
      )
        events.push(`schedule:${match[1]}:result`);
    }
    for (const copy of this.store
      .all(
        'SELECT * FROM copies WHERE project=? AND (consumed IS NULL OR recurring=1)',
        delivery.project,
      )
      .filter((copy) => events.includes(copy.event))) {
      const extra = this.store.enqueue({
        project: delivery.project,
        event: copy.recurring ? `copy:${copy.id}:${delivery.id}` : `copy:${copy.id}`,
        kind: 'copy',
        managerRole: copy.role,
        message: delivery.text,
        route: JSON.parse(copy.route),
      });
      if (!copy.recurring)
        this.store.run('UPDATE copies SET consumed=? WHERE id=?', extra.id, copy.id);
    }
    this.store.run(
      'INSERT OR REPLACE INTO receipts VALUES(?,?,?,?)',
      `copies:${delivery.id}`,
      hash(delivery.text),
      JSON.stringify({ complete: true }),
      this.now(),
    );
  }
  batchMilestones(project) {
    const pending = this.store.all(
      "SELECT * FROM deliveries WHERE project=? AND role='product' AND kind IN ('milestone','result') AND status='pending' AND route IS NULL ORDER BY created",
      project.id,
    );
    if (pending.length < 2 || !pending.some((delivery) => delivery.due <= this.now())) return;
    const leader = this.store.enqueue({
      project: project.id,
      event: `milestones:${hash(pending.map((delivery) => delivery.id)).slice(0, 32)}`,
      kind: 'milestone-batch',
      message: pending.map((delivery) => delivery.text).join('\n\n'),
    });
    for (const delivery of pending)
      this.store.run(
        "UPDATE deliveries SET status='batched',receipt=? WHERE id=?",
        JSON.stringify({ batch: leader.id }),
        delivery.id,
      );
  }
  async runSchedules(project) {
    if (project.state === 'inactive') return;
    for (const schedule of this.store.all(
      'SELECT * FROM schedules WHERE project=? AND enabled=1 AND next<=? ORDER BY next LIMIT 8',
      project.id,
      this.now(),
    )) {
      if (
        project.state === 'draining' &&
        this.store.get(
          'SELECT disposition FROM inactivation_plans WHERE project=? AND kind=? AND item=?',
          project.id,
          'schedule',
          schedule.id,
        )?.disposition !== 'finish'
      )
        continue;
      try {
        const spec = JSON.parse(schedule.spec);
        const result = await this.intake(project, spec, {
          route: { channel: 'schedule', accountId: 'project', target: project.id },
          messageId: `${schedule.id}-${schedule.next}`,
        });
        if (project.state === 'draining')
          for (const feature of result.features)
            this.store.run(
              "INSERT OR REPLACE INTO inactivation_plans(project,item,kind,disposition,created) VALUES(?,?,'obligation','finish',?)",
              project.id,
              feature,
              this.now(),
            );
        this.store.run(
          'UPDATE schedules SET next=?,enabled=? WHERE id=?',
          schedule.intervalMs
            ? schedule.next +
                (Math.floor((this.now() - schedule.next) / schedule.intervalMs) + 1) *
                  schedule.intervalMs
            : schedule.next,
          project.state === 'draining' ? 0 : schedule.intervalMs ? 1 : 0,
          schedule.id,
        );
      } catch {
        this.store.requestCommunication({
          project: project.id,
          event: `schedule-failure:${schedule.id}:${schedule.next}`,
          scope: `schedule:${schedule.id}`,
          kind: 'blocker',
          facts: {
            condition: 'schedule-occurrence-failed',
            scheduleId: schedule.id,
            occurrence: schedule.next,
            obligationRetained: true,
          },
        });
      }
    }
  }
  async inactivationReady(project, cards = null) {
    const plans = this.store.all('SELECT * FROM inactivation_plans WHERE project=?', project.id);
    if (!plans.length) return false;
    cards ??= await this.cards(project);
    const byId = new Map(cards.map((card) => [card.id, card]));
    for (const plan of plans.filter((row) => row.disposition !== 'pending')) {
      if (plan.kind === 'obligation') {
        const obligation = this.store.obligation(plan.item);
        if (plan.disposition === 'finish') {
          if (byId.get(obligation.card)?.status !== 'done') return false;
        } else if (this.store.pendingStop(obligation.feature)) return false;
      } else if (plan.kind === 'delivery') {
        const status = this.store.get(
          'SELECT status FROM deliveries WHERE id=?',
          plan.item,
        )?.status;
        if (!['sent', 'cancelled', 'fallback-sent'].includes(status)) return false;
      } else if (plan.kind === 'communication') {
        if (
          this.store.get('SELECT status FROM communication_intents WHERE id=?', plan.item)
            ?.status === 'pending'
        )
          return false;
      } else if (plan.kind === 'control') {
        if (
          this.store.get('SELECT state FROM control_intents WHERE id=?', plan.item)?.state ===
          'pending'
        )
          return false;
      } else if (plan.kind === 'schedule') {
        if (this.store.get('SELECT enabled FROM schedules WHERE id=?', plan.item)?.enabled)
          return false;
      }
    }
    return !(await this.hasActiveExecution(project));
  }
  allowedDuringDrain(project, item, records) {
    if (project.state !== 'draining') return true;
    if (String(item.id).startsWith('communication:')) {
      const id = String(item.id).slice('communication:'.length);
      return (
        this.store.get(
          'SELECT disposition FROM inactivation_plans WHERE project=? AND kind=? AND item=?',
          project.id,
          'communication',
          id,
        )?.disposition === 'finish'
      );
    }
    if (String(item.id).startsWith('decision:')) {
      const decision = records.decisions.find(
        (row) => row.id === String(item.id).slice('decision:'.length),
      );
      if (!decision?.obligation) return false;
      return (
        this.store.get(
          'SELECT disposition FROM inactivation_plans WHERE project=? AND kind=? AND item=?',
          project.id,
          'obligation',
          decision.obligation,
        )?.disposition === 'finish'
      );
    }
    const obligation = records.obligations.find((row) => row.id === item.id);
    if (!obligation) return false;
    const direct = this.store.get(
      'SELECT disposition FROM inactivation_plans WHERE project=? AND kind=? AND item=?',
      project.id,
      'obligation',
      obligation.id,
    )?.disposition;
    if (direct && direct !== 'pending') return true;
    const featurePlan = this.store.get(
      'SELECT disposition FROM inactivation_plans WHERE project=? AND kind=? AND item=?',
      project.id,
      'obligation',
      obligation.feature,
    )?.disposition;
    if (featurePlan === 'finish') return true;
    return records.controls
      .filter((control) => control.feature === obligation.feature && control.state === 'pending')
      .some(
        (control) =>
          this.store.get(
            'SELECT disposition FROM inactivation_plans WHERE project=? AND kind=? AND item=?',
            project.id,
            'control',
            control.id,
          )?.disposition === 'finish',
      );
  }
  async dispatch(project, scope, managerRole, recordIds, attention = {}) {
    if (this.roleAdmission.has(managerRole)) return;
    this.roleAdmission.add(managerRole);
    const exchange = this.store.exchange(project.id, scope, managerRole);
    try {
      if (this.now() - exchange.lastDispatch < 120000) return;
      if (exchange.attempts >= 3) {
        if (managerRole === 'engineering')
          this.store.requestCommunication({
            project: project.id,
            event: `coordination:${exchange.id}:${String(exchange.observed).slice(0, 24)}`,
            scope,
            kind: 'blocker',
            facts: {
              condition: 'unchanged-attention-exhausted',
              attentionVersion: exchange.observed,
              attempts: exchange.attempts,
              obligationRetained: true,
            },
          });
        return;
      }
      const agentId = agentForRole(managerRole);
      const sessions = await this.rpc('sessions.list', { agentId, limit: 500 });
      assert(!sessions.hasMore);
      if (
        sessions.sessions.some(
          (session) =>
            isProjectSession(session.key) && (session.status === 'queued' || session.hasActiveRun),
        )
      )
        return;
      await this.rpc('sessions.create', {
        key: exchange.session,
        agentId,
        label: `Project ${scope}`,
        category: 'project-internal',
      });
      const runId = randomUUID();
      this.store.run(
        'UPDATE exchanges SET runId=?,attempts=attempts+1,lastDispatch=? WHERE id=?',
        runId,
        this.now(),
        exchange.id,
      );
      await this.rpc('agent', {
        agentId,
        sessionKey: exchange.session,
        deliver: false,
        idempotencyKey: runId,
        timeout: 600,
        message: `PROJECT CONTINUATION\nProject: ${project.id}\nScope: ${scope}\nRegistered obligations: ${recordIds.join(', ')}\nAttention: ${JSON.stringify(attention)}\nLoad project-coordination and use registry-backed project tools. Workboard notes are human context only. End with NO_REPLY.`,
      });
    } catch (error) {
      this.health.lastDispatchFailure = {
        project: project.id,
        scope,
        code: error.code ?? error.name,
        at: this.now(),
      };
      throw error;
    } finally {
      this.roleAdmission.delete(managerRole);
    }
  }
  attentionVersion(records, cards, feature, managerRole, attention) {
    const obligations = records.obligations.filter((row) => row.feature === feature);
    const cardState = obligations.map((obligation) => {
      const card = cards.find((candidate) => candidate.id === obligation.card);
      return [
        obligation.id,
        card?.status ?? 'missing',
        card?.agentId ?? null,
        card?.metadata?.automation?.summary ?? null,
        card?.metadata?.proof ?? null,
      ];
    });
    return hash([
      managerRole,
      Object.entries(attention).sort(),
      records.features.find((row) => row.id === feature),
      cardState,
      records.attempts.filter((row) => obligations.some((item) => item.id === row.obligation)),
      records.decisions.filter((row) => row.feature === feature),
      records.publications.filter((row) => row.feature === feature),
      records.controls.filter((row) => row.feature === feature),
      records.terminalCheckpoints.filter((row) => row.feature === feature),
    ]);
  }
  syncAttention(project, feature, managerRole, version) {
    const exchange = this.store.exchange(project, feature, managerRole);
    if (exchange.observed !== version) {
      this.store.run(
        'UPDATE exchanges SET observed=?,attempts=0,lastDispatch=0 WHERE id=?',
        version,
        exchange.id,
      );
      return this.store.get('SELECT * FROM exchanges WHERE id=?', exchange.id);
    }
    return exchange;
  }
  async cleanup(project, cards) {
    for (const exchange of this.store.all(
      'SELECT * FROM exchanges WHERE project=? AND closed IS NULL',
      project.id,
    )) {
      const feature = this.store
        .records(project.id)
        .features.find((row) => row.id === exchange.scope);
      if (
        !exchange.conclusion ||
        !feature ||
        cards.find((card) => card.id === feature.card)?.status !== 'done'
      )
        continue;
      const sessions = await this.rpc('sessions.list', {
        agentId: agentForRole(exchange.role),
        search: exchange.session,
        archived: 'all',
        limit: 10,
      });
      const session = sessions.sessions.find((candidate) => candidate.key === exchange.session);
      if (session?.hasActiveRun || session?.hasActiveSubagentRun) continue;
      const result = await this.rpc('jarvis-gilfoyle.session.cleanup', {
        agentId: agentForRole(exchange.role),
        sessionNamespace: topology().sessionNamespace,
        sessionKey: exchange.session,
        projectId: project.id,
        expectedSessionId: session?.sessionId,
      });
      assert(
        result && result.archivedTranscriptArtifacts === 0,
        'Temporary context cleanup not confirmed',
      );
      for (const path of result.exportedPaths ?? [])
        await unlink(path).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      this.store.run('UPDATE exchanges SET closed=? WHERE id=?', this.now(), exchange.id);
    }
  }
  async tick() {
    if (this.busy || this.stopped) return { skipped: true, stopped: this.stopped };
    this.busy = true;
    const scan = { at: this.now(), complete: true, checked: [], errors: [] };
    const dispatches = [];
    try {
      this.store.run('DELETE FROM sources WHERE updated<?', this.now() - 30 * 24 * 60 * 60 * 1000);
      for (const project of this.store.list()) {
        if (project.state === 'inactive') continue;
        scan.checked.push(project.id);
        try {
          await this.runSchedules(project);
          await this.reconcileRegistryProjections(project);
          this.batchMilestones(project);
          for (const delivery of this.store.all(
            "SELECT * FROM deliveries WHERE project=? AND status NOT IN ('sent','cancelled','fallback-sent','batched') AND due<=? ORDER BY created LIMIT 20",
            project.id,
            this.now(),
          )) {
            if (
              project.state === 'draining' &&
              (delivery.kind === 'milestone-batch'
                ? !this.store.get(
                    "SELECT 1 AS allowed FROM deliveries d JOIN inactivation_plans p ON p.project=d.project AND p.kind='delivery' AND p.item=d.id WHERE d.project=? AND d.status='batched' AND json_extract(d.receipt,'$.batch')=? AND p.disposition='finish' LIMIT 1",
                    project.id,
                    delivery.id,
                  )
                : this.store.get(
                    'SELECT disposition FROM inactivation_plans WHERE project=? AND kind=? AND item=?',
                    project.id,
                    'delivery',
                    delivery.id,
                  )?.disposition !== 'finish')
            )
              continue;
            await this.deliver(delivery);
          }
          let cards = await this.cards(project);
          let records = this.store.records(project.id);
          for (const checkpoint of records.terminalCheckpoints.filter(
            (row) => row.state === 'staged',
          )) {
            const feature = records.features.find((row) => row.id === checkpoint.feature);
            const card = feature && cards.find((candidate) => candidate.id === feature.card);
            const evidence = JSON.parse(checkpoint.evidence);
            if (
              card?.status === 'done' &&
              card.metadata?.automation?.summary === checkpoint.summary &&
              card.metadata?.proof?.some(
                (proof) =>
                  proof.status === evidence.status &&
                  proof.label === evidence.label &&
                  proof.note === evidence.note,
              )
            )
              this.store.completeTerminal(feature.id);
          }
          records = this.store.records(project.id);
          const binding = await reconcileExecutionBindings(records, cards, this.store, this.rpc);
          if (binding.bound.length) records = this.store.records(project.id);
          this.health.bindingDiagnostics = [
            ...this.health.bindingDiagnostics.filter(
              (diagnostic) => diagnostic.project !== project.id,
            ),
            ...binding.pending.map((diagnostic) => ({ project: project.id, ...diagnostic })),
          ];
          const ready = [];
          for (const decision of records.decisions.filter((row) => row.phase === 'answered')) {
            try {
              await projectAnsweredDecision(this.store, project.id, decision.id, this.rpc);
            } catch (error) {
              this.health.projectionDiagnostics = [
                ...(this.health.projectionDiagnostics ?? []).filter(
                  (diagnostic) =>
                    !(
                      diagnostic.project === project.id &&
                      diagnostic.type === 'decision-answer' &&
                      diagnostic.id === decision.id
                    ),
                ),
                {
                  project: project.id,
                  type: 'decision-answer',
                  id: decision.id,
                  error: String(error.message),
                },
              ];
            }
            ready.push({
              feature: decision.feature,
              managerRole: 'engineering',
              agentId: topology().engineeringAgentId,
              id: `decision:${decision.id}`,
              created: decision.updated,
              priority: 1000,
              ownsClaim: false,
              stage: 'decision-answered',
              project,
            });
          }
          for (const board of project.boards) {
            for (const [managerRole, agentId] of [
              ['product', topology().productAgentId],
              ['engineering', topology().engineeringAgentId],
            ]) {
              const page = await readView(
                { agentId, boardId: board.id, includeArchived: false, view: 'attention' },
                this.rpc,
                records,
              );
              for (const row of page.cards) {
                const item = Object.fromEntries(
                  page.fields.map((field, index) => [field, row[index]]),
                );
                if (quiet.has(item.stage)) continue;
                const obligation = records.obligations.find(
                  (candidate) => candidate.id === item.obligation,
                );
                if (!obligation) continue;
                if (
                  managerRole === 'product' &&
                  records.decisions.some(
                    (decision) =>
                      decision.obligation === obligation.id && decision.phase === 'answered',
                  )
                )
                  continue;
                ready.push({
                  feature: obligation.feature,
                  managerRole,
                  agentId,
                  id: obligation.id,
                  created: records.features.find((feature) => feature.id === obligation.feature)
                    .created,
                  priority: item.priority === 'urgent' ? 1000 : 0,
                  ownsClaim: Boolean(cards.find((card) => card.id === item.id)?.metadata?.claim),
                  stage: item.stage,
                  project,
                });
              }
            }
          }
          for (const intent of this.store.all(
            "SELECT * FROM communication_intents WHERE project=? AND status='pending' AND eligible=1",
            project.id,
          ))
            ready.push({
              feature: intent.scope,
              managerRole: 'product',
              id: `communication:${intent.id}`,
              created: intent.created,
              priority: 1000,
              ownsClaim: false,
              stage: 'communication-intent',
              project,
            });
          const groups = new Map();
          for (const item of ready) {
            if (!this.allowedDuringDrain(project, item, records)) continue;
            const key = `${item.managerRole}:${item.feature}`;
            if (!groups.has(key)) groups.set(key, { ...item, ids: [], attention: {} });
            groups.get(key).ids.push(item.id);
            groups.get(key).attention[item.id] = item.stage;
          }
          for (const group of groups.values()) {
            const version = this.attentionVersion(
              records,
              cards,
              group.feature,
              group.managerRole,
              group.attention,
            );
            this.syncAttention(project.id, group.feature, group.managerRole, version);
            dispatches.push(group);
          }
          if (project.state === 'draining' && (await this.inactivationReady(project, cards))) {
            this.store.run(
              "UPDATE projects SET state='inactive',revision=revision+1 WHERE id=?",
              project.id,
            );
            continue;
          }
          await this.cleanup(project, cards);
        } catch (error) {
          scan.complete = false;
          scan.errors.push({ project: project.id, code: error.code ?? error.name });
          this.log(`Project ${project.id} reconciliation incomplete; retained for next scan`);
        }
      }
      const used = new Set();
      for (const group of orderReady(dispatches)) {
        if (used.has(group.managerRole)) continue;
        used.add(group.managerRole);
        this.dispatch(
          group.project,
          group.feature,
          group.managerRole,
          group.ids,
          group.attention,
        ).catch(() => this.log('Internal continuation failed; retry remains durable'));
      }
      return scan;
    } finally {
      this.busy = false;
      this.health.lastScan = scan;
    }
  }
}
