import { Store } from './store.js';
import { ProjectRuntime, isProjectSession } from './runtime.js';
import { Bridge } from './bridge.js';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createProductCard, creationError } from './helpers/create-card.js';
import { operate } from './helpers/native-operation.js';
import { finalizeFeature } from './helpers/finalize-feature.js';
import { handoffCard, handoffError } from './helpers/handoff-card.js';
import { readView } from './helpers/workboard-page.js';
import { delegationError } from './helpers/record-delegation.js';
import { validateRegisteredCompletion } from './helpers/completion-guard.js';
import { assertEngineeringMutationScope } from './helpers/authority.js';
import { configureTopology, topology, isManagerAgent, workerProfiles } from './topology.js';

const inputSchema = {
  type: 'object',
  properties: {
    operation: {
      type: 'string',
      enum: [
        'list',
        'conversations',
        'current',
        'visible-context',
        'summary',
        'inventory',
        'declare',
        'move',
        'context',
        'priority',
        'associate',
        'intake',
        'amend',
        'control',
        'notify',
        'communication-decision',
        'milestone-decision',
        'delivery',
        'also-notify',
        'question-delivery',
        'answer',
        'schedule',
        'schedule-disable',
        'inactivate',
        'reactivate',
        'recover',
        'conclude',
      ],
    },
    input: { type: 'object', additionalProperties: true },
  },
  required: ['operation', 'input'],
  additionalProperties: false,
};
const engineeringOperations = [
  'work-item',
  'review',
  'exceptional-intervention',
  'profiles',
  'prepare',
  'record',
  'publish-gate',
  'gate',
  'finish',
  'settle-control',
  'finalize',
  'handoff',
  'decide',
  'handoff-apply',
  'workboard-query',
];
const engineeringSchema = {
  type: 'object',
  properties: {
    operation: { type: 'string', enum: engineeringOperations },
    input: {
      type: 'object',
      additionalProperties: true,
      properties: {
        reviewKey: {
          type: 'string',
          description:
            'Stable review key. Reuse the returned reviewKey, not the full idempotencyKey or its review- prefix. Missing binding is not a reason for a new key.',
        },
        boardId: { type: 'string', description: 'Native repository board ID, not a project UUID.' },
        id: {
          type: 'string',
          description: 'Target Workboard card UUID. For record, the original prepared Work item.',
        },
        agentId: { type: 'string', description: 'Manager ID for workboard-query.' },
        tenant: {
          type: 'string',
          description: 'Feature UUID to list its child cards; omit to include the Feature itself.',
        },
        includeArchived: {
          type: 'boolean',
          description:
            'Required for workboard-query. Include archived evidence for reconciliation.',
        },
        view: {
          type: 'string',
          enum: ['queue', 'todoUndelegated', 'delegated', 'attention'],
          description:
            'Optional query filter. Omit for all scoped records; there is no native view.',
        },
        after: { type: 'string', description: 'Returned nextAfter pagination cursor only.' },
        membership: {
          type: 'string',
          description: 'Returned opaque membership token, only with after. Not a Feature ID.',
        },
        runId: { type: 'string', description: 'Actual sessions_spawn runId for record.' },
        childSessionKey: {
          type: 'string',
          description: 'Actual accepted worker session key for record.',
        },
        taskId: {
          type: 'string',
          description: 'Native ACP task UUID; optional when uniquely discoverable.',
        },
        wrapperTaskId: {
          type: 'string',
          description: 'Native wrapper task UUID, distinct from the ACP task.',
        },
      },
    },
  },
  required: ['operation'],
  additionalProperties: false,
};
export const isCompletionMutation = (event) =>
  event.toolName === 'workboard_complete' ||
  (['workboard_move', 'workboard_release'].includes(event.toolName) &&
    event.params?.status === 'done');
export default {
  id: 'jarvis-gilfoyle',
  name: 'Jarvis-Gilfoyle project runtime',
  register(api) {
    const cfg = api.pluginConfig ?? {};
    configureTopology({
      productAgentId: cfg.productAgentId,
      engineeringAgentId: cfg.engineeringAgentId,
      workerAgentId: cfg.worker?.agentId,
      workerRuntime: cfg.worker?.runtime,
      workerLimit: cfg.worker?.limit ?? 2,
      workerProfiles: cfg.worker?.profiles,
      sessionNamespace: cfg.sessionNamespace,
    });
    const configured = topology();
    let store, runtime, timer;
    const bridge = new Bridge();
    const get = () => {
      if (!runtime) {
        assert(
          typeof cfg.statePath === 'string' &&
            (cfg.statePath.startsWith('/') || cfg.statePath === ':memory:'),
          'Absolute statePath is required',
        );
        store = new Store(cfg.statePath);
        runtime = new ProjectRuntime(store, (method, params) => bridge.request(method, params), {
          fallbackDestinations: cfg.fallbackDestinations ?? {},
          log: (message) => api.logger.warn(message),
        });
        runtime.stopped = cfg.enabled === false;
      }
      return runtime;
    };
    api.registerTool(
      (ctx) => {
        if (!isManagerAgent(ctx.agentId)) return null;
        return {
          name: 'jarvis_project',
          label: 'Project conversations',
          description:
            'Durable project identity, current preferred conversations, contextual summaries, explicit intake, lifecycle, schedules, and receipt-backed notifications. Use current to obtain trusted source. Discussion is not implementation. Declare only on explicit user declaration. Move only on explicit intent. Intake replies naturally once in the receiving chat after durable success. Never use sessions_send into user chats.',
          parameters: inputSchema,
          async execute(_id, args) {
            const result = await get().operation(args.operation, args.input, ctx);
            return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
          },
        };
      },
      { name: 'jarvis_project' },
    );
    api.registerTool(
      (ctx) => {
        if (!isManagerAgent(ctx.agentId)) return null;
        return {
          name: 'gilfoyle_engineering',
          label: 'Project engineering records',
          description:
            'Validated Workboard creation, worker binding, handoffs, evidence queries, publication gates, and generic settled-outcome finalization. Available only inside a registered project context. It performs bookkeeping and validation; it never spawns workers, sends user messages, pushes, creates pull requests, merges, or deploys.',
          parameters: engineeringSchema,
          async execute(_id, args) {
            const r = get(),
              exchange = isProjectSession(ctx.sessionKey)
                ? r.store.get('SELECT * FROM exchanges WHERE session=?', ctx.sessionKey)
                : null;
            const fail = (value) => ({
              content: [{ type: 'text', text: JSON.stringify(value) }],
              details: value,
              isError: true,
            });
            try {
              const operation = args.operation,
                input = args.input ?? {};
              const readOnly = ['profiles', 'workboard-query'].includes(operation);
              assert(exchange || readOnly, 'Registered project context required for mutations');
              assert(!Object.hasOwn(input, 'actor'), 'Actor is supplied by the runtime');
              assert(
                ctx.agentId !== configured.productAgentId || operation === 'decide' || readOnly,
                'Engineering operations belong to the engineering manager; the product agent owns communication and decisions',
              );
              let repository = null;
              let registryProject = exchange?.project ?? null;
              if (input.boardId) {
                const matches = r.store
                  .list()
                  .flatMap((project) =>
                    project.boards
                      .filter((board) => board.id === input.boardId)
                      .map((board) => ({ project, board })),
                  );
                assert.equal(matches.length, 1, 'Board is not uniquely registered');
                const { project, board } = matches[0];
                assert(
                  !exchange || project.id === exchange.project,
                  'Board belongs to another project',
                );
                registryProject = project.id;
                repository = board.metadata;
              }
              let calls = 0,
                bytes = 0;
              const rpc = async (method, params) => {
                assert(++calls <= 64, 'Engineering operation call budget exceeded');
                const value = await bridge.request(method, params);
                bytes += Buffer.byteLength(JSON.stringify(value));
                assert(bytes <= 24 * 1024 * 1024, 'Engineering operation read budget exceeded');
                return value;
              };
              let result;
              const registry = exchange
                ? {
                    store: r.store,
                    project: registryProject,
                    repository,
                  }
                : registryProject
                  ? { store: r.store, project: registryProject, repository }
                  : null;
              if (!readOnly) {
                assertEngineeringMutationScope(
                  r.store,
                  exchange,
                  registryProject,
                  operation,
                  input,
                );
              }
              if (['work-item', 'review', 'exceptional-intervention'].includes(operation))
                result = await createProductCard(operation, input, rpc, registry);
              else if (operation === 'profiles') result = { profiles: workerProfiles() };
              else if (
                ['prepare', 'record', 'publish-gate', 'gate', 'finish', 'settle-control'].includes(
                  operation,
                )
              )
                result = await operate(operation, input, rpc, undefined, undefined, registry);
              else if (operation === 'finalize')
                result = await finalizeFeature(input, rpc, undefined, registry);
              else if (operation === 'decide')
                result = await handoffCard(
                  'handoff-decision',
                  { ...input, actor: ctx.sessionKey },
                  rpc,
                  registry,
                );
              else if (['handoff', 'handoff-apply'].includes(operation))
                result = await handoffCard(
                  operation,
                  { ...input, actor: ctx.sessionKey },
                  rpc,
                  registry,
                );
              else if (operation === 'workboard-query') {
                assert(registryProject, 'Registered board required for registry-backed queries');
                result = await readView(input, rpc, r.store.records(registryProject));
              } else throw Error('Unsupported engineering operation');
              if (result?.communicationIntent) r.requestTick();
              assert(
                Buffer.byteLength(JSON.stringify(result)) <= 12000,
                'Engineering operation output exceeds bound',
              );
              return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
            } catch (error) {
              const operation = args.operation;
              if (['work-item', 'review', 'exceptional-intervention'].includes(operation))
                return fail(creationError(error));
              if (['prepare', 'record'].includes(operation)) return fail(delegationError(error));
              if (operation.startsWith('handoff')) return fail(handoffError(error));
              if (
                operation === 'workboard-query' &&
                /^(Expected query object|Unknown query field|Invalid (manager|boardId|tenant|view|after|membership)|Explicit (scope|includeArchived) required|Continuation requires after and membership together)$/.test(
                  error.message ?? '',
                )
              )
                return fail({
                  complete: false,
                  code: 'invalid-query',
                  error: error.message,
                  guidance:
                    'Use boardId and includeArchived. Omit view for all records. Use tenant for a Feature UUID; after/membership are returned pagination tokens.',
                });
              return fail({
                complete: false,
                code: 'validation-failed',
                error:
                  error instanceof assert.AssertionError
                    ? String(error.message).split('\n')[0].slice(0, 500)
                    : 'Operation failed; inspect the scoped records and runtime health.',
                operation,
                recordId: args.input?.id ?? args.input?.featureId,
              });
            }
          },
        };
      },
      { name: 'gilfoyle_engineering' },
    );
    api.registerGatewayMethod(
      'jarvis-gilfoyle.projects.call',
      async ({ params, respond }) => {
        try {
          const result = await get().operation(params.operation, params.input ?? {}, {
            operator: true,
            agentId: params.agentId ?? configured.productAgentId,
            sessionKey: params.sessionKey ?? `agent:${configured.productAgentId}:main`,
          });
          respond(true, result);
        } catch (e) {
          respond(false, undefined, { code: 'INVALID_REQUEST', message: e.message });
        }
      },
      { scope: 'operator.admin' },
    );
    api.registerGatewayMethod(
      'jarvis-gilfoyle.projects.guard',
      async ({ params, respond }) => {
        try {
          const r = get(),
            p = r.store.project(params.projectId),
            feature = r.store.feature(params.featureId);
          assert.equal(feature.project, p.id);
          respond(true, {
            active: p.state === 'active' && !r.store.pendingStop(feature.id),
            state: p.state,
            stopped: Boolean(r.store.pendingStop(feature.id)),
          });
        } catch {
          respond(false, undefined, {
            code: 'INVALID_REQUEST',
            message: 'Project identity unavailable',
          });
        }
      },
      { scope: 'operator.read' },
    );
    api.registerGatewayMethod(
      'jarvis-gilfoyle.projects.tick',
      async ({ respond }) => {
        try {
          respond(true, await get().tick());
        } catch {
          respond(false, undefined, { code: 'UNAVAILABLE', message: 'Project scan incomplete' });
        }
      },
      { scope: 'operator.admin' },
    );
    api.registerGatewayMethod(
      'jarvis-gilfoyle.projects.health',
      async ({ respond }) => {
        try {
          const r = get();
          const native = await bridge.request('workboard.boards.list', {});
          respond(true, {
            enabled: !r.stopped,
            registry: r.store.get('PRAGMA quick_check').quick_check,
            nativeReachable: Array.isArray(native.boards),
            ...r.health,
          });
        } catch {
          respond(false, undefined, {
            code: 'UNAVAILABLE',
            message: 'Project registry or companion unavailable',
          });
        }
      },
      { scope: 'operator.read' },
    );
    api.on('message_received', async (event, ctx) => {
      const session = ctx.sessionKey ?? event.sessionKey,
        agentId = /^agent:([^:]+):/.exec(session ?? '')?.[1];
      if (!isManagerAgent(agentId)) return;
      const r = get(),
        clean = (s) => {
          let v = String(s ?? '');
          if (v.startsWith(`${ctx.channelId}:`)) v = v.slice(ctx.channelId.length + 1);
          if (ctx.channelId === 'discord') v = v.replace(/^(channel|user):/, '');
          return v.replace(/:topic:.+$/, '');
        };
      const routes = await r
        .conversations(agentId, clean(ctx.conversationId ?? event.from))
        .catch(() => []);
      const matches = routes.filter(
        (c) =>
          c.channel === ctx.channelId &&
          c.accountId === (ctx.accountId ?? 'default') &&
          clean(c.target) === clean(ctx.conversationId ?? event.from) &&
          String(c.threadId ?? '') === String(event.threadId ?? ''),
      );
      {
        const source = {
          ...(matches.length === 1 ? { route: matches[0] } : {}),
          raw: {
            channel: ctx.channelId,
            accountId: ctx.accountId ?? 'default',
            conversationId: ctx.conversationId ?? event.from,
            threadId: event.threadId,
          },
          messageId: ctx.messageId ?? event.messageId,
          senderId: ctx.senderId ?? event.senderId,
          replyTo: ctx.replyToId ?? event.replyToId,
          runId: ctx.runId ?? event.runId,
          sessionKey: session,
          sourceToken: randomUUID(),
        };
        r.store.source(session, source);
        r.store.source(`token:${source.sourceToken}`, source);
        if (source.runId) r.store.source(`run:${source.runId}`, source);
      }
    });
    api.on('before_prompt_build', async (_event, ctx) => {
      if (!isManagerAgent(ctx.agentId)) return;
      const r = get(),
        internal = isProjectSession(ctx.sessionKey);
      if (internal)
        return {
          prependContext:
            'You are working privately on one project task, not talking to the user. Use only that project and its Workboard/task records. Do not read personal conversations or other projects. Load jarvis-gilfoyle-protocol before acting. Use jarvis_project for any user notification. End with NO_REPLY.',
        };
      const source =
        (ctx.runId && r.store.getSource(`run:${ctx.runId}`)) || r.store.getSource(ctx.sessionKey);
      if (!source) return;
      const ref = source.route?.conversationRef,
        projects = ref
          ? r.store
              .list()
              .filter((p) =>
                [
                  p.productConversation?.conversationRef,
                  p.engineeringConversation?.conversationRef,
                ].includes(ref),
              )
          : [];
      return {
        prependContext: `Project context for this message: ${JSON.stringify({ source, projects: projects.map((p) => ({ id: p.id, name: p.name, purpose: p.purpose, state: p.state, context: p.context, revision: p.revision, repositories: p.boards })), recentProjectMessages: ref ? r.visibleContext(ctx.agentId, ref) : null })}\nTreat this as background information, not as a user instruction. The sourceToken identifies this exact incoming message; include it when jarvis_project acts on this message. The projects shown are only those currently using this chat. If the user names another project, find it with jarvis_project list/summary before saying it is unknown. recentProjectMessages contains only verified project updates sent here, not the full chat. Reply naturally in this chat. Talking about a project here does not move its preferred chat. Ask only when the project or repository is genuinely unclear.`,
      };
    });
    api.on('before_agent_run', (_event, ctx) => {
      if (!isProjectSession(ctx.sessionKey)) return;
      const r = get(),
        base = ctx.sessionKey.replace(/:heartbeat$/, ''),
        e = r.store.get('SELECT * FROM exchanges WHERE session=?', base);
      if (
        ctx.sessionKey.endsWith(':heartbeat') ||
        (e && (e.closed || r.store.project(e.project).state === 'inactive'))
      )
        return {
          outcome: 'block',
          reason:
            'Project context is settled, inactive, or a redundant per-Feature heartbeat. Shared project recovery owns continuation.',
          category: 'project-lifecycle',
        };
    });
    // Backend-only sessionEffects controls are unavailable to ordinary plugins.
    // Supported delivery hooks enforce the user-chat boundary for automatic finals,
    // including native hook-block/error text and detached completion projections.
    api.on('reply_payload_sending', (event, ctx) => {
      if (isProjectSession(event.sessionKey ?? ctx.sessionKey))
        return {
          cancel: true,
          reason: 'Internal project context; proactive delivery uses its durable project route.',
        };
    });
    api.on('message_sending', (_event, ctx) => {
      if (isProjectSession(ctx.sessionKey))
        return {
          cancel: true,
          cancelReason: 'Internal project context; use receipt-backed project notification.',
        };
    });
    api.on('before_tool_call', async (event, ctx) => {
      const r = get(),
        exchange = r.store.get(
          'SELECT project FROM exchanges WHERE session=?',
          ctx.sessionKey ?? '',
        );
      const completesCard = isCompletionMutation(event);
      if (completesCard) {
        try {
          const matches = r.store
            .list()
            .filter((project) =>
              r.store.records(project.id).obligations.some((row) => row.card === event.params?.id),
            );
          if (!matches.length) return;
          assert.equal(matches.length, 1, 'Registered card project is ambiguous');
          const project = matches[0];
          if (exchange)
            assert.equal(
              exchange.project,
              project.id,
              'Registered card belongs to another project',
            );
          const cards = await r.cards(project);
          await validateRegisteredCompletion(r.store, project, cards, event.params?.id, r.rpc);
        } catch (error) {
          return {
            block: true,
            blockReason:
              error instanceof assert.AssertionError
                ? String(error.message).split('\n')[0].slice(0, 300)
                : 'Execution evidence is not reconciled; inspect the existing card and native tasks before completion.',
          };
        }
      }
      if (
        exchange &&
        r.store.project(exchange.project).state === 'inactive' &&
        ['sessions_spawn', 'sessions_send'].includes(event.toolName)
      )
        return {
          block: true,
          blockReason: 'Project is inactive; its pending obligations are deliberately paused.',
        };
      if (event.toolName === 'sessions_send' && isProjectSession(ctx.sessionKey)) {
        const target = r.store.get(
          'SELECT project,scope,closed FROM exchanges WHERE session=?',
          event.params?.sessionKey ?? '',
        );
        const source = r.store.get(
          'SELECT project,scope FROM exchanges WHERE session=?',
          ctx.sessionKey,
        );
        if (
          target &&
          source &&
          target.project === source.project &&
          target.scope === source.scope &&
          !target.closed
        )
          return;
        return {
          block: true,
          blockReason:
            'Project continuations use durable records and jarvis_project; do not insert hidden exchanges into a user or canonical product conversation.',
        };
      }
    });
    api.on('agent_end', async (_event, ctx) => {
      if (isProjectSession(ctx.sessionKey) || ctx.agentId === configured.workerAgentId)
        get().requestTick();
    });
    api.on('after_tool_call', (event, ctx) => {
      if (event.toolName === 'sessions_spawn' && isProjectSession(ctx.sessionKey))
        get().requestTick();
    });
    api.registerService({
      id: 'jarvis-gilfoyle-project-recovery',
      start: async () => {
        bridge.stopped = false;
        const r = get();
        r.stopped = cfg.enabled === false;
        if (cfg.enabled !== false) {
          timer = setInterval(
            () => r.tick().catch(() => api.logger.warn('Project recovery scan incomplete')),
            cfg.scanMs ?? 60000,
          );
          timer.unref();
          r.requestTick();
        }
      },
      stop: async () => {
        if (timer) clearInterval(timer);
        if (runtime) runtime.stopped = true;
        bridge.stop();
      },
    });
  },
};
