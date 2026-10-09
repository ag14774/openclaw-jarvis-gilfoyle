// Native gateway methods the companion may call on the plugin's behalf.
const methods = new Set([
  'conversations.list',
  'conversations.send',
  'chat.history',
  'message.action',
  'sessions.list',
  'sessions.create',
  'sessions.abort',
  'sessions.patch',
  'agent',
]);

export const COMPANION_METHODS = [...methods];
// sessions.patch may only set the model or the thinking level (one per call) of the
// plugin's own private task sessions.
export const companionMethodAllowed = (method, params) =>
  methods.has(method) &&
  (method !== 'sessions.patch' ||
    (Object.keys(params ?? {}).every((key) =>
      ['key', 'agentId', 'model', 'thinkingLevel'].includes(key),
    ) &&
      Object.hasOwn(params ?? {}, 'model') !== Object.hasOwn(params ?? {}, 'thinkingLevel') &&
      /^agent:([^:]+):[a-z][a-z0-9_-]{0,31}:task-\d+-[0-9a-z]+$/.exec(params.key ?? '')?.[1] ===
        params.agentId));

// Only the plugin's own private task sessions may be cleaned up.
export function cleanupScope(params) {
  const match = /^agent:([^:]+):([a-z][a-z0-9_-]{0,31}):(task-\d+-[0-9a-z]+)$/.exec(
    params?.sessionKey ?? '',
  );
  if (!match || match[1] !== params.agentId || match[2] !== params.sessionNamespace) return null;
  return { agentId: match[1], namespace: match[2], scope: match[3] };
}

// A model change sent with admin scope also becomes the configured default model
// (sticky model selection). The companion sends it with write scope, which OpenClaw
// applies to the session only.
export const companionScopes = (method, params) =>
  method === 'sessions.patch' && Object.hasOwn(params ?? {}, 'model')
    ? ['operator.read', 'operator.write']
    : ['operator.read', 'operator.write', 'operator.admin'];
