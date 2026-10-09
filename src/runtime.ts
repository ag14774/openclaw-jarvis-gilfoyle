import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { readStringParam } from 'openclaw/plugin-sdk/param-readers';
import { normalizeAgentIdStrict } from 'openclaw/plugin-sdk/routing';
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
const KEEP_CLOSED_MS = 7 * 24 * 60 * MINUTE;
const ADAPT_WAIT_MS = 2 * MINUTE;
const ADAPT_CHAT_CHARS = 40000;
const ADAPT_INSTRUCTIONS = `You are about to send a message in a project chat. It was written without seeing this conversation. Rewrite it as the message you send now.
- Keep every fact, decision, number, link, question and limitation in it. Add no new facts, and do not say you have done anything it does not say.
- Add only as much background as the user needs to recognise what it is about. If they asked recently and the conversation has not moved on, give it directly. If time has passed or the conversation moved on, say briefly what they asked for and why.
- If something recent in the conversation clearly relates to it, you may point that out or offer to look into it.
- A question must stay answerable as written. Explain any term the user has not used themselves.
- If the message already fits, return it unchanged.
Reply with the message text only.`;
const PREFERRED_ATTEMPTS = 3;
const FALLBACK_ATTEMPTS = 10;
const ROLES = ['product', 'engineering'];
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const HOLDERS = ['product', 'engineering', 'user'];

// Reuse the native reader's alias precedence and target canonicalization.
export const spawnAgentId = (params) => {
  const target = readStringParam(params ?? {}, 'agentId');
  if (!target) return undefined;
  const normalized = normalizeAgentIdStrict(target);
  return normalized.ok ? normalized.value : undefined;
};

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
// Files sent with a message: existing absolute paths, read again at each delivery attempt.
const MAX_FILES = 4;
const MAX_FILE_MB = 8;
const attachments = (value) => {
  if (value === undefined || value === null) return [];
  assert(
    Array.isArray(value) && value.length <= MAX_FILES,
    `attachments is a list of at most ${MAX_FILES} file paths`,
  );
  return value.map((path) => {
    assert(typeof path === 'string' && isAbsolute(path), 'Each attachment is an absolute path');
    let stat;
    try {
      stat = statSync(path);
    } catch {
      assert.fail(`Attachment not found: ${path}`);
    }
    assert(stat.isFile(), `Attachment is not a file: ${path}`);
    assert(stat.size <= MAX_FILE_MB * 1024 * 1024, `Attachment is over ${MAX_FILE_MB} MB: ${path}`);
    return path;
  });
};
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
// The text a chat receives: the owner DM gets the project name first.
const sentText = (row, project, toOwner) => (toOwner ? `[${project.name}] ${row.text}` : row.text);
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
      appendTranscript = async () => {
        throw new Error('Transcript append unavailable');
      },
      publishTranscript = async () => {},
      adapt = null,
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
    this.appendTranscript = appendTranscript;
    this.publishTranscript = publishTranscript;
    this.adapt = adapt; // ({system, message}) -> text, as the product manager; null when unavailable
    this.sending = Promise.resolve(); // deliveries run one at a time
    this.sources = new Map(); // session -> newest inbound chat {route, at, used}
    this.turns = new Map(); // session -> the inbound chat of the running turn
    this.captures = new Map(); // session -> route resolution still in progress
    this.routeCache = new Map();
    this.wakes = new Map(); // session -> dispatch time (until the run shows up as live)
    this.deliveries = new Map(); // outbox id -> the whole in-flight attempt, including fallback
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
            ...(task.plan ? { plan: task.plan } : {}),
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
          "UPDATE tasks SET poked=?,woken=NULL,idle_wakes=0,stalled=NULL WHERE project=? AND status='open' AND holder IN ('product','engineering')",
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
    const lastNote = this.latestNote(task.id)?.id ?? 0;
    const project = this.store.project(task.project);
    const note = optional(input.note, 4000, 'note');
    const message = optional(input.message, 4000, 'message');
    const files = attachments(input.attachments);
    assert(!files.length || message !== undefined, 'attachments are sent with a message');
    // The task's working plan: free text, replaced as a whole; an empty plan clears it.
    const plan =
      input.plan === undefined || input.plan === null
        ? undefined
        : (optional(input.plan, 4000, 'plan') ?? '');
    const status = input.status;
    const holder = input.holder;
    assert(
      [note, message, status, holder, input.check_in_minutes, plan].some(
        (value) => value !== undefined,
      ),
      'Pass note, holder, status, message, check_in_minutes or plan',
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
      // The task may have changed, or gained a worker, while the workers were checked.
      assert(
        this.taskUnchanged(task, lastNote) &&
          this.store.task(task.id).workers.length === task.workers.length,
        `Task #${task.id} changed while its workers were checked; read it with show, then decide again`,
      );
    }
    const now = this.now();
    // Someone else's change asks the holder to look; the holder's own action answers
    // an outstanding poke.
    const poke = ROLES.includes(newHolder) && newHolder !== caller.role;
    const outbox = this.store.tx(() => {
      if (note) this.store.note(task.id, caller.role, note);
      this.store.run(
        `UPDATE tasks SET status=?,holder=?,plan=COALESCE(?,plan),poked=CASE WHEN ? THEN ? ELSE NULL END,woken=NULL,check_at=?,
           idle_wakes=0,stalled=NULL,cleaned=CASE WHEN ? THEN NULL ELSE cleaned END,updated=? WHERE id=?`,
        closing ? status : 'open',
        newHolder,
        plan ?? null,
        poke ? 1 : 0,
        now,
        closing
          ? status === 'cancelled'
            ? now + WAKE_RETRY_MINUTES * MINUTE
            : null
          : now + (checkIn ?? CHECK_IN_MINUTES) * MINUTE,
        reopening ? 1 : 0,
        now,
        task.id,
      );
      return message && !inChat ? this.store.enqueue(project.id, task.id, message, files) : null;
    });
    this.markSeen(caller.session, task.id);
    if (status === 'cancelled') await this.abortWorkers(this.store.task(task.id));
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
              reason: `you are in the project chat; say it in your reply${files.length ? ' with the files attached' : ''}`,
            },
          }
        : {}),
    };
  }
  async notify(caller, input) {
    assert(caller.role === 'product', 'Only the product manager messages the user');
    const project = this.scopeProject(caller, input.project);
    const message = text(input.message ?? input.text, 4000, 'message');
    const files = attachments(input.attachments);
    let taskId = null;
    if (input.task !== undefined || caller.task) {
      const task = this.scopeTask(caller, input.task);
      assert(task.project === project.id, 'That task belongs to another project');
      taskId = task.id;
    }
    if (this.inProjectChat(caller, project))
      return {
        message: { state: 'not sent', reason: 'you are in the project chat; say it in your reply' },
      };
    const id = this.store.enqueue(project.id, taskId, message, files);
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
  // One delivery at a time, including its fallback, so a rewrite sees the messages sent
  // before it.
  deliver(id) {
    if (this.deliveries.has(id)) return this.deliveries.get(id);
    const pending = this.sending
      .then(() => this.deliverAttempt(id))
      .finally(() => this.deliveries.delete(id));
    this.sending = pending.catch(() => {});
    this.deliveries.set(id, pending);
    return pending;
  }
  // Before its first send to the project chat, the product manager rewrites a message for
  // the conversation it lands in, given that chat since the task's request, the task and the
  // message as written. While that chat is mid-reply, or changed during the rewrite, it is
  // tried again shortly, for at most ADAPT_WAIT_MS. Any failure sends the message as written.
  async adaptToChat(row, project, route) {
    const later = () => {
      if (this.now() - row.created >= ADAPT_WAIT_MS) return null;
      this.store.run('UPDATE outbox SET next_at=? WHERE id=?', this.now() + MINUTE / 2, row.id);
      return { state: 'pending', reason: 'the project chat is busy; it goes out shortly' };
    };
    try {
      const session = await this.chatSession(route);
      if (!session) return null;
      const busy = rowLive(session, this.now()) && later();
      if (busy) return busy;
      const history = await this.rpc('chat.history', {
        sessionKey: session.key,
        agentId: topology().productAgentId,
        limit: 1000,
      });
      const task = row.task ? this.store.task(row.task) : null;
      const message = [
        `The project chat, oldest first (times UTC):\n${this.chatSince(history?.messages ?? [], task?.created) || '(no messages yet)'}`,
        ...(task ? [this.taskLines(task, project, 'product').join('\n')] : []),
        `The message to send:\n${row.text}`,
      ].join('\n\n');
      const adapted = text(
        await this.adapt({ system: ADAPT_INSTRUCTIONS, message }),
        4000,
        'message',
      );
      const after = await this.chatSession(route);
      const changed =
        (rowLive(after, this.now()) || after?.updatedAt !== session.updatedAt) && later();
      if (changed) return changed;
      this.store.run('UPDATE outbox SET text=? WHERE id=?', adapted, row.id);
      row.text = adapted;
    } catch (error) {
      this.log(`Project message ${row.id} sent as written: ${error?.message ?? error}`);
    }
    return null;
  }
  // The chat's user and assistant text from the user's last message before `since` (the
  // request) to now. When that is long, the request and the newest messages are kept.
  chatSince(messages, since) {
    const name = this.agentName('product');
    const chat = messages.flatMap((m) => {
      const said = (
        typeof m.content === 'string'
          ? m.content
          : (m.content ?? [])
              .filter((b) => b?.type === 'text')
              .map((b) => b.text)
              .join('\n')
      ).trim();
      return ['user', 'assistant'].includes(m.role) && said
        ? [
            {
              user: m.role === 'user',
              at: Number(m.timestamp),
              text: `[${when(Number(m.timestamp))}] ${m.role === 'user' ? 'User' : name}: ${clip(said, 4000)}`,
            },
          ]
        : [];
    });
    const start = since === undefined ? -1 : chat.findLastIndex((m) => m.user && m.at <= since);
    const head = start >= 0 ? [chat[start].text] : [];
    const rest = chat.slice(start + 1);
    let room = ADAPT_CHAT_CHARS - (head[0]?.length ?? 0);
    let first = rest.length;
    while (first > 0 && rest[first - 1].text.length <= room) room -= rest[--first].text.length;
    return [
      ...head,
      ...(first ? [`[${first} earlier messages left out]`] : []),
      ...rest.slice(first).map((m) => m.text),
    ].join('\n');
  }
  // One attempt for one outbox row. "sent" and "queued" hand the message to OpenClaw's own
  // durable delivery; the same operation id never sends twice. The project chat is tried
  // first, then the owner DM (prefixed with the project name); the route is never rebound.
  // Once the text is accepted the message is delivered and never falls back: attached
  // files follow as native message sends to the same chat, each with its own idempotency
  // key, and failed files are retried there. A delivered message is then added to the
  // session of the chat it reached.
  async deliverAttempt(id) {
    const row = this.store.get('SELECT * FROM outbox WHERE id=?', id);
    if (!row || row.state !== 'pending') return row ? { state: row.state } : undefined;
    const project = this.store.project(row.project);
    const toOwner = row.fallback === 1 || !project.route;
    const operation = `jarvis-gilfoyle-${row.id}-${toOwner ? 'owner' : 'project'}`;
    let receipt = row.receipt ? JSON.parse(row.receipt) : null;
    let status = receipt?.status;
    let error, route;
    try {
      route = toOwner ? await this.ownerRoute() : project.route;
      if (!receipt && !toOwner && !row.attempts && this.adapt) {
        const waiting = await this.adaptToChat(row, project, route);
        if (waiting) return waiting;
      }
      if (!receipt) {
        const sent = await this.rpc('conversations.send', {
          agentId: topology().productAgentId,
          operationId: operation,
          conversationRef: route.conversationRef,
          message: sentText(row, project, toOwner),
        });
        status = sent?.status;
        if (status === 'sent' || status === 'queued') {
          receipt = sent;
          this.store.run('UPDATE outbox SET receipt=? WHERE id=?', JSON.stringify(sent), row.id);
        }
      }
      if (receipt)
        for (const [index, path] of JSON.parse(row.files).entries())
          await this.rpc('message.action', {
            channel: route.channel,
            action: 'send',
            accountId: route.accountId,
            agentId: topology().productAgentId,
            params: {
              to: route.target,
              ...(route.threadId ? { threadId: route.threadId } : {}),
              buffer: readFileSync(path).toString('base64'),
              filename: basename(path),
            },
            idempotencyKey: `${operation}-file-${index + 1}`,
          });
    } catch (failure) {
      error = String(failure?.message ?? failure)
        .split('\n')[0]
        .slice(0, 300);
    }
    const to = toOwner ? 'owner DM' : chatLabel(project.route);
    const attempts = row.attempts + 1;
    if (receipt && (!error || attempts >= FALLBACK_ATTEMPTS)) {
      this.store.run(
        "UPDATE outbox SET state='handed',error=?,attempts=? WHERE id=?",
        error ? `Attachments not delivered: ${error}` : null,
        attempts,
        row.id,
      );
      if (error) this.log(`Project message ${row.id} attachments not delivered: ${error}`);
      await this.record(row.id);
      return {
        state: status,
        to,
        ...(error ? { error: `Attachments not delivered: ${error}` } : {}),
      };
    }
    if (receipt) {
      this.store.run(
        'UPDATE outbox SET attempts=?,error=?,next_at=? WHERE id=?',
        attempts,
        error,
        this.now() + Math.min(2 ** attempts, 60) * MINUTE,
        row.id,
      );
      return { state: status, to, error: `Attachments not delivered yet, retrying: ${error}` };
    }
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
      return this.deliverAttempt(row.id);
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

  // The product manager's session for a chat, when exactly one matches.
  async chatSession(route) {
    const sessions = (
      await this.sessionRows(topology().productAgentId, route.target.replace(/^[^:]+:/, ''))
    ).filter(
      ({ deliveryContext: to }) =>
        to?.channel === route.channel &&
        to.to === route.target &&
        (to.accountId ?? 'default') === route.accountId &&
        String(to.threadId ?? '') === String(route.threadId ?? ''),
    );
    return sessions.length === 1 ? sessions[0] : null;
  }
  // A delivered message becomes the product manager's own reply in his session for the chat
  // it reached (the project chat or the owner DM), as text plus a MEDIA line per file, so
  // that chat's history and what the model reads next turn match the chat. It waits while
  // that session runs a turn; the scan retries for a day. Failures never affect delivery.
  async record(id) {
    const row = this.store.get('SELECT * FROM outbox WHERE id=?', id);
    if (row.recorded) return;
    const project = this.store.project(row.project);
    const toOwner = row.fallback === 1 || !project.route;
    try {
      const route = toOwner ? await this.ownerRoute() : project.route;
      const agentId = topology().productAgentId;
      const session = await this.chatSession(route);
      if (!session?.sessionId || rowLive(session, this.now())) return;
      const files = JSON.parse(row.files).map((path) => `MEDIA:${path}`);
      const text = [sentText(row, project, toOwner), ...(files.length ? ['', ...files] : [])];
      // OpenClaw's own transcript writer. Its SDK subpath is JavaScript-only and labelled
      // private-local ("Private-local after July 2026" in docs/plugins/sdk-subpaths.md), so a
      // host update may change or remove it: before raising the pinned OpenClaw version, check
      // that appendSessionTranscriptMessageByIdentity still appends a model-visible assistant
      // message (only provider "openclaw" with model "gateway-injected" or "delivery-mirror" is
      // display-only) and run the native test lane, which checks the export.
      const result = await this.appendTranscript({
        agentId,
        sessionKey: session.key,
        sessionId: session.sessionId,
        idempotencyLookup: 'scan-assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: text.join('\n') }],
          api: 'jarvis-gilfoyle',
          provider: 'jarvis-gilfoyle',
          model: 'project-board',
          usage: ZERO_USAGE,
          stopReason: 'stop',
          timestamp: row.created,
          idempotencyKey: `jarvis-gilfoyle-${row.id}-chat`,
        },
      });
      this.store.run('UPDATE outbox SET recorded=1 WHERE id=?', row.id);
      if (result?.messageId)
        await this.publishTranscript({
          agentId,
          sessionKey: session.key,
          sessionId: session.sessionId,
          update: { messageId: result.messageId },
        });
    } catch (error) {
      this.log(
        `Project message ${row.id} not added to the chat session: ${error?.message ?? error}`,
      );
    }
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
  // Workers the engineering manager launched from task sessions that are running now,
  // whatever their task's status, plus ones recorded too recently for the list to show.
  async runningBoardWorkers() {
    const { workerAgentId } = topology();
    const running = new Set();
    for (let offset = 0; ;) {
      const result = await this.rpc('sessions.list', {
        agentId: workerAgentId,
        limit: 200,
        offset,
      });
      assert(Array.isArray(result?.sessions), 'Worker session list unavailable');
      for (const session of result.sessions)
        if (
          rowLive(session, this.now()) &&
          parseTaskSession(session.spawnedBy)?.role === 'engineering'
        )
          running.add(session.key);
      if (!result.hasMore || !(result.nextOffset > offset)) break;
      offset = result.nextOffset;
    }
    for (const row of this.store.all("SELECT workers FROM tasks WHERE workers<>'[]'"))
      for (const worker of JSON.parse(row.workers))
        if (
          worker.key.startsWith(`agent:${workerAgentId}:`) &&
          this.now() - worker.at < WORKER_GRACE_MS
        )
          running.add(worker.key);
    return running.size;
  }
  // Stops a cancelled task's workers. Returns true once each is confirmed stopped: its
  // session is idle or gone after the spawn grace. Unconfirmed stops are retried by the scan.
  async abortWorkers(task) {
    let stopped = true;
    for (const worker of task.workers) {
      const key = worker.key;
      let session;
      try {
        session = (await this.sessionRows(/^agent:([^:]+):/.exec(key)?.[1], key)).find(
          (row) => row.key === key,
        );
      } catch (error) {
        stopped = false;
        this.log(
          `Worker ${key} stop unconfirmed: ${String(error?.message ?? error).slice(0, 200)}`,
        );
        continue;
      }
      if (this.now() - worker.at >= WORKER_GRACE_MS && !rowBusy(session, this.now())) continue;
      stopped = false;
      if (this.store.task(task.id).status !== 'cancelled') return false;
      // clearQueued also drops follow-ups already queued for the worker.
      await this.rpc('sessions.abort', { key, clearQueued: true }).catch((error) =>
        this.log(`Could not stop worker ${key}: ${String(error?.message ?? error).slice(0, 200)}`),
      );
    }
    if (stopped)
      this.store.run("UPDATE tasks SET check_at=NULL WHERE id=? AND status='cancelled'", task.id);
    return stopped;
  }
  recordWorker(sessionKey, childSessionKey) {
    const scope = parseTaskSession(sessionKey);
    if (!scope || typeof childSessionKey !== 'string' || !childSessionKey.startsWith('agent:'))
      return;
    const task = this.store.task(scope.taskId);
    if (task.workers.some((worker) => worker.key === childSessionKey)) return;
    // A worker that appears after its task was cancelled is stopped by the next scan.
    this.store.run(
      "UPDATE tasks SET workers=?,idle_wakes=0,check_at=CASE WHEN status='cancelled' THEN ? ELSE check_at END WHERE id=?",
      JSON.stringify([...task.workers, { key: childSessionKey, at: this.now() }]),
      this.now(),
      task.id,
    );
    if (task.status === 'cancelled') this.requestTick();
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
  // Whether anyone acted on the task since it was read. The scan's own bookkeeping
  // (woken, check_at, idle_wakes, poked) does not count.
  taskUnchanged(task, lastNote) {
    const current = this.store.task(task.id);
    return (
      ['status', 'holder', 'updated'].every((field) => current[field] === task[field]) &&
      (this.latestNote(task.id)?.id ?? 0) === lastNote
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
        lines.push(
          `This chat is also used as the project chat for "${project.name}" (project ${project.id}).`,
        );
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
  // A task as `you` (a role) sees it: its project, description, plan and latest notes.
  taskLines(task, project, you) {
    const notes = this.store.notes(task.id, 15);
    return [
      `Project: ${project.name} (project ${project.id}), ${project.state}. Project chat: ${chatLabel(project.route)}.`,
      ...(project.context ? [`Project context:\n${clip(project.context, 3000)}`] : []),
      `Task #${task.id}: ${task.title}`,
      `Status: ${task.status}${task.status === 'open' ? `, waiting on ${task.holder === you ? `you (${you})` : task.holder}` : ''}. Created by ${task.created_by}.`,
      ...(task.body ? [`Description:\n${clip(task.body, 4000)}`] : []),
      ...(task.plan ? [`Plan:\n${task.plan}`] : []),
      ...(notes.length
        ? [
            'Notes (oldest first):',
            ...notes.map(
              (note) => `- [${note.author}, ${when(note.created)}] ${clip(note.text, 800)}`,
            ),
          ]
        : []),
    ];
  }
  // The task card injected into every turn of a private task session.
  taskCard(sessionKey) {
    const scope = parseTaskSession(sessionKey);
    let task;
    try {
      task = this.store.task(scope.taskId);
      assert(task.created === scope.created);
    } catch {
      return 'This private task session no longer has a task. Reply with one short line and stop.';
    }
    const you = scope.role;
    this.markSeen(sessionKey, task.id);
    const lines = this.taskLines(task, this.store.project(task.project), you);
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
  // `launching` counts the engineering manager's earlier worker launches still in progress.
  async beforeToolCall(event, ctx, launching = 0) {
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
      assert(task.created === scope.created);
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
    if (spawnAgentId(params) !== workerAgentId || !workerProfiles.length) return undefined;
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
    // The limit covers the workers the engineering manager launches directly.
    if (scope.role === 'engineering') {
      const running = (await this.runningBoardWorkers()) + launching;
      if (running >= workerLimit)
        return {
          block: true,
          blockReason: `${running} workers are already running or starting (limit ${workerLimit}); wait for one to finish.`,
        };
    }
    return {
      params: {
        ...params,
        agentId: workerAgentId,
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
    if (task && task.created === scope.created && task.status === 'open') return true;
    // A late native turn recreated a closed task's session; the next scan removes it again.
    if (task && task.created === scope.created) {
      this.store.run('UPDATE tasks SET cleaned=NULL WHERE id=?', scope.taskId);
      this.requestTick();
    }
    return false;
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
    this.scanProblem = null;
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
      for (const row of this.store.all(
        "SELECT id FROM outbox WHERE state='handed' AND recorded=0 AND created>=? ORDER BY id LIMIT 20",
        this.now() - 24 * 60 * MINUTE,
      ))
        await this.record(row.id);
      // A cancelled task's check_at is the next try at stopping its workers; abortWorkers
      // clears it once all are stopped. Ten oldest first, each moved on before the try,
      // so failures cannot starve later rows.
      for (const row of this.store.all(
        "SELECT id FROM tasks WHERE status='cancelled' AND workers<>'[]' AND check_at<=? ORDER BY check_at,id LIMIT 10",
        this.now(),
      )) {
        this.store.run(
          'UPDATE tasks SET check_at=? WHERE id=?',
          this.now() + WAKE_RETRY_MINUTES * MINUTE,
          row.id,
        );
        await this.abortWorkers(this.store.task(row.id));
      }
      await this.wakeDue(summary);
      summary.cleaned = await this.cleanupClosed();
      this.health.lastScan = this.now();
      this.health.lastError = this.scanProblem?.slice(0, 300) ?? null;
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
      (task) =>
        (task.poked !== null && (task.woken === null || task.poked > task.woken)) ||
        (task.check_at !== null && now >= task.check_at),
    );
    const notes = new Map(due.map((task) => [task.id, this.latestNote(task.id)?.id ?? 0]));
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
        const problem = `Cannot see ${role} sessions: ${error?.message ?? error}`;
        this.scanProblem ??= problem;
        this.log(problem);
      }
    }
    for (const row of due) {
      const task = { ...row, workers: JSON.parse(row.workers) };
      const lastNote = notes.get(task.id);
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
      if (!this.taskUnchanged(task, lastNote)) continue;
      if (!poked && !workers && task.idle_wakes >= STALL_WAKES) {
        await this.reportStall(task);
        summary.stalled.push(task.id);
        continue;
      }
      if (await this.wake(task, role, key, poked, workers, lastNote)) {
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
      // Two calls: the companion sends the model with write scope only, so the choice
      // never becomes a configured default; the thinking level needs admin scope.
      const target = { key, agentId: agentForRole(role) };
      await this.rpc('sessions.patch', {
        ...target,
        model: chosen
          ? row.modelProvider
            ? `${row.modelProvider}/${row.model}`
            : row.model
          : null,
      });
      await this.rpc('sessions.patch', { ...target, thinkingLevel: row?.thinkingLevel ?? null });
    } catch (error) {
      this.log(
        `Task #${task.id} runs on default settings: ${String(error?.message ?? error).slice(0, 200)}`,
      );
    }
  }
  async wake(task, role, key, poked, workers, lastNote) {
    const now = this.now();
    this.wakes.set(key, now);
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
      try {
        await this.rpc('agent', {
          agentId: agentForRole(role),
          sessionKey: key,
          deliver: false,
          idempotencyKey: randomUUID(),
          timeout: this.turnTimeoutSeconds,
          message: `PROJECT TASK ${taskScope(task)}\n${reason}\nThe task card is in your context. Act with project_board; this reply is private. End with one short line on what you did.`,
        });
      } catch (error) {
        // A timed-out request may still have started the turn.
        const started = await this.sessionRows(agentForRole(role), key)
          .then((rows) =>
            rowLive(
              rows.find((row) => row.key === key),
              this.now(),
            ),
          )
          .catch(() => false);
        if (!started) throw error;
      }
    } catch (error) {
      // A wake that did not happen keeps its poke and idle count and is tried again later.
      this.wakes.delete(key);
      this.store.run(
        'UPDATE tasks SET woken=?,check_at=? WHERE id=?',
        now,
        now + WAKE_RETRY_MINUTES * MINUTE,
        task.id,
      );
      const problem = `Could not wake ${role} for task #${task.id}: ${String(error?.message ?? error).slice(0, 200)}`;
      this.log(problem);
      this.scanProblem ??= problem;
      return false;
    }
    // A change made during the dispatch keeps its own poke and check-in.
    if (this.taskUnchanged(task, lastNote))
      this.store.run(
        'UPDATE tasks SET woken=?,check_at=?,idle_wakes=idle_wakes+?,poked=NULL WHERE id=?',
        now,
        now + CHECK_IN_MINUTES * MINUTE,
        workers ? 0 : 1,
        task.id,
      );
    return true;
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
  // Private sessions of closed tasks are kept for a week so the work can be reviewed,
  // then deleted once nothing runs in them.
  async cleanupClosed() {
    let cleaned = 0;
    const { sessionNamespace } = topology();
    for (const row of this.store.all(
      "SELECT * FROM tasks WHERE status<>'open' AND cleaned IS NULL AND updated<=? ORDER BY updated LIMIT 10",
      this.now() - KEEP_CLOSED_MS,
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
          await this.rpc('jarvis-gilfoyle.session.cleanup', {
            agentId: agentForRole(role),
            sessionNamespace,
            sessionKey: key,
            expectedSessionId: session.sessionId,
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
