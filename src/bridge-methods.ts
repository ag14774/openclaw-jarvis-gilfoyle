const methods = new Set([
  'conversations.list',
  'conversations.send',
  'workboard.boards.list',
  'workboard.boards.upsert',
  'workboard.cards.list',
  'workboard.cards.create',
  'workboard.cards.update',
  'workboard.cards.comment',
  'workboard.cards.claim',
  'workboard.cards.release',
  'workboard.cards.complete',
  'workboard.cards.proof',
  'tasks.list',
  'tasks.get',
  'sessions.list',
  'sessions.create',
  'sessions.delete',
  'agent',
  'jarvis-gilfoyle.projects.guard',
]);

export const companionMethodAllowed = (method) => methods.has(method);
