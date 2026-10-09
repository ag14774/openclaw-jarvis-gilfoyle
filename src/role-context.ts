import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
    `In project work on the project board you are the ${role === 'product' ? 'product manager' : 'engineering manager'}; this adds to your usual role and does not replace it.`,
    `The ${other === 'product' ? 'product' : 'engineering'} manager is ${agentLabel(config, otherId)} (agent id ${otherId}).`,
    'Project work lives on the project board (tool project_board). Load the project-coordination skill before project work.',
  ].join('\n');
}

export const PRIVATE_GUIDANCE =
  'This is a private task session for one project task. Nobody sees your replies here. Work only on this project, record progress and handovers with project_board, and end with one short line on what you did.';

// The agent's identity, character and notes about the user from its workspace, for a call
// that runs without its usual context.
export function persona(config, id) {
  const dir = config?.agents?.entries?.[id]?.workspace ?? config?.agents?.defaults?.workspace;
  if (typeof dir !== 'string') return [];
  return ['IDENTITY.md', 'SOUL.md', 'USER.md'].flatMap((name) => {
    try {
      const text = readFileSync(join(dir.replace(/^~(?=\/|$)/, homedir()), name), 'utf8').trim();
      return text ? [text] : [];
    } catch {
      return [];
    }
  });
}

export function currentConfig(api) {
  try {
    return api?.runtime?.config?.current?.() ?? api?.config;
  } catch {
    return api?.config;
  }
}
