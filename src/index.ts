import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import { Store } from './store.js';
import { BoardRuntime, spawnAgentId } from './runtime.js';
import { Bridge } from './bridge.js';
import { agentLabel, currentConfig, PRIVATE_GUIDANCE, projectRoleContext } from './role-context.js';
import {
  agentForRole,
  configureTopology,
  isManagerAgent,
  isPrivateSession,
  roleForAgent,
  topology,
} from './topology.js';

export const OPERATIONS = [
  'list',
  'show',
  'create_project',
  'update_project',
  'add_task',
  'update_task',
  'notify',
];

const parameters = {
  type: 'object',
  additionalProperties: false,
  required: ['operation'],
  properties: {
    operation: {
      type: 'string',
      enum: OPERATIONS,
      description:
        'list: projects and open tasks. show: one task with its notes (or one project with its context). create_project / update_project (product; engineering may update context). add_task. update_task: note, handover (holder), close (status), check_in_minutes. notify: message the user (product).',
    },
    project: {
      type: 'string',
      description: 'Project id. Implied in a task session or a project chat.',
    },
    task: { type: 'integer', description: 'Task number. Implied in a task session.' },
    name: { type: 'string', description: 'create_project/update_project: project name.' },
    context: {
      type: 'string',
      description:
        'create_project/update_project: durable project facts (repositories, conventions).',
    },
    state: {
      type: 'string',
      enum: ['active', 'paused', 'archived'],
      description: 'update_project.',
    },
    use_this_chat: {
      type: 'boolean',
      description:
        'update_project: send this project’s messages to the chat you are talking in now.',
    },
    title: { type: 'string', description: 'add_task: short title.' },
    body: { type: 'string', description: 'add_task: what is wanted, in plain words.' },
    holder: {
      type: 'string',
      enum: ['product', 'engineering', 'user'],
      description:
        'Whose turn it is. add_task (default engineering) or update_task (handover; needs a note).',
    },
    note: {
      type: 'string',
      description:
        'update_task: progress, result, question or answer. Required when handing over or closing.',
    },
    status: {
      type: 'string',
      enum: ['open', 'done', 'cancelled'],
      description: 'update_task: close (done/cancelled) or reopen (open, product).',
    },
    message: {
      type: 'string',
      description:
        'update_task/notify: text for the user, sent to the project chat. Required outside that chat when handing to the user or closing a product task.',
    },
    attachments: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 4,
      description:
        'update_task/notify: absolute paths of up to 4 files (8 MB each) sent after the message. Look at each image before sending it.',
    },
    check_in_minutes: {
      type: 'integer',
      description: 'update_task: when the holder should be woken to look again (default 60).',
    },
  },
};

export const OUTPUT_LIMIT = 16 * 1024;
const bound = (value) => {
  const encoded = JSON.stringify(value ?? null);
  return Buffer.byteLength(encoded) <= OUTPUT_LIMIT
    ? encoded
    : JSON.stringify({
        truncated: true,
        partial: encoded.slice(0, OUTPUT_LIMIT - 200),
        hint: 'Ask for one project or task.',
      });
};

// Test-only injection points. Production leaves every field null.
export const testHooks = {
  bridge: null,
  now: null,
  manualTicks: false,
  runtime: null,
  appendTranscript: null,
  publishTranscript: null,
};

// OpenClaw's own transcript writer (JavaScript-only SDK subpath), loaded on first use.
const transcripts = () => import('openclaw/plugin-sdk/session-transcript-runtime');

// OpenClaw may register the plugin more than once in one process: the gateway registry
// runs the hooks while a per-run registry supplies the tool. Registrations with the same
// configuration share one board, so a turn's chat, the scan and the bridge are not split
// between them. An in-memory board belongs to its own registration.
const COMPANION_RESET_MS = 5 * 60 * 1000;
const boards = (globalThis[Symbol.for('jarvis-gilfoyle.boards')] ??= new Map());
// Configuration is JSON: object insertion order is irrelevant, array order is not.
const configIdentity = (cfg) =>
  JSON.stringify(cfg, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
const sharedBoard = (cfg, create) => {
  if (cfg.statePath === ':memory:') return create();
  const key = configIdentity(cfg);
  if (!boards.has(key)) boards.set(key, create());
  return boards.get(key);
};
// Native hooks expose these IDs optionally. Never match a launch by parent alone:
// several overlapping calls can share one task session and even one turn.
const spawnIdentity = (event, ctx) => {
  const ids = ['runId', 'toolCallId'].map((field) => {
    if (event?.[field] && ctx?.[field] && event[field] !== ctx[field]) return null;
    const value = ctx?.[field] ?? event?.[field];
    return typeof value === 'string' && value.length ? value : null;
  });
  return ids.every(Boolean)
    ? JSON.stringify([ctx.sessionKey, ctx.sessionId ?? null, ...ids])
    : null;
};

export default {
  id: 'jarvis-gilfoyle',
  name: 'Jarvis-Gilfoyle project board',
  register(api) {
    const cfg = api.pluginConfig ?? {};
    configureTopology({
      productAgentId: cfg.productAgentId,
      engineeringAgentId: cfg.engineeringAgentId,
      workerAgentId: cfg.worker?.agentId,
      workerRuntime: cfg.worker?.runtime,
      workerLimit: cfg.worker?.limit,
      workerProfiles: cfg.worker?.profiles,
      sessionNamespace: cfg.sessionNamespace,
    });
    const board = sharedBoard(cfg, () => ({
      bridge: testHooks.bridge ?? new Bridge(),
      runtime: null,
      openError: null,
      owner: null,
    }));
    // Writes to a chat's session run in the board service's own async context. Called from a
    // manager's tool call, OpenClaw's write context for that turn refuses a write to another
    // session ("session writer claim changed before transcript persistence").
    const outsideTurns = (write) => (params) =>
      (board.serviceScope ?? ((run) => run()))(() => write(params));
    const service = Symbol('service');
    let timer;
    // The board opens lazily; a failure is reported by the tool and health and never
    // affects other agents. It is retried after a minute.
    const get = () => {
      if (board.runtime) return board.runtime;
      const failed = board.openError;
      if (failed && Date.now() - failed.at < 60 * 1000) throw new Error(failed.message);
      try {
        assert(
          typeof cfg.statePath === 'string' &&
            (cfg.statePath.startsWith('/') || cfg.statePath === ':memory:'),
          'An absolute statePath is required',
        );
        const store = new Store(cfg.statePath, testHooks.now ? { now: testHooks.now } : {});
        board.runtime = new BoardRuntime(
          store,
          (method, params) => board.bridge.request(method, params),
          {
            ownerChat: cfg.ownerChat ?? null,
            log: (message) => api.logger?.warn?.(message),
            turnTimeoutSeconds: cfg.turnTimeoutSeconds ?? 1800,
            maxWakesPerRole: cfg.maxWakesPerRole ?? 2,
            agentName: (role) => agentLabel(currentConfig(api), agentForRole(role)),
            appendTranscript:
              testHooks.appendTranscript ??
              outsideTurns(async (params) =>
                (await transcripts()).appendSessionTranscriptMessageByIdentity(params),
              ),
            publishTranscript:
              testHooks.publishTranscript ??
              outsideTurns(async (params) =>
                (await transcripts()).publishSessionTranscriptUpdateByIdentity(params),
              ),
            ...(testHooks.now ? { now: testHooks.now } : {}),
          },
        );
      } catch (error) {
        board.openError = {
          at: Date.now(),
          message: `Project board unavailable (${String(error?.message ?? error)
            .split('\n')[0]
            .slice(0, 300)}); the operator must fix the jarvis-gilfoyle statePath.`,
        };
        api.logger?.warn?.(board.openError.message);
        throw new Error(board.openError.message);
      }
      board.openError = null;
      const runtime = board.runtime;
      runtime.stopped = cfg.enabled === false;
      if (testHooks.manualTicks) runtime.requestTick = () => {};
      testHooks.runtime = runtime;
      return runtime;
    };
    const agentOf = (ctx) => ctx?.agentId ?? /^agent:([^:]+):/.exec(ctx?.sessionKey ?? '')?.[1];
    // Hooks run for every agent: they return at once unless a manager is involved, and a
    // failure is logged and ignored so no hook can block unrelated work.
    const on = (name, fn) =>
      api.on(name, (event, ctx) => {
        const failed = (error) => {
          api.logger?.warn?.(
            `jarvis-gilfoyle ${name} hook skipped: ${String(error?.message ?? error).slice(0, 300)}`,
          );
          return undefined;
        };
        try {
          const value = fn(event, ctx);
          return value && typeof value.then === 'function' ? value.catch(failed) : value;
        } catch (error) {
          return failed(error);
        }
      });

    api.registerTool(
      (ctx) => {
        if (!isManagerAgent(ctx.agentId)) return null;
        return {
          name: 'project_board',
          label: 'Project board',
          description:
            'The shared project board: projects, tasks with whose turn it is (holder), notes, and guaranteed messages to the project chat. Load the project-coordination skill for how to use it.',
          parameters,
          async execute(_id, args = {}) {
            const { operation, ...input } = args;
            try {
              const result = await get().operation(operation, input, ctx);
              return { content: [{ type: 'text', text: bound(result) }], details: result };
            } catch (error) {
              const value = {
                ok: false,
                operation,
                error:
                  String(error?.message ?? error)
                    .split('\n')[0]
                    .slice(0, 1000) || 'Operation failed',
              };
              return {
                content: [{ type: 'text', text: JSON.stringify(value) }],
                details: value,
                isError: true,
              };
            }
          },
        };
      },
      { name: 'project_board' },
    );

    api.registerGatewayMethod(
      'jarvis-gilfoyle.board.call',
      async ({ params, respond }) => {
        try {
          const agentId = params.agentId ?? topology().productAgentId;
          respond(
            true,
            await get().operation(params.operation, params.input ?? {}, {
              agentId,
              sessionKey: params.sessionKey ?? `agent:${agentId}:operator`,
            }),
          );
        } catch (error) {
          respond(false, undefined, { code: 'INVALID_REQUEST', message: error.message });
        }
      },
      { scope: 'operator.admin' },
    );
    api.registerGatewayMethod(
      'jarvis-gilfoyle.board.tick',
      async ({ respond }) => {
        try {
          respond(true, await get().tick());
        } catch (error) {
          respond(false, undefined, {
            code: 'UNAVAILABLE',
            message: String(error?.message ?? error),
          });
        }
      },
      { scope: 'operator.admin' },
    );
    api.registerGatewayMethod(
      'jarvis-gilfoyle.board.health',
      async ({ respond }) => {
        try {
          const r = get();
          respond(true, {
            enabled: !r.stopped,
            registry: r.store.get('PRAGMA quick_check').quick_check,
            ...r.healthReport(),
          });
        } catch (error) {
          respond(true, {
            enabled: cfg.enabled !== false,
            registry: 'unavailable',
            error: error.message,
          });
        }
      },
      { scope: 'operator.read' },
    );

    on('message_received', (event, ctx) => {
      const sessionKey = ctx?.sessionKey ?? event?.sessionKey;
      const agentId = agentOf({ agentId: ctx?.agentId, sessionKey });
      if (!isManagerAgent(agentId) || isPrivateSession(sessionKey)) return;
      return get().captureInbound(sessionKey, agentId, {
        channel: ctx.channelId,
        accountId: ctx.accountId ?? 'default',
        conversationId: ctx.conversationId ?? event.from,
        threadId: event.threadId,
      });
    });
    on('before_prompt_build', async (_event, ctx) => {
      const agentId = agentOf(ctx);
      if (!isManagerAgent(agentId)) return;
      const role = projectRoleContext(currentConfig(api), agentId);
      let r;
      try {
        r = get();
      } catch {
        return { prependSystemContext: role };
      }
      if (isPrivateSession(ctx.sessionKey))
        return {
          prependSystemContext: `${role}\n${PRIVATE_GUIDANCE}`,
          prependContext: r.taskCard(ctx.sessionKey),
        };
      await r.beginTurn(ctx.sessionKey);
      const chat = roleForAgent(agentId) === 'product' ? r.chatContext(ctx.sessionKey) : null;
      return { prependSystemContext: role, ...(chat ? { prependContext: chat } : {}) };
    });
    on('before_agent_run', (_event, ctx) => {
      if (!isPrivateSession(ctx?.sessionKey) || get().allowRun(ctx.sessionKey)) return;
      return {
        outcome: 'block',
        reason: 'This private project session has no open task.',
        category: 'project-lifecycle',
      };
    });
    // Private sessions never reply into user chats; the board's messages do that.
    on('reply_payload_sending', (event, ctx) => {
      if (isPrivateSession(event?.sessionKey ?? ctx?.sessionKey))
        return { cancel: true, reason: 'Private project session.' };
    });
    on('message_sending', (_event, ctx) => {
      if (isPrivateSession(ctx?.sessionKey))
        return { cancel: true, cancelReason: 'Private project session.' };
    });
    on('before_tool_call', (event, ctx) => {
      if (!isManagerAgent(agentOf(ctx)) || !isPrivateSession(ctx?.sessionKey)) return;
      const covered =
        event?.toolName === 'sessions_spawn' &&
        agentOf(ctx) === cfg.engineeringAgentId &&
        spawnAgentId(event.params) === cfg.worker?.agentId;
      if (covered) {
        const blocked = (reason) => ({ block: true, blockReason: reason });
        if (board.admission)
          return blocked(
            'Worker launch invocation is pending; retry after its matching completion hook. Elapsed time and reload do not clear an unfinished call.',
          );
        const identity = spawnIdentity(event, ctx);
        if (!identity)
          return blocked('Worker admission needs native runId and toolCallId; spawn refused.');
        // Board-owned, acquired synchronously before get/count can await. startOver
        // replaces runtime/bridge but must never reset an unfinished invocation.
        const claim = { identity, granted: false };
        board.admission = claim;
        return (async () => {
          try {
            const r = get();
            const result = await r.beforeToolCall(event, ctx);
            if (result?.block || board.runtime !== r) {
              if (board.admission === claim) board.admission = null;
              return result?.block
                ? result
                : blocked('Board reloaded while checking workers; retry.');
            }
            claim.granted = true;
            return result;
          } catch (error) {
            // No launch permission was returned: this is a known prelaunch failure.
            if (board.admission === claim) board.admission = null;
            return blocked(
              `Worker admission unavailable; retry: ${String(error?.message ?? error).slice(0, 300)}`,
            );
          }
        })();
      }
      return get().beforeToolCall(event, ctx);
    });
    on('after_tool_call', (event, ctx) => {
      if (event?.toolName !== 'sessions_spawn' || !isPrivateSession(ctx?.sessionKey)) return;
      const claim = board.admission;
      const matching = claim?.granted && claim.identity === spawnIdentity(event, ctx);
      try {
        let details = event.result?.details;
        if (!details?.childSessionKey)
          try {
            details = JSON.parse(event.result?.content?.[0]?.text ?? 'null');
          } catch {
            details = null;
          }
        const child = details?.childSessionKey;
        if (typeof child === 'string' && child.startsWith('agent:'))
          assert(get().recordWorker(ctx.sessionKey, child), 'worker recording unconfirmed');
      } catch (error) {
        api.logger?.warn?.(
          `Worker recording failed: ${String(error?.message ?? error).slice(0, 300)}`,
        );
      } finally {
        // This hook completes the matching invocation, not proof of no native effect.
        // Record known children first, even on errors; failed recording is visible but
        // cannot retain completed-call serialization. Late/unrelated hooks only record.
        if (matching && board.admission === claim) board.admission = null;
      }
    });
    on('agent_end', (_event, ctx) => {
      if (!isManagerAgent(agentOf(ctx))) return;
      const r = get();
      r.endTurn(ctx.sessionKey);
      if (isPrivateSession(ctx.sessionKey)) r.requestTick();
    });

    // Replaces the board's companion process and runtime with new ones from this code.
    const startOver = () => {
      board.bridge.stop();
      board.bridge = testHooks.bridge ?? new Bridge();
      if (board.runtime) {
        board.runtime.stopped = true;
        board.runtime.store.close();
        board.runtime = null;
      }
      board.serviceScope = null;
    };
    api.registerService({
      id: 'jarvis-gilfoyle-board',
      start: async () => {
        // A reload starts a new registration's service while an earlier one owns the board.
        // Objects the earlier code created (its companion process, its runtime) do not work
        // reliably once that code is retired, so the board starts over with this code.
        if (board.owner && board.owner !== service) startOver();
        board.owner = service;
        board.serviceScope ??= AsyncResource.bind((run) => run());
        board.bridge.stopped = false;
        if (cfg.enabled === false) return;
        const scan = () => {
          // A companion that has not answered for several minutes is not recovering by
          // restarting its process, so the board starts over; the next scan tries again.
          const failingSince = board.bridge.failingSince;
          const now = (testHooks.now ?? Date.now)();
          if (failingSince != null && now - failingSince >= COMPANION_RESET_MS) {
            api.logger?.warn?.(
              `Gateway companion has not answered for ${Math.round((now - failingSince) / 60000)} minutes; starting the board over`,
            );
            startOver();
            board.serviceScope = AsyncResource.bind((run) => run());
          }
          let r;
          try {
            r = get();
          } catch {
            return;
          }
          r.stopped = false;
          r.tick().catch((error) =>
            api.logger?.warn?.(`Project scan incomplete: ${error?.message ?? error}`),
          );
        };
        timer = setInterval(scan, cfg.scanMs ?? 60000);
        timer.unref?.();
        scan();
      },
      stop: async () => {
        if (timer) clearInterval(timer);
        // A newer registration that already started keeps the shared board running.
        if (board.owner !== service) return;
        if (board.runtime) board.runtime.stopped = true;
        board.bridge.stop();
      },
    });
  },
};
