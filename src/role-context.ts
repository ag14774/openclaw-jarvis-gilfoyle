import { roleForAgent, agentForRole } from './topology.js';

// Display name for an agent: identity name, then configured name, then the id.
export function agentLabel(config, id) {
  const agent = config?.agents?.entries?.[id];
  const name = [agent?.identity?.name, agent?.name].find(
    (value) => typeof value === 'string' && value.trim(),
  );
  return name?.replace(/[\x00-\x1f\x7f]/g, ' ').trim() || id;
}

// Static role binding for a manager: its own role, and the counterpart's name and id.
export function projectRoleContext(config, agentId) {
  const role = roleForAgent(agentId);
  if (!role) return null;
  const other = role === 'product' ? 'engineering' : 'product';
  const otherId = agentForRole(other);
  return [
    `Your project role is ${role === 'product' ? 'product manager' : 'engineering manager'}.`,
    `The ${other === 'product' ? 'product' : 'engineering'} manager is ${agentLabel(config, otherId)} (agent id ${otherId}).`,
    'Project work lives on the project board (tool project_board). Load the project-coordination skill before project work.',
  ].join('\n');
}

export const PRIVATE_GUIDANCE =
  'This is a private task session for one project task. Nobody sees your replies here. Work only on this project, record progress and handovers with project_board, and end with NO_REPLY.';

export function currentConfig(api) {
  try {
    return api?.runtime?.config?.current?.() ?? api?.config;
  } catch {
    return api?.config;
  }
}
