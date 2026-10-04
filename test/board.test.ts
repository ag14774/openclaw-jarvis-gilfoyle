import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, JARVIS_DM, JARVIS_GROUP, MINUTE, ref } from './support/harness.ts';
import { taskSessionKey } from '../src/topology.ts';
import { companionMethodAllowed, companionScopes } from '../src/bridge-methods.ts';
import { Store } from '../src/store.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const key = (h, role, id) => taskSessionKey(role, h.runtime.store.task(id));
const agent = { product: 'main', engineering: 'gilfoyle' };
async function project(
  h,
  name = 'Quote Desk',
  chat = { session: JARVIS_GROUP, target: 'telegram:-200' },
) {
  await h.userMessage('main', chat.session, chat.target);
  const created = await h.call('main', chat.session, { operation: 'create_project', name });
  h.endTurn('main', chat.session);
  return created.project;
}

test('a request goes from the user to engineering and back, and the user hears the result', async () => {
  const h = await harness();
  const id = await project(h);
  assert.equal(id, 'quote-desk');
  assert.match(
    (await h.call('main', JARVIS_DM, { operation: 'list' })).projects[0].chat,
    /telegram chat telegram:-200/,
  );

  // The user asks for work in the project chat; Jarvis records it for engineering.
  await h.userMessage('main', JARVIS_GROUP, 'telegram:-200');
  const { task } = await h.call('main', JARVIS_GROUP, {
    operation: 'add_task',
    title: 'Add CSV export',
    body: 'Quotes can be exported as CSV.',
  });
  h.endTurn('main', JARVIS_GROUP);

  // The scan wakes Gilfoyle in the task's private session.
  const gKey = key(h, 'engineering', task);
  assert.deepEqual((await h.tick()).woken, [task]);
  const run = h.native.runs.at(-1);
  assert.equal(run.sessionKey, gKey);
  assert.equal(run.deliver, false);
  assert.match(run.message, /^PROJECT TASK task-\d+-/);
  const card = await h.hooks.before_prompt_build({}, { agentId: 'gilfoyle', sessionKey: gKey });
  assert.match(card.prependContext, /Task #\d+: Add CSV export/);
  assert.match(card.prependContext, /waiting on you \(engineering\)/);
  assert.match(card.prependContext, /sol-low = openai\/gpt-5\.6-sol/);
  assert.match(card.prependSystemContext, /product manager is Jarvis \(agent id main\)/);

  // A running session is not woken again.
  h.advance(2 * MINUTE);
  assert.deepEqual((await h.tick()).woken, []);

  // Gilfoyle spawns a worker with a profile id; the board applies the profile and records it.
  const spawned = await h.spawn(gKey, { agentId: 'opencode', model: 'sol-low', task: 'Implement' });
  assert.equal(spawned.params.model, 'openai/gpt-5.6-sol');
  assert.equal(spawned.params.thinking, 'low');
  assert.equal(spawned.params.runtime, 'acp');
  assert.deepEqual(
    h.runtime.store.task(task).workers.map((w) => w.key),
    [spawned.childSessionKey],
  );

  // Gilfoyle cannot close the user's request; he hands it to product with the result.
  const close = await h.call('gilfoyle', gKey, {
    operation: 'update_task',
    status: 'done',
    note: 'Done',
  });
  assert.match(close.error, /Only the product manager closes tasks it created/);
  const handed = await h.call('gilfoyle', gKey, {
    operation: 'update_task',
    holder: 'product',
    note: 'CSV export merged in PR #7; tests pass.',
  });
  assert.equal(handed.waitingOn, 'product');
  h.endTurn('gilfoyle', gKey);

  // Jarvis is woken with the note.
  const jKey = key(h, 'product', task);
  assert.deepEqual((await h.tick()).woken, [task]);
  assert.match(h.native.runs.at(-1).message, /New from engineering: CSV export merged/);

  // From the private session, closing needs the message for the user; the worker must be done.
  const noMessage = await h.call('main', jKey, {
    operation: 'update_task',
    status: 'done',
    note: 'Accepted',
  });
  assert.match(noMessage.error, /needs message/);
  const busy = await h.call('main', jKey, {
    operation: 'update_task',
    status: 'done',
    note: 'Accepted',
    message: 'CSV export is live.',
  });
  assert.match(busy.error, /still has 1 running worker/);
  h.advance(3 * MINUTE);
  h.native.session(spawned.childSessionKey).hasActiveRun = false;
  const done = await h.call('main', jKey, {
    operation: 'update_task',
    status: 'done',
    note: 'Accepted',
    message: 'CSV export is live.',
  });
  assert.equal(done.status, 'done');
  assert.equal(done.message.state, 'sent');
  const sent = h.native.sent.at(-1);
  assert.equal(sent.conversationRef, ref('b'));
  assert.equal(sent.message, 'CSV export is live.');
  assert.equal(sent.agentId, 'main');

  // Private replies never reach a chat, and closed task sessions are cleaned up.
  assert.equal(h.hooks.message_sending({}, { sessionKey: jKey }).cancel, true);
  h.endAllRuns();
  await h.tick();
  assert.deepEqual(h.native.cleaned.sort(), [gKey, jKey].sort());

  // A late native turn that recreates a closed task's session is blocked, and the next scan
  // removes the session again.
  h.native.session(gKey);
  assert.equal(h.hooks.before_agent_run({}, { sessionKey: gKey }).outcome, 'block');
  await h.tick();
  assert.equal(h.native.cleaned.filter((k) => k === gKey).length, 2);
});

test('a question goes to the user with its message, and the answer goes back to engineering', async () => {
  const h = await harness();
  await project(h);
  const { task } = await h.call('main', JARVIS_DM, {
    operation: 'add_task',
    project: 'quote-desk',
    title: 'Pricing page',
  });
  await h.tick();
  const gKey = key(h, 'engineering', task);
  await h.call('gilfoyle', gKey, {
    operation: 'update_task',
    holder: 'product',
    note: 'Monthly or yearly prices?',
  });
  h.endAllRuns();
  await h.tick();
  const jKey = key(h, 'product', task);

  // Engineering never asks the user directly; product must include the question.
  const direct = await h.call('gilfoyle', gKey, {
    operation: 'update_task',
    holder: 'user',
    note: 'Ask',
  });
  assert.match(direct.error, /Only the product manager hands tasks to the user/);
  const missing = await h.call('main', jKey, {
    operation: 'update_task',
    holder: 'user',
    note: 'Asked the user',
  });
  assert.match(missing.error, /needs message/);
  const asked = await h.call('main', jKey, {
    operation: 'update_task',
    holder: 'user',
    note: 'Asked the user about billing period',
    message: 'Should the pricing page show monthly or yearly prices?',
  });
  assert.equal(asked.waitingOn, 'user');
  assert.equal(h.native.sent.at(-1).conversationRef, ref('b'));
  h.endAllRuns();

  // Nobody is woken while the user holds the task.
  h.advance(2 * 60 * MINUTE);
  assert.deepEqual((await h.tick()).woken, []);

  // In the project chat Jarvis sees the waiting question and records the answer.
  const context = await h.userMessage('main', JARVIS_GROUP, 'telegram:-200');
  assert.match(context.prependContext, /also used as the project chat for "Quote Desk"/);
  assert.match(context.prependContext, /Waiting on the user: Quote Desk task #\d+ "Pricing page"/);
  const answered = await h.call('main', JARVIS_GROUP, {
    operation: 'update_task',
    task,
    holder: 'engineering',
    note: 'User: yearly, with a monthly toggle.',
  });
  assert.equal(answered.waitingOn, 'engineering');
  h.endTurn('main', JARVIS_GROUP);
  assert.deepEqual((await h.tick()).woken, [task]);
  assert.match(h.native.runs.at(-1).message, /User: yearly/);
});

test('in the project chat the reply is the message; elsewhere a message is required', async () => {
  const h = await harness();
  await project(h);
  const { task } = await h.call('main', JARVIS_DM, {
    operation: 'add_task',
    project: 'quote-desk',
    title: 'Logo',
  });
  await h.userMessage('main', JARVIS_GROUP, 'telegram:-200');
  const cancelled = await h.call('main', JARVIS_GROUP, {
    operation: 'update_task',
    task,
    status: 'cancelled',
    note: 'User dropped it',
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(h.native.sent.length, 0);
  const asked = await h.call('main', JARVIS_GROUP, {
    operation: 'add_task',
    title: 'Colour',
    holder: 'product',
  });
  const question = await h.call('main', JARVIS_GROUP, {
    operation: 'update_task',
    task: asked.task,
    holder: 'user',
    note: 'Asked the user',
    message: 'Which colour?',
  });
  assert.equal(question.message.state, 'not sent');
  assert.equal(h.native.sent.length, 0);

  const other = await h.call('main', JARVIS_DM, {
    operation: 'add_task',
    project: 'quote-desk',
    title: 'Font',
  });
  await h.userMessage('main', JARVIS_DM, 'telegram:100');
  const fromDm = await h.call('main', JARVIS_DM, {
    operation: 'update_task',
    task: other.task,
    status: 'cancelled',
    note: 'Dropped',
  });
  assert.match(fromDm.error, /needs message/);
});

test('a task is handed over only by its holder and from its latest state', async () => {
  const h = await harness();
  await project(h);
  // Jarvis asks the user before engineering starts.
  await h.userMessage('main', JARVIS_GROUP, 'telegram:-200');
  const { task } = await h.call('main', JARVIS_GROUP, {
    operation: 'add_task',
    title: 'Summary header',
    holder: 'product',
  });
  await h.call('main', JARVIS_GROUP, {
    operation: 'update_task',
    task,
    holder: 'user',
    note: 'Asked for the header text',
  });
  h.endTurn('main', JARVIS_GROUP);
  const taken = await h.call('gilfoyle', key(h, 'engineering', task), {
    operation: 'update_task',
    holder: 'product',
    note: 'Need the exact text',
  });
  assert.match(taken.error, /waiting on user; add a note instead/);

  // A private product session reads the task; meanwhile the chat records the user's answer.
  const jKey = key(h, 'product', task);
  await h.hooks.before_prompt_build({}, { agentId: 'main', sessionKey: jKey });
  await h.userMessage('main', JARVIS_GROUP, 'telegram:-200');
  await h.call('main', JARVIS_GROUP, {
    operation: 'update_task',
    task,
    holder: 'engineering',
    note: 'User: "Copied Summary"',
  });
  const stale = await h.call('main', jKey, {
    operation: 'update_task',
    holder: 'user',
    note: 'Ask again',
    message: 'What should the header say?',
  });
  assert.match(
    stale.error,
    /changed since you read it \(latest from product: User: "Copied Summary"\)/,
  );
  await h.call('main', jKey, { operation: 'show' });
  const current = await h.call('main', jKey, {
    operation: 'update_task',
    holder: 'product',
    note: 'Taking it back to check the wording',
  });
  assert.equal(current.waitingOn, 'product');
});

test('private task sessions follow the model chosen in the project chat', async () => {
  const h = await harness();
  await project(h);
  const chat = h.native.session(JARVIS_GROUP);
  Object.assign(chat, {
    model: 'gpt-5.6-sol',
    modelProvider: 'openai',
    modelOverrideSource: 'user',
    thinkingLevel: 'high',
  });
  await h.userMessage('main', JARVIS_GROUP, 'telegram:-200');
  const { task } = await h.call('main', JARVIS_GROUP, { operation: 'add_task', title: 'Totals' });
  h.endTurn('main', JARVIS_GROUP);
  await h.tick();
  const gKey = key(h, 'engineering', task);
  assert.deepEqual(h.native.patches.slice(-2), [
    { key: gKey, agentId: 'gilfoyle', model: 'openai/gpt-5.6-sol' },
    { key: gKey, agentId: 'gilfoyle', thinkingLevel: 'high' },
  ]);

  // Without a choice in the chat the session goes back to the agent's defaults.
  Object.assign(chat, { modelOverrideSource: null, thinkingLevel: undefined });
  await h.call('gilfoyle', gKey, { operation: 'update_task', holder: 'product', note: 'Done?' });
  h.endAllRuns();
  await h.tick();
  const jKey = key(h, 'product', task);
  assert.deepEqual(h.native.patches.slice(-2), [
    { key: jKey, agentId: 'main', model: null },
    { key: jKey, agentId: 'main', thinkingLevel: null },
  ]);

  // A message in the project chat records the session OpenClaw routed it to; a message in
  // another chat (the DM) does not.
  const moved = 'agent:main:telegram:group:-200:reset-scope';
  h.native.session(moved);
  await h.userMessage('main', moved, 'telegram:-200');
  await h.userMessage('main', JARVIS_DM, 'telegram:100');
  assert.equal(h.runtime.store.project('quote-desk').route.sessionKey, moved);

  // The companion lets sessions.patch touch only the model settings of private sessions.
  assert(companionMethodAllowed('sessions.patch', { key: gKey, agentId: 'gilfoyle', model: null }));
  assert(
    !companionMethodAllowed('sessions.patch', { key: JARVIS_GROUP, agentId: 'main', model: null }),
  );
  assert(!companionMethodAllowed('sessions.patch', { key: gKey, agentId: 'gilfoyle', label: 'x' }));
  assert(
    !companionMethodAllowed('sessions.patch', {
      key: gKey,
      agentId: 'gilfoyle',
      model: null,
      thinkingLevel: null,
    }),
  );
  // A model is never sent with admin scope, which would make it the configured default.
  assert(!companionScopes('sessions.patch', { key: gKey, model: 'x' }).includes('operator.admin'));
  assert(
    companionScopes('sessions.patch', { key: gKey, thinkingLevel: 'high' }).includes(
      'operator.admin',
    ),
  );
});

test('roles, project isolation and closed tasks are enforced', async () => {
  const h = await harness();
  await project(h, 'Alpha');
  await project(h, 'Beta', { session: JARVIS_DM, target: 'telegram:100' });
  const a = await h.call('main', JARVIS_DM, {
    operation: 'add_task',
    project: 'alpha',
    title: 'A1',
  });
  const b = await h.call('main', JARVIS_DM, {
    operation: 'add_task',
    project: 'beta',
    title: 'B1',
  });
  const gKey = key(h, 'engineering', a.task);

  assert.match(
    (await h.call('gilfoyle', gKey, { operation: 'create_project', name: 'X' })).error,
    /Only the product manager creates/,
  );
  assert.match(
    (await h.call('gilfoyle', gKey, { operation: 'notify', message: 'hi' })).error,
    /Only the product manager messages/,
  );
  assert.match(
    (await h.call('gilfoyle', gKey, { operation: 'update_project', state: 'paused' })).error,
    /may only change the project context/,
  );
  assert.equal(
    (await h.call('gilfoyle', gKey, { operation: 'update_project', context: 'Repo: /src/alpha' }))
      .project,
    'alpha',
  );
  assert.match(
    (await h.call('gilfoyle', gKey, { operation: 'update_task', task: b.task, note: 'x' })).error,
    /only on its own project/,
  );
  assert.match(
    (await h.call('gilfoyle', gKey, { operation: 'show', project: 'beta' })).error,
    /only on its own project/,
  );
  assert.deepEqual(
    (await h.call('gilfoyle', gKey, { operation: 'list' })).projects.map((p) => p.id),
    ['alpha'],
  );
  assert.match(
    (await h.call('main', key(h, 'engineering', a.task), { operation: 'list' })).error,
    /belongs to the other manager/,
  );
  assert.equal(h.tool('opencode', 'agent:opencode:x'), null);

  // Handover and closing carry notes; closed tasks are read-only until product reopens them.
  assert.match(
    (await h.call('main', JARVIS_DM, { operation: 'update_task', task: a.task, holder: 'product' }))
      .error,
    /needs a note/,
  );
  await h.call('main', JARVIS_DM, {
    operation: 'update_task',
    task: a.task,
    status: 'cancelled',
    note: 'No',
    message: 'Dropped A1',
  });
  assert.match(
    (await h.call('gilfoyle', gKey, { operation: 'update_task', note: 'more' })).error,
    /is cancelled/,
  );
  const reopened = await h.call('main', JARVIS_DM, {
    operation: 'update_task',
    task: a.task,
    status: 'open',
    note: 'Back on',
  });
  assert.equal(reopened.waitingOn, 'engineering');
  // Engineering can close its own tasks without a user message.
  const own = await h.call('gilfoyle', gKey, {
    operation: 'add_task',
    title: 'Refactor',
    holder: 'engineering',
  });
  assert.equal(
    (
      await h.call('gilfoyle', gKey, {
        operation: 'update_task',
        task: own.task,
        status: 'done',
        note: 'Refactored',
      })
    ).status,
    'done',
  );
});

test('a holder who does nothing is reported to the user once, and a change resets it', async () => {
  const h = await harness();
  await project(h);
  const { task } = await h.call('main', JARVIS_DM, {
    operation: 'add_task',
    project: 'quote-desk',
    title: 'Stuck',
  });
  for (let i = 0; i < 3; i++) {
    assert.deepEqual((await h.tick()).woken, [task]);
    h.endAllRuns();
    h.advance(61 * MINUTE);
  }
  const stall = await h.tick();
  assert.deepEqual(stall.stalled, [task]);
  assert.match(
    h.native.sent.at(-1).message,
    /waiting on Gilfoyle and nothing has changed after 3 check-ins/,
  );
  h.advance(3 * 60 * MINUTE);
  assert.deepEqual(await h.tick().then((s) => [s.woken, s.stalled]), [[], []]);
  assert.equal(h.native.sent.length, 1);
  // Anyone touching the task clears the stall and wakes the holder.
  await h.call('main', JARVIS_DM, { operation: 'update_task', task, note: 'Any news?' });
  assert.deepEqual((await h.tick()).woken, [task]);
});

test('check_in_minutes schedules the next wake, and running workers do not count as idle', async () => {
  const h = await harness();
  await project(h);
  const { task } = await h.call('main', JARVIS_DM, {
    operation: 'add_task',
    project: 'quote-desk',
    title: 'CI',
  });
  await h.tick();
  const gKey = key(h, 'engineering', task);
  await h.spawn(gKey, { agentId: 'opencode', model: 'astra', task: 'Build' });
  await h.call('gilfoyle', gKey, {
    operation: 'update_task',
    note: 'Waiting for CI',
    check_in_minutes: 10,
  });
  h.endAllRuns();
  h.advance(9 * MINUTE);
  assert.deepEqual((await h.tick()).woken, []);
  h.advance(2 * MINUTE);
  assert.deepEqual((await h.tick()).woken, [task]);
  assert.match(h.native.runs.at(-1).message, /workers are still running/);
  for (let i = 0; i < 5; i++) {
    h.endAllRuns();
    h.advance(61 * MINUTE);
    assert.deepEqual((await h.tick()).stalled, []);
  }
});

test('cancelling stops the task’s workers', async () => {
  const h = await harness();
  await project(h);
  const { task } = await h.call('main', JARVIS_DM, {
    operation: 'add_task',
    project: 'quote-desk',
    title: 'Big',
  });
  await h.tick();
  const w = await h.spawn(key(h, 'engineering', task), {
    agentId: 'opencode',
    model: 'sol-low',
    task: 'x',
  });
  await h.call('main', JARVIS_DM, {
    operation: 'update_task',
    task,
    status: 'cancelled',
    note: 'Stop',
    message: 'Stopped.',
  });
  assert.deepEqual(h.native.aborted, [w.childSessionKey]);
});

test('worker spawns need a profile, respect the limit, and are refused when paused', async () => {
  const h = await harness();
  await project(h);
  const t1 = await h.call('main', JARVIS_DM, {
    operation: 'add_task',
    project: 'quote-desk',
    title: 'One',
  });
  const k = await (async () => {
    await h.tick();
    return key(h, 'engineering', t1.task);
  })();
  assert.match(
    (await h.spawn(k, { agentId: 'opencode', model: 'gpt-9', task: 'x' })).blocked,
    /profile id: sol-low, astra/,
  );
  await h.spawn(k, { agentId: 'opencode', model: 'sol-low', task: 'x' });
  await h.spawn(k, { agentId: 'opencode', model: 'sol-low', task: 'y' });
  assert.match(
    (await h.spawn(k, { agentId: 'opencode', model: 'sol-low', task: 'z' })).blocked,
    /2 workers are already running/,
  );
  // Spawning some other agent (research) is not the worker pool and is allowed.
  assert.ok((await h.spawn(k, { agentId: 'researcher', task: 'look' })).childSessionKey);
  await h.call('main', JARVIS_DM, {
    operation: 'update_project',
    project: 'quote-desk',
    state: 'paused',
  });
  assert.match((await h.spawn(k, { agentId: 'researcher', task: 'look' })).blocked, /paused/);
  // sessions_send only reaches the task's own workers; the message tool is refused.
  const send = await h.hooks.before_tool_call(
    { toolName: 'sessions_send', params: { sessionKey: JARVIS_DM } },
    { agentId: 'gilfoyle', sessionKey: k },
  );
  assert.equal(send.block, true);
  const msg = await h.hooks.before_tool_call(
    { toolName: 'message', params: {} },
    { agentId: 'gilfoyle', sessionKey: k },
  );
  assert.equal(msg.block, true);
});

test('paused projects are not woken; resuming asks the holders to look again', async () => {
  const h = await harness();
  await project(h);
  const { task } = await h.call('main', JARVIS_DM, {
    operation: 'add_task',
    project: 'quote-desk',
    title: 'Later',
  });
  await h.call('main', JARVIS_DM, {
    operation: 'update_project',
    project: 'quote-desk',
    state: 'paused',
  });
  h.advance(3 * 60 * MINUTE);
  assert.deepEqual((await h.tick()).woken, []);
  await h.call('main', JARVIS_DM, {
    operation: 'update_project',
    project: 'quote-desk',
    state: 'active',
  });
  assert.deepEqual((await h.tick()).woken, [task]);
  assert.match(
    (
      await h.call('main', JARVIS_DM, {
        operation: 'update_project',
        project: 'quote-desk',
        state: 'archived',
      })
    ).error,
    /Close or cancel/,
  );
});

test('each manager runs at most the configured number of private sessions at once', async () => {
  const h = await harness({ config: { maxWakesPerRole: 1 } });
  await project(h);
  const one = await h.call('main', JARVIS_DM, {
    operation: 'add_task',
    project: 'quote-desk',
    title: 'One',
  });
  const two = await h.call('main', JARVIS_DM, {
    operation: 'add_task',
    project: 'quote-desk',
    title: 'Two',
  });
  assert.deepEqual((await h.tick()).woken, [one.task]);
  h.advance(2 * MINUTE);
  assert.deepEqual((await h.tick()).woken, []);
  h.endAllRuns();
  assert.deepEqual((await h.tick()).woken, [two.task]);
});

test('messages fall back to the owner DM, never rebind, and retry with the same operation', async () => {
  const h = await harness();
  await project(h);
  // The project chat rejects messages: straight to the owner DM, with the project name.
  h.native.sendStatus = (p) => (p.conversationRef === ref('b') ? 'suppressed' : 'sent');
  const rejected = await h.call('main', JARVIS_DM, {
    operation: 'notify',
    project: 'quote-desk',
    message: 'Hello',
  });
  assert.equal(rejected.state, 'sent');
  assert.deepEqual(
    [h.native.sent.at(-1).conversationRef, h.native.sent.at(-1).message],
    [ref('a'), '[Quote Desk] Hello'],
  );
  assert.equal(h.runtime.store.project('quote-desk').route.conversationRef, ref('b'));

  // Errors retry on the project chat with one operation id, then fall back.
  let tries = 0;
  h.native.sendStatus = (p) => (p.conversationRef === ref('b') ? (tries++, 'throw') : 'queued');
  const retrying = await h.call('main', JARVIS_DM, {
    operation: 'notify',
    project: 'quote-desk',
    message: 'Again',
  });
  assert.equal(retrying.state, 'retrying');
  h.advance(3 * MINUTE);
  await h.tick();
  h.advance(5 * MINUTE);
  await h.tick();
  assert.equal(tries, 3);
  const operations = h.native.calls
    .filter(([m, p]) => m === 'conversations.send' && p.message === 'Again')
    .map(([, p]) => p.operationId);
  assert.equal(new Set(operations.slice(0, 3)).size, 1);
  assert.equal(h.native.sent.at(-1).message, '[Quote Desk] Again');
  assert.equal(h.runtime.store.get("SELECT state FROM outbox WHERE text='Again'").state, 'handed');
});

test('use_this_chat binds only the chat of the message that started the turn', async () => {
  const h = await harness();
  await project(h, 'Quote Desk', { session: JARVIS_DM, target: 'telegram:100' });
  assert.equal(h.runtime.store.project('quote-desk').route.conversationRef, ref('a'));
  // A turn with no new message (cron, heartbeat) has no chat to bind.
  await h.hooks.before_prompt_build({}, { agentId: 'main', sessionKey: JARVIS_GROUP });
  assert.match(
    (await h.call('main', JARVIS_GROUP, { operation: 'update_project', use_this_chat: true }))
      .error,
    /needs a current user message/,
  );
  // A new message in the group, then use_this_chat.
  await h.userMessage('main', JARVIS_GROUP, 'telegram:-200');
  await h.call('main', JARVIS_GROUP, { operation: 'update_project', use_this_chat: true });
  assert.equal(h.runtime.store.project('quote-desk').route.conversationRef, ref('b'));
  // Private sessions have no chat.
  const { task } = await h.call('main', JARVIS_DM, { operation: 'add_task', title: 'x' });
  const jKey = key(h, 'product', task);
  assert.match(
    (await h.call('main', jKey, { operation: 'update_project', use_this_chat: true })).error,
    /needs a current user message/,
  );
});

test('the plugin stays out of personal work and non-manager agents', async () => {
  const h = await harness();
  // Jarvis spawning or messaging from a personal chat is untouched.
  assert.equal(
    await h.hooks.before_tool_call(
      { toolName: 'sessions_spawn', params: { agentId: 'opencode' } },
      { agentId: 'main', sessionKey: JARVIS_DM },
    ),
    undefined,
  );
  assert.equal(
    await h.hooks.before_tool_call(
      { toolName: 'message', params: {} },
      { agentId: 'main', sessionKey: JARVIS_DM },
    ),
    undefined,
  );
  assert.equal(h.hooks.message_sending({}, { sessionKey: JARVIS_DM }), undefined);
  assert.equal(h.hooks.before_agent_run({}, { sessionKey: JARVIS_DM }), undefined);
  // Other agents get nothing.
  assert.equal(
    await h.hooks.before_prompt_build({}, { agentId: 'opencode', sessionKey: 'agent:opencode:x' }),
    undefined,
  );
  assert.equal(
    await h.hooks.before_tool_call(
      { toolName: 'sessions_spawn', params: {} },
      { agentId: 'opencode', sessionKey: 'agent:opencode:x' },
    ),
    undefined,
  );
  // A personal chat without projects gets only the role line.
  const personal = await h.userMessage('main', 'agent:main:telegram:direct:999', 'telegram:999');
  assert.equal(personal.prependContext, undefined);
  assert.match(
    personal.prependSystemContext,
    /project work .* adds to your usual role and does not replace it/,
  );
  assert.match(
    personal.prependSystemContext,
    /engineering manager is Gilfoyle \(agent id gilfoyle\)/,
  );
});

test('the board file persists across restarts and a foreign database is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-'));
  const path = join(dir, 'state.sqlite');
  const first = new Store(path);
  first.run("INSERT INTO projects(id,name,created,updated) VALUES('kept','Kept',1,1)");
  first.close();
  const reopened = new Store(path);
  assert.equal(reopened.project('kept').name, 'Kept');
  reopened.close();

  const foreign = join(dir, 'other.sqlite');
  const other = new DatabaseSync(foreign);
  other.exec('PRAGMA user_version=99');
  other.close();
  assert.throws(() => new Store(foreign), /not a project board \(schema 99, expected 16\)/);
  rmSync(dir, { recursive: true, force: true });
});

test('registrations in one process share the board, so a chat seen by the hooks binds the tool call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-'));
  const h = await harness({ config: { statePath: join(dir, 'state.sqlite') } });
  // OpenClaw runs the hooks from its gateway registration and the tool from another one.
  const otherTool = h.registerAgain();
  await h.userMessage('main', JARVIS_DM, 'telegram:100');
  const run = (args) => otherTool({ agentId: 'main', sessionKey: JARVIS_DM }).execute('call', args);
  const created = JSON.parse(
    (await run({ operation: 'create_project', name: 'Quote Desk' })).content[0].text,
  );
  assert.match(created.chat, /telegram DM telegram:100/);
  h.runtime.store.close();
  rmSync(dir, { recursive: true, force: true });
});
