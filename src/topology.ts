import assert from 'node:assert/strict';

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROFILE_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const NAMESPACE = /^[a-z][a-z0-9_-]{0,31}$/;
const THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

let current = Object.freeze({
  productAgentId: 'product',
  engineeringAgentId: 'engineering',
  workerAgentId: 'worker',
  workerRuntime: 'acp',
  workerLimit: 2,
  sessionNamespace: 'jarvis-gilfoyle',
  workerProfiles: Object.freeze([
    Object.freeze({
      id: 'default',
      model: 'configured/worker',
      thinking: 'high',
      description: 'Default configured worker capability.',
    }),
  ]),
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
    'Topology agent IDs must be distinct',
  );
  assert(NAMESPACE.test(next.sessionNamespace), 'Invalid sessionNamespace');
  assert(['acp', 'subagent'].includes(next.workerRuntime), 'Invalid workerRuntime');
  assert(
    Number.isSafeInteger(next.workerLimit) && next.workerLimit >= 1 && next.workerLimit <= 20,
    'Worker limit must be 1 to 20',
  );
  assert(
    Array.isArray(next.workerProfiles) &&
      next.workerProfiles.length >= 1 &&
      next.workerProfiles.length <= 5,
    'Worker profiles must contain 1 to 5 entries',
  );
  next.workerProfiles = Object.freeze(
    next.workerProfiles.map((profile) => {
      assert(
        profile && Object.keys(profile).sort().join(',') === 'description,id,model,thinking',
        'Invalid worker profile fields',
      );
      assert(PROFILE_ID.test(profile.id), 'Invalid worker profile id');
      assert(
        typeof profile.model === 'string' &&
          profile.model.trim() === profile.model &&
          profile.model.length > 0 &&
          profile.model.length <= 160,
        'Invalid worker profile model',
      );
      assert(THINKING.has(profile.thinking), 'Invalid worker profile thinking');
      assert(
        typeof profile.description === 'string' &&
          profile.description.trim() === profile.description &&
          profile.description.length > 0 &&
          profile.description.length <= 240,
        'Invalid worker profile description',
      );
      return Object.freeze({ ...profile });
    }),
  );
  assert(
    new Set(next.workerProfiles.map((profile) => profile.id)).size === next.workerProfiles.length,
    'Worker profile ids must be unique',
  );
  current = Object.freeze(next);
  return current;
}

export const topology = () => current;
export const managerAgentIds = () => [current.productAgentId, current.engineeringAgentId];
export const isManagerAgent = (id) => managerAgentIds().includes(id);
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
export const projectSessionKey = (role, scope) =>
  `agent:${agentForRole(role)}:${current.sessionNamespace}:${scope}`;
export const isProjectSessionKey = (key) =>
  managerAgentIds().some((id) =>
    String(key ?? '').startsWith(`agent:${id}:${current.sessionNamespace}:`),
  );
export const workerProfiles = () => current.workerProfiles.map((profile) => ({ ...profile }));
export const workerProfile = (id) => {
  const profile = current.workerProfiles.find((profile) => profile.id === id);
  assert(profile, 'Unknown worker profile');
  return profile;
};
