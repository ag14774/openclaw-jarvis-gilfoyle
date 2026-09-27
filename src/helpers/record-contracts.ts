import { topology } from '../topology.js';

export const isManagerActor = (actor, role) =>
  typeof actor === 'string' &&
  actor.startsWith(`agent:${role}:`) &&
  actor.length > `agent:${role}:`.length &&
  actor.length <= 300 &&
  !/[\s\0]/.test(actor);

export function assertNoNativeCardLinks(card) {
  if (
    !card ||
    card.createdByCardId ||
    card.metadata?.createdByCardId ||
    card.metadata?.automation?.createdByCardId ||
    (card.metadata?.links ?? []).some((link) => ['parent', 'child'].includes(link?.type))
  )
    throw new Error('Native card relationships are forbidden; use registry relationships');
}

export const controllerKey = (records, card, agentId = topology().engineeringAgentId) => {
  const obligation = records.obligations.find((row) => row.card === card.id);
  return obligation
    ? `agent:${agentId}:${topology().sessionNamespace}:${obligation.feature}`
    : `agent:${agentId}:main`;
};

export function assertTaskIdentity(prompt, cardId, taskName) {
  const lines = String(prompt ?? '').split(/\r?\n/);
  const work = lines.filter((line) => line.startsWith('Work item: '));
  const task = lines.filter((line) => line.startsWith('Task name: '));
  if (
    work.length !== 1 ||
    task.length !== 1 ||
    work[0] !== `Work item: ${cardId}` ||
    task[0] !== `Task name: ${taskName}`
  )
    throw new Error('Exact line-delimited task identity required');
  return true;
}

export function assertChildSession(key) {
  const { workerAgentId, workerRuntime } = topology();
  const id = String(key ?? '')
    .split(':')
    .at(-1);
  if (
    key !== `agent:${workerAgentId}:${workerRuntime}:${id}` ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)
  )
    throw new Error('Exact worker child session required');
  return key;
}
