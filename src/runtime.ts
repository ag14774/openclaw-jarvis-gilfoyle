import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import {
  agentForRole,
  isManagerAgent,
  isPrivateSession,
  parseTaskSession,
  roleForAgent,
  taskScope,
  taskSessionKey,
  topology,
} from './topology.js';

const MINUTE = 60 * 1000;
export const CHECK_IN_MINUTES = 60;
export const STALL_WAKES = 3;
const WAKE_RETRY_MINUTES = 5;
const WAKE_GRACE_MS = MINUTE;
const WORKER_GRACE_MS = 2 * MINUTE;
const STALE_RUN_MS = 6 * 60 * MINUTE;
const SOURCE_FRESH_MS = 10 * MINUTE;
const ROUTE_CACHE_MS = 24 * 60 * MINUTE;
const PREFERRED_ATTEMPTS = 3;
const FALLBACK_ATTEMPTS = 10;
const ROLES = ['product', 'engineering'];
const HOLDERS = ['product', 'engineering', 'user'];

const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
export function text(value, max, name) {
  assert(typeof value === 'string', `${name} must be text`);
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  assert(normalized, `${name} must not be empty`);
  assert(normalized.length <= max, `${name} must be at most ${max} characters`);
  assert(!CONTROL.test(normalized), `${name} must not contain control characters`);
  return normalized;
}
const line = (value, max, name) =>
  text(typeof value === 'string' ? value.replace(/\s+/g, ' ') : value, max, name);
const optional = (value, max, name) =>
  value === undefined || value === null || value === '' ? undefined : text(value, max, name);
const clip = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const slug = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '') || 'project';

export const conversation = (value) => {
  assert(
    value && /^conv_[a-f0-9]{30,64}$/.test(value.conversationRef ?? ''),
    'Native conversation reference required',
  );
  return {
    conversationRef: value.conversationRef,
    channel: String(value.channel ?? ''),
    accountId: String(value.accountId ?? 'default'),
    target: String(value.target ?? ''),
    kind: String(value.kind ?? ''),
    ...(value.threadId ? { threadId: String(value.threadId) } : {}),
  };
};
const chatLabel = (route) =>
  route
    ? `${route.channel} ${route.kind === 'direct' ? 'DM' : 'chat'} ${route.target}`
    : 'the owner DM (no project chat bound yet)';

// A native session row is working when its own turn is live (not a stale leftover) or,
// for workers, when descendants still run.
export const rowLive = (row, now) =>
  row?.hasActiveRun === true && !(now - Number(row.updatedAt) > STALE_RUN_MS);
const rowBusy = (row, now) => rowLive(row, now) || row?.hasActiveSubagentRun === true;

export class BoardRuntime {
  constructor(
    store,
    rpc,
    {
      ownerChat = null,
      now = () => Date.now(),
      log = () => {},
      turnTimeoutSeconds = 1800,
      maxWakesPerRole = 2,
      agentName = (role) => role,
    } = {},
  ) {
    this.store = store;
    this.rpc = rpc;
    this.ownerChat = ownerChat;
    this.now = now;
    this.log = log;
    this.turnTimeoutSeconds = turnTimeoutSeconds;
    this.maxWakesPerRole = maxWakesPerRole;
    this.agentName = agentName;
    this.sources = new Map(); // session -> newest inbound chat {route, at, used}
    this.turns = new Map(); // session -> the inbound chat of the running turn
    this.captures = new Map(); // session -> route resolution still in progress
    this.routeCache = new Map();
    this.wakes = new Map(); // session -> dispatch time (until the run shows up as live)
    this.seen = new Map(); // "session|task" -> newest note id read or written in this turn
    this.ownerRouteCache = null;
    this.stopped = false;
    this.health = { lastScan: null, lastError: null };
  }

  // ---- Who is calling, from where ----------------------------------------------------

  caller(ctx = {}) {
    const agentId = ctx.agentId ?? /^agent:([^:]+):/.exec(ctx.sessionKey ?? '')?.[1];
    const role = roleForAgent(agentId);
    assert(role, 'Only the product and engineering managers use the project board');
    const scope = parseTaskSession(ctx.sessionKey);
    let task = null;
    if (scope) {
      assert(scope.role === role, 'This private session belongs to the other manager');
      task = this.store.task(scope.taskId);
      assert(task.created === scope.created, 'This private session belongs to a removed task');
    } else assert(!isPrivateSession(ctx.sessionKey), 'This private session has no task');
    return {
      role,
      task,
      session: ctx.sessionKey ?? '',
      source: task ? null : (this.turns.get(ctx.sessionKey) ?? null),
    };
  }
  scopeProject(caller, id) {
    if (caller.task) {
      assert(
        id === undefined || id === caller.task.project,
        'A task session works only on its own project',
      );
      return this.store.project(caller.task.project);
    }
    if (id !== undefined) return this.store.project(id);
    const live = this.store.projects().filter((project) => project.state !== 'archived');
    const here = caller.source?.route
      ? live.filter(
          (project) => project.route?.conversationRef === caller.source.route.conversationRef,
        )
      : [];
    const candidates = here.length ? here : live;
    assert(
      candidates.length === 1,
      `Pass project: ${live.map((project) => `${project.id} (${project.name})`).join(', ') || 'no projects yet'}`,
    );
    return candidates[0];
  }
  scopeTask(caller, id) {
    if (id === undefined && caller.task) return this.store.task(caller.task.id);
    assert(id !== undefined, 'Pass task (the task number)');
    const task = this.store.task(id);
    assert(
      !caller.task || task.project === caller.task.project,
      'A task session works only on its own project',
    );
    return task;
  }
  // Whether the caller is talking in the chat where this project's messages go (its
  // project chat, or the owner DM for a project without one).
  inProjectChat(caller, project) {
    const here = caller.source?.route?.conversationRef;
    const there = project.route?.conversationRef ?? this.ownerRouteCache?.route?.conversationRef;
    return Boolean(here && there && here === there);
  }

  // ---- Operations --------------------------------------------------------------------

  async operation(operation, input = {}, ctx = {}) {
    const caller = this.caller(ctx);
    const handlers = {
      list: () => this.list(caller, input),
      show: () => this.show(caller, input),
      create_project: () => this.createProject(caller, input),
      update_project: () => this.updateProject(caller, input),
      add_task: () => this.addTask(caller, input),
      update_task: () => this.updateTask(caller, input),
      notify: () => this.notify(caller, input),
    };
    assert(handlers[operation], `Unknown operation ${operation}`);
    return handlers[operation]();
  }

  taskView(task, detail = false) {
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      ...(task.status === 'open' ? { waitingOn: task.holder } : {}),
      ...(task.stalled ? { stalled: when(task.stalled) } : {}),
      updated: when(task.updated),
      ...(detail
        ? {
            project: task.project,
            body: task.body,
            createdBy: task.created_by,
            workers: task.workers.map((worker) => worker.key),
            ...(task.check_at && task.status === 'open'
              ? { nextCheckIn: when(task.check_at) }
              : {}),
          }
        : {}),
    };
  }
  projectView(project) {
    const open = this.store.all(
      "SELECT * FROM tasks WHERE project=? AND status='open' ORDER BY id",
      project.id,
    );
    const closed = this.store.all(
      "SELECT * FROM tasks WHERE project=? AND status<>'open' ORDER BY updated DESC LIMIT 3",
      project.id,
    );
    const failed = this.store.all(
      "SELECT id,task,text,error FROM outbox WHERE project=? AND state='failed' ORDER BY id DESC LIMIT 3",
      project.id,
    );
    return {
      id: project.id,
      name: project.name,
      state: project.state,
      chat: chatLabel(project.route),
      open: open.map((row) => this.taskView({ ...row, workers: [] })),
      recentlyClosed: closed.map((row) => ({ id: row.id, title: row.title, status: row.status })),
      ...(failed.length
        ? {
            undeliveredMessages: failed.map((row) => ({
              id: row.id,
              task: row.task,
              text: clip(row.text, 200),
              error: row.error,
            })),
          }
        : {}),
    };
  }
  list(caller, input) {
    const projects =
      input.project !== undefined || caller.task
        ? [this.scopeProject(caller, input.project)]
        : this.store.projects().filter((project) => project.state !== 'archived');
    return { projects: projects.map((project) => this.projectView(project)) };
  }
  show(caller, input) {
    if (input.task !== undefined || (caller.task && input.project === undefined)) {
      const task = this.scopeTask(caller, input.task);
      this.markSeen(caller.session, task.id);
      return {
        task: this.taskView(task, true),
        notes: this.store.notes(task.id).map((note) => ({
          by: note.author,
          at: when(note.created),
          text: note.text,
        })),
      };
    }
    const project = this.scopeProject(caller, input.project);
    return { project: { ...this.projectView(project), context: project.context } };
  }
  createProject(caller, input) {
    assert(caller.role === 'product', 'Only the product manager creates projects');
    const name = line(input.name, 120, 'name');
    const context = optional(input.context, 8000, 'context') ?? '';
    const base = slug(name);
    let id = base;
    for (let n = 2; this.store.get('SELECT 1 FROM projects WHERE id=?', id); n++)
      id = `${base}-${n}`;
    const route = caller.source?.route
      ? { ...caller.source.route, sessionKey: caller.session }
      : null;
    const now = this.now();
    this.store.run(
      'INSERT INTO projects(id,name,context,route,created,updated) VALUES(?,?,?,?,?,?)',
      id,
      name,
      context,
      route ? JSON.stringify(route) : null,
      now,
      now,
    );
    return { project: id, name, chat: chatLabel(route) };
  }
  updateProject(caller, input) {
    const project = this.scopeProject(caller, input.project);
    const fields = ['name', 'context', 'state', 'use_this_chat'].filter(
      (key) => input[key] !== undefined,
    );
    assert(fields.length, 'Pass name, context, state or use_this_chat');
    assert(
      caller.role === 'product' || fields.every((key) => key === 'context'),
      'The engineering manager may only change the project context',
    );
    const now = this.now();
    const changes = {};
    if (input.name !== undefined) changes.name = line(input.name, 120, 'name');
    if (input.context !== undefined) changes.context = String(input.context).trim().slice(0, 8000);
    if (input.use_this_chat) {
      const route = caller.source?.route;
      assert(
        route,
        'use_this_chat needs a current user message in a chat the plugin can reply to (not a private task session)',
      );
      changes.route = JSON.stringify({ ...route, sessionKey: caller.session });
    }
    if (input.state !== undefined) {
      assert(
        ['active', 'paused', 'archived'].includes(input.state),
        'state is active, paused or archived',
      );
      if (input.state === 'archived')
        assert(
          !this.store.get("SELECT 1 FROM tasks WHERE project=? AND status='open'", project.id),
          'Close or cancel the open tasks before archiving the project',
        );
      changes.state = input.state;
    }
    this.store.tx(() => {
      for (const [key, value] of Object.entries(changes))
        this.store.run(`UPDATE projects SET ${key}=?,updated=? WHERE id=?`, value, now, project.id);
      // Resuming a project asks whoever holds each open task to look again.
      if (changes.state === 'active' && project.state !== 'active')
        this.store.run(
          "UPDATE tasks SET poked=?,idle_wakes=0,stalled=NULL WHERE project=? AND status='open' AND holder IN ('product','engineering')",
          now,
          project.id,
        );
    });
    const updated = this.store.project(project.id);
    this.requestTick();
    return {
      project: updated.id,
      name: updated.name,
      state: updated.state,
      chat: chatLabel(updated.route),
    };
  }
  addTask(caller, input) {
    const project = this.scopeProject(caller, input.project);
    assert(project.state !== 'archived', 'The project is archived');
    const holder = input.holder ?? 'engineering';
    assert(
      ROLES.includes(holder),
      'A new task is held by product or engineering; to ask the user first, add it for product and then hand it to the user',
    );
    const title = line(input.title, 200, 'title');
    const body = optional(input.body, 8000, 'body') ?? '';
    const now = this.now();
    const id = Number(
      this.store.run(
        'INSERT INTO tasks(project,title,body,holder,created_by,poked,check_at,created,updated) VALUES(?,?,?,?,?,?,?,?,?)',
        project.id,
        title,
        body,
        holder,
        caller.role,
        holder === caller.role ? null : now,
        now + CHECK_IN_MINUTES * MINUTE,
        now,
        now,
      ).lastInsertRowid,
    );
    this.markSeen(caller.session, id);
    this.requestTick();
    return { task: id, project: project.id, waitingOn: holder };
  }
  async updateTask(caller, input) {
    const task = this.scopeTask(caller, input.task);
    const project = this.store.project(task.project);
    const note = optional(input.note, 4000, 'note');
    const message = optional(input.message, 4000, 'message');
    const status = input.status;
    const holder = input.holder;
    assert(
      [note, message, status, holder, input.check_in_minutes].some((value) => value !== undefined),
      'Pass note, holder, status, message or check_in_minutes',
    );
    assert(
      status === undefined || ['open', 'done', 'cancelled'].includes(status),
      'status is open, done or cancelled',
    );
    assert(
      holder === undefined || HOLDERS.includes(holder),
      'holder is product, engineering or user',
    );
    const closing = status === 'done' || status === 'cancelled';
    const reopening = status === 'open' && task.status !== 'open';
    assert(!(closing && holder), 'Pass either holder or a closing status, not both');
    if (task.status !== 'open') {
      assert(
        reopening,
        `Task #${task.id} is ${task.status}; the product manager can reopen it with status open`,
      );
      assert(caller.role === 'product', 'Only the product manager reopens tasks');
      assert(project.state !== 'archived', 'The project is archived');
    }
    if (closing) {
      assert(note, 'Closing a task needs a note with the result or the reason');
      assert(
        caller.role === 'product' || task.created_by === 'engineering',
        'Only the product manager closes tasks it created; hand it to product with your result in a note',
      );
    }
    const newHolder = closing ? null : (holder ?? (reopening ? 'engineering' : task.holder));
    const handover = !closing && newHolder !== task.holder;
    if (handover || closing || reopening) {
      // Decisions are made on the latest state: another session may have changed the
      // task since this one read it in this turn.
      const seen = this.seen.get(`${caller.session}|${task.id}`);
      const last = this.latestNote(task.id);
      assert(
        seen === undefined || seen >= (last?.id ?? 0),
        `Task #${task.id} changed since you read it${last ? ` (latest from ${last.author}: ${clip(last.text, 300)})` : ''}; read it with show, then decide again`,
      );
    }
    if (handover) {
      assert(note, 'Handing a task over needs a note saying what is needed');
      assert(
        ROLES.includes(newHolder) || caller.role === 'product',
        'Only the product manager hands tasks to the user',
      );
    }
    if (handover || closing)
      assert(
        caller.role === 'product' || task.holder === 'engineering',
        `Task #${task.id} is waiting on ${task.holder}; add a note instead of handing it over`,
      );
    if (message !== undefined)
      assert(caller.role === 'product', 'Only the product manager messages the user');
    // Required notifications travel with the change that requires them.
    const mustTell =
      (newHolder === 'user' && task.holder !== 'user') ||
      (closing && task.created_by === 'product');
    // In the project chat the reply is the message; sending it too would say it twice.
    const inChat = this.inProjectChat(caller, project);
    if (mustTell && !message && !inChat)
      assert.fail(
        `${newHolder === 'user' ? 'Handing a task to the user' : 'Closing a user request'} needs message: the text the user receives in ${chatLabel(project.route)}`,
      );
    let checkIn;
    if (input.check_in_minutes !== undefined) {
      checkIn = Number(input.check_in_minutes);
      assert(
        Number.isInteger(checkIn) && checkIn >= 1 && checkIn <= 10080,
        'check_in_minutes is 1 to 10080',
      );
    }
    if (status === 'done') {
      const live = await this.liveWorkers(task);
      assert(
        !live.length,
        `Task #${task.id} still has ${live.length} running worker(s); wait for them to finish or cancel the task`,
      );
    }
    const now = this.now();
    // The holder is asked to look when someone else changed its task.
    const poke = ROLES.includes(newHolder) && newHolder !== caller.role;
    const outbox = this.store.tx(() => {
      if (note) this.store.note(task.id, caller.role, note);
      this.store.run(
        `UPDATE tasks SET status=?,holder=?,poked=CASE WHEN ? THEN ? ELSE poked END,check_at=?,
           idle_wakes=0,stalled=NULL,cleaned=CASE WHEN ? THEN NULL ELSE cleaned END,updated=? WHERE id=?`,
        closing ? status : 'open',
        newHolder,
        poke ? 1 : 0,
        now,
        closing ? null : now + (checkIn ?? CHECK_IN_MINUTES) * MINUTE,
        reopening ? 1 : 0,
        now,
        task.id,
      );
      return message && !inChat ? this.store.enqueue(project.id, task.id, message) : null;
    });
    this.markSeen(caller.session, task.id);
    if (status === 'cancelled') await this.abortWorkers(task);
    const delivery = outbox ? await this.deliver(outbox) : undefined;
    this.requestTick();
    const updated = this.store.task(task.id);
    return {
      task: updated.id,
      status: updated.status,
      ...(updated.holder ? { waitingOn: updated.holder } : {}),
      ...(delivery ? { message: delivery } : {}),
      ...(message && inChat
        ? {
            message: {
              state: 'not sent',
              reason: 'you are in the project chat; say it in your reply',
            },
          }
        : {}),
    };
  }
  async notify(caller, input) {
    assert(caller.role === 'product', 'Only the product manager messages the user');
    const project = this.scopeProject(caller, input.project);
    const message = text(input.message ?? input.text, 4000, 'message');
    let taskId = null;
    if (input.task !== undefined || caller.task) {
      const task = this.scopeTask(caller, input.task);
      assert(task.project === project.id, 'That task belongs to another project');
      taskId = task.id;
    }
    const id = this.store.enqueue(project.id, taskId, message);
    return { notification: id, ...(await this.deliver(id)) };
  }

  // ---- Delivery ----------------------------------------------------------------------

  async ownerRoute() {
    if (this.ownerRouteCache && this.now() - this.ownerRouteCache.at < ROUTE_CACHE_MS)
      return this.ownerRouteCache.route;
    const owner = this.ownerChat;
    assert(owner, 'No ownerChat is configured');
    const result = await this.rpc('conversations.list', {
      agentId: topology().productAgentId,
      query: owner.to,
      channel: owner.channel,
      limit: 100,
    });
    const matches = (result?.conversations ?? []).filter(
      (route) =>
        route.channel === owner.channel &&
        route.accountId === owner.accountId &&
        route.target === owner.to &&
        route.kind === 'direct' &&
        String(route.threadId ?? '') === String(owner.threadId ?? ''),
    );
    assert.equal(matches.length, 1, 'The owner DM is unavailable or ambiguous');
    this.ownerRouteCache = { route: conversation(matches[0]), at: this.now() };
    return this.ownerRouteCache.route;
  }
  // One attempt for one outbox row. "sent" and "queued" hand the message to OpenClaw's own
  // durable delivery; the same operation id never sends twice. The project chat is tried
  // first, then the owner DM (prefixed with the project name); the route is never rebound.
  async deliver(id) {
    const row = this.store.get('SELECT * FROM outbox WHERE id=?', id);
    if (!row || row.state !== 'pending') return row ? { state: row.state } : undefined;
    const project = this.store.project(row.project);
    const toOwner = row.fallback === 1 || !project.route;
    let receipt, error;
    try {
      const route = toOwner ? await this.ownerRoute() : project.route;
      receipt = await this.rpc('conversations.send', {
        agentId: topology().productAgentId,
        operationId: `jarvis-gilfoyle-${row.id}-${toOwner ? 'owner' : 'project'}`,
        conversationRef: route.conversationRef,
        message: toOwner ? `[${project.name}] ${row.text}` : row.text,
      });
    } catch (failure) {
      error = String(failure?.message ?? failure)
        .split('\n')[0]
        .slice(0, 300);
    }
    const status = receipt?.status;
    if (status === 'sent' || status === 'queued') {
      this.store.run(
        "UPDATE outbox SET state='handed',receipt=?,error=NULL,attempts=attempts+1 WHERE id=?",
        JSON.stringify(receipt),
        row.id,
      );
      return { state: status, to: toOwner ? 'owner DM' : chatLabel(project.route) };
    }
    const attempts = row.attempts + 1;
    error ??=
      status === 'suppressed'
        ? 'The chat rejected the message'
        : `Delivery ${status ?? 'unconfirmed'}`;
    if (!toOwner && (status === 'suppressed' || attempts >= PREFERRED_ATTEMPTS)) {
      this.store.run(
        'UPDATE outbox SET fallback=1,attempts=0,next_at=?,error=? WHERE id=?',
        this.now(),
        error,
        row.id,
      );
      return this.deliver(row.id);
    }
    const failed = status === 'suppressed' || attempts >= FALLBACK_ATTEMPTS;
    this.store.run(
      'UPDATE outbox SET state=?,attempts=?,error=?,next_at=? WHERE id=?',
      failed ? 'failed' : 'pending',
      attempts,
      error,
      this.now() + Math.min(2 ** attempts, 60) * MINUTE,
      row.id,
    );
    if (failed) this.log(`Project message ${row.id} could not be delivered: ${error}`);
    return { state: failed ? 'failed' : 'retrying', error };
  }

  // ---- Native session facts ----------------------------------------------------------

  async sessionRows(agentId, search, extra = {}) {
    const result = await this.rpc('sessions.list', { agentId, search, limit: 200, ...extra });
    assert(Array.isArray(result?.sessions), 'Session list unavailable');
    return result.sessions;
  }
  async liveWorkers(task) {
    const live = [];
    for (const worker of task.workers) {
      if (this.now() - worker.at < WORKER_GRACE_MS) {
        live.push(worker.key);
        continue;
      }
      const agentId = /^agent:([^:]+):/.exec(worker.key)?.[1];
      const rows = await this.sessionRows(agentId, worker.key);
      if (
        rowBusy(
          rows.find((row) => row.key === worker.key),
          this.now(),
        )
      )
        live.push(worker.key);
    }
    return live;
  }
  async abortWorkers(task) {
    for (const key of await this.liveWorkers(task).catch(() => task.workers.map((w) => w.key)))
      await this.rpc('sessions.abort', { key }).catch((error) =>
        this.log(`Could not stop worker ${key}: ${String(error?.message ?? error).slice(0, 200)}`),
      );
  }
  recordWorker(sessionKey, childSessionKey) {
    const scope = parseTaskSession(sessionKey);
    if (!scope || typeof childSessionKey !== 'string' || !childSessionKey.startsWith('agent:'))
      return;
    const task = this.store.task(scope.taskId);
    if (task.workers.some((worker) => worker.key === childSessionKey)) return;
    this.store.run(
      'UPDATE tasks SET workers=?,idle_wakes=0 WHERE id=?',
      JSON.stringify([...task.workers, { key: childSessionKey, at: this.now() }].slice(-50)),
      task.id,
    );
  }

  // ---- Hook support (private sessions and project chats only) -----------------------

  // Remembers the chat of a manager's newest inbound message (resolved to a native
  // conversation the product manager can send to).
  captureInbound(sessionKey, agentId, raw) {
    if (!sessionKey || isPrivateSession(sessionKey) || !isManagerAgent(agentId)) return;
    const at = this.now();
    const pending = this.resolveRoute(agentId, raw)
      .catch(() => null)
      .then((route) => {
        this.sources.set(sessionKey, { route, at, used: false });
        if (route && agentId === topology().productAgentId)
          this.followChatSession(sessionKey, route);
      });
    this.captures.set(sessionKey, pending);
    return pending.finally(() => {
      if (this.captures.get(sessionKey) === pending) this.captures.delete(sessionKey);
    });
  }
  // The session OpenClaw routed a message in a project's own chat to is that chat's
  // session; a project records it again when it changed (reset scope, deleted session).
  // Messages in any other chat leave the project untouched.
  followChatSession(sessionKey, route) {
    try {
      for (const project of this.store.projects())
        if (
          project.route?.conversationRef === route.conversationRef &&
          project.route.sessionKey !== sessionKey
        )
          this.store.run(
            'UPDATE projects SET route=? WHERE id=?',
            JSON.stringify({ ...project.route, sessionKey }),
            project.id,
          );
    } catch (error) {
      this.log(
        `Project chat session not recorded: ${String(error?.message ?? error).slice(0, 200)}`,
      );
    }
  }
  async resolveRoute(agentId, raw) {
    const clean = (value) => {
      let v = String(value ?? '');
      if (v.startsWith(`${raw.channel}:`)) v = v.slice(raw.channel.length + 1);
      if (raw.channel === 'discord') v = v.replace(/^(channel|user):/, '');
      return v.replace(/:topic:.+$/, '');
    };
    const target = clean(raw.conversationId);
    const cacheKey = `${agentId}|${raw.channel}|${raw.accountId}|${target}|${raw.threadId ?? ''}`;
    const cached = this.routeCache.get(cacheKey);
    if (cached && this.now() - cached.at < ROUTE_CACHE_MS) return cached.route;
    const result = await this.rpc('conversations.list', { agentId, query: target, limit: 100 });
    const matches = (result?.conversations ?? []).filter(
      (c) =>
        c.channel === raw.channel &&
        c.accountId === raw.accountId &&
        clean(c.target) === target &&
        String(c.threadId ?? '') === String(raw.threadId ?? ''),
    );
    const route = matches.length === 1 ? conversation(matches[0]) : null;
    if (route) this.routeCache.set(cacheKey, { route, at: this.now() });
    return route;
  }
  // The running turn keeps the chat of the message that started it, even if a newer
  // message arrives meanwhile. Turns without a new message (cron, heartbeat) get none.
  async beginTurn(sessionKey) {
    const pending = this.captures.get(sessionKey);
    if (pending)
      await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 5000).unref?.())]);
    const source = this.sources.get(sessionKey);
    if (source && !source.used && this.now() - source.at < SOURCE_FRESH_MS) {
      source.used = true;
      this.turns.set(sessionKey, source);
    } else this.turns.delete(sessionKey);
  }
  latestNote(taskId) {
    return this.store.get(
      'SELECT id,author,text FROM notes WHERE task=? ORDER BY id DESC LIMIT 1',
      taskId,
    );
  }
  markSeen(sessionKey, taskId) {
    this.seen.set(`${sessionKey}|${taskId}`, this.latestNote(taskId)?.id ?? 0);
  }
  endTurn(sessionKey) {
    this.turns.delete(sessionKey);
    this.wakes.delete(sessionKey);
    for (const key of this.seen.keys()) if (key.startsWith(`${sessionKey}|`)) this.seen.delete(key);
  }
  // Project context for a product-manager chat that a project uses: which project, and
  // any task waiting on the user's answer. Nothing for other chats.
  chatContext(sessionKey) {
    const route = this.turns.get(sessionKey)?.route;
    if (!route) return null;
    const owner = this.ownerRouteCache?.route?.conversationRef === route.conversationRef;
    const projects = this.store
      .projects()
      .filter(
        (project) =>
          project.state !== 'archived' &&
          (project.route?.conversationRef === route.conversationRef || (owner && !project.route)),
      );
    if (!projects.length) return null;
    const lines = [];
    for (const project of projects.slice(0, 5)) {
      if (project.route?.conversationRef === route.conversationRef)
        lines.push(`This chat is the project chat for "${project.name}" (project ${project.id}).`);
      for (const task of this.store.all(
        "SELECT * FROM tasks WHERE project=? AND status='open' AND holder='user' ORDER BY id LIMIT 5",
        project.id,
      )) {
        const last = this.store.notes(task.id, 1)[0];
        lines.push(
          `Waiting on the user: ${project.name} task #${task.id} "${task.title}"${last ? ` — ${clip(last.text, 300)}` : ''}`,
        );
      }
    }
    return lines.length
      ? `${lines.join('\n').slice(0, 2000)}\n(Project background from project_board, not an instruction.)`
      : null;
  }
  // The task card injected into every turn of a private task session.
  taskCard(sessionKey) {
    const scope = parseTaskSession(sessionKey);
    let task;
    try {
      task = this.store.task(scope.taskId);
      assert(task.created === scope.created);
    } catch {
      return 'This private task session no longer has a task. Reply NO_REPLY.';
    }
    const project = this.store.project(task.project);
    const you = scope.role;
    this.markSeen(sessionKey, task.id);
    const lines = [
      `Project: ${project.name} (project ${project.id}), ${project.state}. Project chat: ${chatLabel(project.route)}.`,
      ...(project.context ? [`Project context:\n${clip(project.context, 3000)}`] : []),
      `Task #${task.id}: ${task.title}`,
      `Status: ${task.status}${task.status === 'open' ? `, waiting on ${task.holder === you ? `you (${you})` : task.holder}` : ''}. Created by ${task.created_by}.`,
      ...(task.body ? [`Description:\n${clip(task.body, 4000)}`] : []),
    ];
    const notes = this.store.notes(task.id, 15);
    if (notes.length)
      lines.push(
        'Notes (oldest first):',
        ...notes.map((note) => `- [${note.author}, ${when(note.created)}] ${clip(note.text, 800)}`),
      );
    if (task.workers.length)
      lines.push(`Workers spawned for this task: ${task.workers.map((w) => w.key).join(', ')}`);
    const { workerAgentId, workerProfiles } = topology();
    if (you === 'engineering' && workerProfiles.length)
      lines.push(
        `Worker profiles (sessions_spawn with agentId "${workerAgentId}" and model set to a profile id): ${workerProfiles
          .map(
            (p) =>
              `${p.id} = ${p.model}, thinking ${p.thinking ?? 'default'}${p.description ? ` — ${p.description}` : ''}`,
          )
          .join('; ')}`,
      );
    return lines.join('\n');
  }
  // Guards for tools used inside private task sessions. Everywhere else: nothing.
  async beforeToolCall(event, ctx) {
    const scope = parseTaskSession(ctx?.sessionKey);
    if (!scope) {
      if (
        isPrivateSession(ctx?.sessionKey) &&
        ['sessions_spawn', 'sessions_send', 'message'].includes(event?.toolName)
      )
        return { block: true, blockReason: 'This private session has no task.' };
      return undefined;
    }
    const name = event?.toolName;
    if (name === 'message')
      return {
        block: true,
        blockReason:
          'Private task session: the user is reached through project_board (update_task message, or notify by the product manager).',
      };
    if (name !== 'sessions_spawn' && name !== 'sessions_send') return undefined;
    let task, project;
    try {
      task = this.store.task(scope.taskId);
      project = this.store.project(task.project);
    } catch {
      return { block: true, blockReason: 'This private session has no task.' };
    }
    if (task.status !== 'open')
      return { block: true, blockReason: `Task #${task.id} is ${task.status}.` };
    const params = event.params ?? {};
    if (name === 'sessions_send') {
      if (task.workers.some((worker) => worker.key === params.sessionKey)) return undefined;
      return {
        block: true,
        blockReason:
          'From a task session, sessions_send may only reach this task’s own workers (by sessionKey).',
      };
    }
    if (project.state !== 'active')
      return {
        block: true,
        blockReason: `Project ${project.name} is ${project.state}; no new workers.`,
      };
    const { workerAgentId, workerProfiles, workerRuntime, workerLimit } = topology();
    if (params.agentId !== workerAgentId || !workerProfiles.length) return undefined;
    const profile =
      workerProfiles.find((p) => p.id === params.model) ??
      workerProfiles.find(
        (p) =>
          p.model === params.model && (p.thinking ?? undefined) === (params.thinking ?? undefined),
      );
    if (!profile)
      return {
        block: true,
        blockReason: `Set model to a worker profile id: ${workerProfiles.map((p) => p.id).join(', ')}.`,
      };
    let running = 0;
    for (const row of this.store.all("SELECT * FROM tasks WHERE status='open' AND workers<>'[]'"))
      running += (await this.liveWorkers({ ...row, workers: JSON.parse(row.workers) })).filter(
        (key) => key.startsWith(`agent:${workerAgentId}:`),
      ).length;
    if (running >= workerLimit)
      return {
        block: true,
        blockReason: `${running} workers are already running (limit ${workerLimit}); wait for one to finish.`,
      };
    return {
      params: {
        ...params,
        model: profile.model,
        ...(profile.thinking ? { thinking: profile.thinking } : {}),
        runtime: workerRuntime,
      },
    };
  }
  // Runs in private sessions whose task is closed or gone are refused.
  allowRun(sessionKey) {
    if (!isPrivateSession(sessionKey)) return true;
    const scope = parseTaskSession(sessionKey);
    if (!scope) return false;
    const task = this.store.get('SELECT status,created FROM tasks WHERE id=?', scope.taskId);
    return Boolean(task && task.created === scope.created && task.status === 'open');
  }

  // ---- The scan ----------------------------------------------------------------------

  requestTick() {
    if (this.stopped || this.tickRequested) return;
    this.tickRequested = true;
    setTimeout(() => {
      this.tickRequested = false;
      this.tick().catch((error) => this.log(`Project scan failed: ${error?.message ?? error}`));
    }, 2000).unref?.();
  }
  async tick() {
    if (this.stopped || this.ticking) return { skipped: true };
    this.ticking = true;
    const summary = { delivered: 0, woken: [], stalled: [], cleaned: 0 };
    try {
      if (!this.ownerRouteCache && this.ownerChat)
        await this.ownerRoute().catch((error) =>
          this.log(`Owner DM unresolved: ${error?.message ?? error}`),
        );
      for (const row of this.store.all(
        "SELECT id FROM outbox WHERE state='pending' AND next_at<=? ORDER BY id LIMIT 20",
        this.now(),
      )) {
        const result = await this.deliver(row.id);
        if (result?.state === 'sent' || result?.state === 'queued') summary.delivered++;
      }
      await this.wakeDue(summary);
      summary.cleaned = await this.cleanupClosed();
      this.health.lastScan = this.now();
      this.health.lastError = null;
    } catch (error) {
      this.health.lastError = String(error?.message ?? error).slice(0, 300);
      throw error;
    } finally {
      this.ticking = false;
    }
    return summary;
  }
  async wakeDue(summary) {
    const now = this.now();
    const tasks = this.store.all(
      `SELECT t.* FROM tasks t JOIN projects p ON p.id=t.project
       WHERE t.status='open' AND p.state='active' AND t.holder IN ('product','engineering') AND t.stalled IS NULL
       ORDER BY t.updated`,
    );
    const due = tasks.filter(
      (task) => task.poked !== null || (task.check_at !== null && now >= task.check_at),
    );
    for (const [session, at] of this.wakes)
      if (now - at >= WAKE_GRACE_MS) this.wakes.delete(session);
    if (!due.length) return;
    // One list per role shows which private sessions are mid-turn.
    const live = {};
    for (const role of ROLES) {
      if (!due.some((task) => task.holder === role)) continue;
      try {
        live[role] = new Set(
          (await this.sessionRows(agentForRole(role), `${topology().sessionNamespace}:task-`))
            .filter((row) => rowLive(row, now))
            .map((row) => row.key),
        );
      } catch (error) {
        this.log(`Cannot see ${role} sessions: ${error?.message ?? error}`);
      }
    }
    for (const row of due) {
      const task = { ...row, workers: JSON.parse(row.workers) };
      const role = task.holder;
      if (!live[role]) continue;
      const key = taskSessionKey(role, task);
      if (this.wakes.has(key) || live[role].has(key)) continue;
      const busy =
        live[role].size +
        [...this.wakes.keys()].filter(
          (k) => k.startsWith(`agent:${agentForRole(role)}:`) && !live[role].has(k),
        ).length;
      if (busy >= this.maxWakesPerRole) continue;
      const poked = task.poked !== null;
      let workers = 0;
      try {
        workers = (await this.liveWorkers(task)).length;
      } catch {
        workers = task.workers.length;
      }
      if (!poked && !workers && task.idle_wakes >= STALL_WAKES) {
        await this.reportStall(task);
        summary.stalled.push(task.id);
        continue;
      }
      if (await this.wake(task, role, key, poked, workers)) {
        live[role].add(key);
        summary.woken.push(task.id);
      }
    }
  }
  // A private task session runs on the model and thinking level the user chose in the
  // project chat, or on the agent's defaults when the chat has none. Fails open.
  async followChatModel(task, role, key) {
    const chatKey = this.store.project(task.project).route?.sessionKey;
    try {
      const row = chatKey
        ? (await this.sessionRows(topology().productAgentId, chatKey)).find(
            (candidate) => candidate.key === chatKey,
          )
        : null;
      const chosen = row?.modelOverrideSource === 'user' && row.model;
      await this.rpc('sessions.patch', {
        key,
        agentId: agentForRole(role),
        model: chosen
          ? row.modelProvider
            ? `${row.modelProvider}/${row.model}`
            : row.model
          : null,
        thinkingLevel: row?.thinkingLevel ?? null,
      });
    } catch (error) {
      this.log(
        `Task #${task.id} runs on default settings: ${String(error?.message ?? error).slice(0, 200)}`,
      );
    }
  }
  async wake(task, role, key, poked, workers) {
    const now = this.now();
    this.wakes.set(key, now);
    // The poke this wake answers is cleared; a newer one (changed meanwhile) stays.
    this.store.run(
      'UPDATE tasks SET woken=?,check_at=?,idle_wakes=idle_wakes+?,poked=CASE WHEN poked=? THEN NULL ELSE poked END WHERE id=?',
      now,
      now + CHECK_IN_MINUTES * MINUTE,
      workers ? 0 : 1,
      task.poked,
      task.id,
    );
    const last = this.store.notes(task.id, 1)[0];
    const reason = poked
      ? last && last.author !== role
        ? `New from ${last.author}: ${clip(last.text, 500)}`
        : 'This task is waiting on you.'
      : workers
        ? 'Scheduled check-in; workers are still running.'
        : 'Scheduled check-in.';
    try {
      await this.rpc('sessions.create', {
        key,
        agentId: agentForRole(role),
        label: clip(`Task #${task.id}: ${task.title}`, 80),
      }).catch(() => undefined);
      await this.followChatModel(task, role, key);
      await this.rpc('agent', {
        agentId: agentForRole(role),
        sessionKey: key,
        deliver: false,
        idempotencyKey: randomUUID(),
        timeout: this.turnTimeoutSeconds,
        message: `PROJECT TASK ${taskScope(task)}\n${reason}\nThe task card is in your context. Act with project_board; this reply is private. End with NO_REPLY.`,
      });
      return true;
    } catch (error) {
      this.wakes.delete(key);
      this.store.run(
        'UPDATE tasks SET check_at=? WHERE id=?',
        now + WAKE_RETRY_MINUTES * MINUTE,
        task.id,
      );
      this.log(
        `Could not wake ${role} for task #${task.id}: ${String(error?.message ?? error).slice(0, 200)}`,
      );
      return false;
    }
  }
  async reportStall(task) {
    const project = this.store.project(task.project);
    const last = this.store.notes(task.id, 1)[0];
    const who = this.agentName(task.holder);
    const message = `${project.name}: task #${task.id} "${task.title}" is waiting on ${who} and nothing has changed after ${STALL_WAKES} check-ins.${last ? ` Last note (${last.author}): ${clip(last.text, 500)}` : ''}`;
    const id = this.store.tx(() => {
      this.store.run('UPDATE tasks SET stalled=? WHERE id=?', this.now(), task.id);
      this.store.note(
        task.id,
        'plugin',
        `Stalled: no change after ${STALL_WAKES} check-ins; the user was told.`,
      );
      return this.store.enqueue(project.id, task.id, message);
    });
    await this.deliver(id);
  }
  // Private sessions of closed tasks are deleted once nothing runs in them.
  async cleanupClosed() {
    let cleaned = 0;
    const { sessionNamespace } = topology();
    for (const row of this.store.all(
      "SELECT * FROM tasks WHERE status<>'open' AND cleaned IS NULL ORDER BY updated LIMIT 10",
    )) {
      let done = true;
      for (const role of ROLES) {
        const key = taskSessionKey(role, row);
        try {
          const session = (
            await this.sessionRows(agentForRole(role), key, { archived: 'all' })
          ).find((candidate) => candidate.key === key);
          if (!session) continue;
          if (rowBusy(session, this.now())) {
            done = false;
            continue;
          }
          const result = await this.rpc('jarvis-gilfoyle.session.cleanup', {
            agentId: agentForRole(role),
            sessionNamespace,
            sessionKey: key,
            expectedSessionId: session.sessionId,
          });
          for (const path of result?.exportedPaths ?? [])
            await unlink(path).catch((error) => {
              if (error.code !== 'ENOENT') throw error;
            });
        } catch (error) {
          done = false;
          this.log(`Cleanup of ${key} deferred: ${String(error?.message ?? error).slice(0, 200)}`);
        }
      }
      if (done) {
        this.store.run('UPDATE tasks SET cleaned=? WHERE id=?', this.now(), row.id);
        cleaned++;
      }
    }
    return cleaned;
  }
  healthReport() {
    const count = (sql) => this.store.get(sql).n;
    return {
      ...this.health,
      projects: count("SELECT COUNT(*) n FROM projects WHERE state<>'archived'"),
      openTasks: count("SELECT COUNT(*) n FROM tasks WHERE status='open'"),
      stalledTasks: count(
        "SELECT COUNT(*) n FROM tasks WHERE status='open' AND stalled IS NOT NULL",
      ),
      pendingMessages: count("SELECT COUNT(*) n FROM outbox WHERE state='pending'"),
      failedMessages: count("SELECT COUNT(*) n FROM outbox WHERE state='failed'"),
    };
  }
}

export { isManagerAgent };
