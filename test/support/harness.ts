// In-memory stand-in for the native OpenClaw gateway and a harness that drives the plugin
// through its real registration, hooks and tool. Never touches a real gateway.
import assert from 'node:assert/strict';
import plugin, { testHooks } from '../../src/index.ts';

export const EPOCH = Date.parse('2026-09-28T09:00:00Z');
export const MINUTE = 60 * 1000;
export const ref = (c) => `conv_${c.repeat(32)}`;

export async function harness({ config = {} } = {}) {
  let clock = EPOCH;
  const native = {
    conversations: [
      // The owner's DM with the product manager, and a project group.
      {
        conversationRef: ref('a'),
        channel: 'telegram',
        accountId: 'default',
        target: 'telegram:100',
        kind: 'direct',
      },
      {
        conversationRef: ref('b'),
        channel: 'telegram',
        accountId: 'default',
        target: 'telegram:-200',
        kind: 'group',
      },
    ],
    sessions: [],
    sent: [],
    files: [],
    transcript: [],
    runs: [],
    aborted: [],
    cleaned: [],
    patches: [],
    calls: [],
    fail: new Set(),
    sendStatus: () => 'sent',
    session(key) {
      let row = native.sessions.find((s) => s.key === key);
      if (!row) {
        row = {
          key,
          sessionId: `s-${native.sessions.length}`,
          hasActiveRun: false,
          updatedAt: clock,
        };
        native.sessions.push(row);
      }
      return row;
    },
  };
  const bridge = {
    stopped: false,
    stop() {},
    async request(method, params) {
      native.calls.push([method, params]);
      if (native.fail.has(method)) throw new Error(`${method} unavailable`);
      switch (method) {
        case 'conversations.list':
          return {
            conversations: native.conversations.filter(
              (c) =>
                (!params.query || c.target.includes(params.query)) &&
                (!params.channel || c.channel === params.channel),
            ),
          };
        case 'conversations.send': {
          const status = native.sendStatus(params);
          if (status === 'throw') throw new Error('channel down');
          if (status === 'sent' || status === 'queued') native.sent.push(params);
          return { status };
        }
        case 'message.action':
          assert.equal(params.action, 'send');
          native.files.push(params);
          return { ok: true, messageId: 'm' };
        case 'sessions.list':
          return {
            sessions: native.sessions
              .filter(
                (s) =>
                  s.key.startsWith(`agent:${params.agentId}:`) &&
                  s.key.includes(params.search ?? ''),
              )
              .map((s) => ({ ...s })),
          };
        case 'sessions.create':
          native.session(params.key);
          return {};
        case 'agent': {
          native.runs.push(params);
          const row = native.session(params.sessionKey);
          row.hasActiveRun = true;
          row.updatedAt = clock;
          return { runId: `run-${native.runs.length}` };
        }
        case 'sessions.patch':
          native.patches.push(params);
          return { ok: true };
        case 'sessions.abort':
          assert.deepEqual(Object.keys(params).sort(), ['clearQueued', 'key']);
          native.aborted.push(params.key);
          native.session(params.key).hasActiveRun = false;
          return { ok: true };
        case 'jarvis-gilfoyle.session.cleanup':
          native.cleaned.push(params.sessionKey);
          native.sessions = native.sessions.filter((s) => s.key !== params.sessionKey);
          return { removedEntries: 1, archivedTranscriptArtifacts: 0 };
        default:
          throw new Error(`Unexpected native method ${method}`);
      }
    },
  };
  testHooks.bridge = bridge;
  testHooks.appendTranscript = async (params) => {
    native.transcript.push(params);
    return { appended: true, messageId: `t-${native.transcript.length}` };
  };
  testHooks.publishTranscript = async () => {};
  testHooks.now = () => clock;
  testHooks.manualTicks = true;
  testHooks.runtime = null;
  const hooks = {};
  let factory;
  const pluginConfig = {
    statePath: ':memory:',
    productAgentId: 'main',
    engineeringAgentId: 'gilfoyle',
    ownerChat: { channel: 'telegram', accountId: 'default', to: 'telegram:100' },
    worker: {
      agentId: 'opencode',
      limit: 2,
      profiles: [
        {
          id: 'sol-low',
          model: 'openai/gpt-5.6-sol',
          thinking: 'low',
          description: 'Routine work.',
        },
        {
          id: 'astra',
          model: 'openai/gpt-6-astra',
          thinking: 'low',
          description: 'Hard problems.',
        },
      ],
    },
    ...config,
  };
  // Registers the plugin as OpenClaw does; returns the tool factory and hooks it received.
  const register = (into = hooks) => {
    let made;
    plugin.register({
      pluginConfig,
      config: {
        agents: {
          entries: { main: { identity: { name: 'Jarvis' } }, gilfoyle: { name: 'Gilfoyle' } },
        },
      },
      logger: { warn() {} },
      registerTool(make) {
        made = make;
      },
      registerGatewayMethod() {},
      registerService() {},
      on(name, fn) {
        into[name] = fn;
      },
    });
    return made;
  };
  factory = register();
  testHooks.bridge = null;
  const h = {
    native,
    hooks,
    advance(ms) {
      clock += ms;
    },
    now: () => clock,
    get runtime() {
      return testHooks.runtime;
    },
    // A further registration in the same process, as OpenClaw makes for agent runs.
    registerAgain: () => register({}),
    tool(agentId, sessionKey) {
      return factory({ agentId, sessionKey });
    },
    // Calls project_board and returns the parsed result; errors come back as {error}.
    async call(agentId, sessionKey, args) {
      const result = await factory({ agentId, sessionKey }).execute('call', args);
      return JSON.parse(result.content[0].text);
    },
    // A user message in a chat followed by the start of the manager's turn.
    async userMessage(agentId, sessionKey, target, channel = 'telegram') {
      await hooks.message_received(
        { from: target, content: 'hi' },
        { agentId, sessionKey, channelId: channel, accountId: 'default', conversationId: target },
      );
      return hooks.before_prompt_build({}, { agentId, sessionKey });
    },
    endTurn(agentId, sessionKey) {
      native.session(sessionKey).hasActiveRun = false;
      return hooks.agent_end({ success: true }, { agentId, sessionKey });
    },
    endAllRuns() {
      for (const row of native.sessions)
        if (!row.key.startsWith('agent:opencode:')) row.hasActiveRun = false;
      for (const key of [...testHooks.runtime.wakes.keys()]) testHooks.runtime.wakes.delete(key);
    },
    tick: () => testHooks.runtime.tick(),
    // A worker spawn as the native tool call would run it through the hooks.
    async spawn(sessionKey, params) {
      const agentId = /^agent:([^:]+):/.exec(sessionKey)[1];
      const before = await hooks.before_tool_call(
        { toolName: 'sessions_spawn', params },
        { agentId, sessionKey },
      );
      if (before?.block) return { blocked: before.blockReason };
      const childSessionKey = `agent:opencode:acp:${native.sessions.length}`;
      const row = native.session(childSessionKey);
      row.hasActiveRun = true;
      hooks.after_tool_call(
        {
          toolName: 'sessions_spawn',
          params: before?.params ?? params,
          result: { content: [], details: { status: 'accepted', childSessionKey, runId: 'r' } },
        },
        { agentId, sessionKey },
      );
      return { childSessionKey, params: before?.params ?? params };
    },
  };
  await h.call('main', 'agent:main:operator', { operation: 'list' });
  return h;
}

export const JARVIS_DM = 'agent:main:telegram:direct:100';
export const JARVIS_GROUP = 'agent:main:telegram:group:-200';
