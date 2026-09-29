import assert from 'node:assert/strict';

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const NAMESPACE = /^[a-z][a-z0-9_-]{0,31}$/;
const PROFILE_ID = /^[a-z][a-z0-9_-]{0,31}$/;

// Who plays which role. Configured once at registration; everything else asks here.
let current = Object.freeze({
  productAgentId: 'product',
  engineeringAgentId: 'engineering',
  workerAgentId: 'worker',
  workerRuntime: 'acp',
  workerLimit: 2,
  sessionNamespace: 'jarvis-gilfoyle',
  workerProfiles: Object.freeze([]),
});

export function configureTopology(input = {}) {
  const next = {
    ...current,
    ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
  };
  for (const key of ['productAgentId', 'engineeringAgentId', 'workerAgentId'])
    assert(AGENT_ID.test(next[key]), `Invalid ${key}`);
  assert(
    new Set([next.productAgentId, next.engineeringAgentId, next.workerAgentId]).size === 3,
    'Product, engineering and worker agent IDs must be distinct',
  );
  assert(NAMESPACE.test(next.sessionNamespace), 'Invalid sessionNamespace');
  assert(
    ['acp', 'subagent'].includes(next.workerRuntime),
    'worker.runtime must be acp or subagent',
  );
  assert(
    Number.isSafeInteger(next.workerLimit) && next.workerLimit >= 1 && next.workerLimit <= 20,
    'worker.limit must be 1 to 20',
  );
  assert(Array.isArray(next.workerProfiles), 'worker.profiles must be a list');
  next.workerProfiles = Object.freeze(
    next.workerProfiles.map((profile) => {
      assert(PROFILE_ID.test(profile?.id ?? ''), 'Invalid worker profile id');
      assert(typeof profile.model === 'string' && profile.model, 'Worker profile needs a model');
      return Object.freeze({ ...profile });
    }),
  );
  current = Object.freeze(next);
  return current;
}

export const topology = () => current;
export const isManagerAgent = (id) =>
  id === current.productAgentId || id === current.engineeringAgentId;
export const roleForAgent = (id) =>
  id === current.productAgentId
    ? 'product'
    : id === current.engineeringAgentId
      ? 'engineering'
      : null;
export const agentForRole = (role) =>
  role === 'product'
    ? current.productAgentId
    : role === 'engineering'
      ? current.engineeringAgentId
      : null;

// Private task sessions: agent:<agent>:<namespace>:task-<id>-<created base36>. The creation
// time makes a key unique to one registry row, even if a registry is ever recreated.
export const taskScope = (task) => `task-${task.id}-${Number(task.created).toString(36)}`;
export const taskSessionKey = (role, task) =>
  `agent:${agentForRole(role)}:${current.sessionNamespace}:${taskScope(task)}`;
export function parseTaskSession(key) {
  const match = /^agent:([^:]+):([^:]+):task-(\d+)-([0-9a-z]+)$/.exec(String(key ?? ''));
  if (!match || match[2] !== current.sessionNamespace || !isManagerAgent(match[1])) return null;
  return {
    agentId: match[1],
    role: roleForAgent(match[1]),
    taskId: Number(match[3]),
    created: parseInt(match[4], 36),
  };
}
// Any session in the plugin's namespace (including stale ones whose task is gone).
export const isPrivateSession = (key) =>
  isManagerAgent(/^agent:([^:]+):/.exec(String(key ?? ''))?.[1]) &&
  String(key).split(':')[2] === current.sessionNamespace;
