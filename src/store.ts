import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { projectSessionKey } from './topology.js';

export const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const text = (s, max = 2000) => {
  assert(
    typeof s === 'string' && s.trim() && s.length <= max && !s.includes('\0'),
    'Nonempty bounded text required',
  );
  return s.trim();
};
export const role = (r) => {
  assert(['product', 'engineering'].includes(r), 'Manager role required');
  return r;
};
export const conversation = (r) => {
  assert(
    r && /^conv_[a-f0-9]{30,64}$/.test(r.conversationRef),
    'Native conversation reference required',
  );
  return {
    conversationRef: r.conversationRef,
    channel: text(r.channel, 60),
    accountId: text(r.accountId, 100),
    target: text(r.target, 240),
    ...(r.threadId ? { threadId: String(r.threadId) } : {}),
    kind: r.kind,
  };
};
export class Store {
  constructor(path, { now = () => Date.now() } = {}) {
    this.now = now;
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;',
    );
    const version = this.get('PRAGMA user_version').user_version;
    assert(
      [0, 2, 3].includes(version),
      'Unsupported registry schema; create a fresh current registry',
    );
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,purpose TEXT NOT NULL,context TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','draining','inactive')),priority INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,created INTEGER NOT NULL,product_conversation TEXT NOT NULL,engineering_conversation TEXT,product_fallback TEXT NOT NULL,engineering_fallback TEXT);
      CREATE TABLE IF NOT EXISTS boards(id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),repository TEXT);
      CREATE TABLE IF NOT EXISTS receipts(key TEXT PRIMARY KEY,input TEXT NOT NULL,result TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),event TEXT NOT NULL,kind TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,route TEXT,status TEXT NOT NULL DEFAULT 'pending',due INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,receipt TEXT,error TEXT,created INTEGER NOT NULL,UNIQUE(project,event,role));
      CREATE TABLE IF NOT EXISTS copies(id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),event TEXT NOT NULL,role TEXT NOT NULL,route TEXT NOT NULL,consumed TEXT,recurring INTEGER NOT NULL DEFAULT 0,UNIQUE(project,event,role,route));
      CREATE TABLE IF NOT EXISTS exchanges(id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),scope TEXT NOT NULL,role TEXT NOT NULL,session TEXT NOT NULL UNIQUE,attempts INTEGER NOT NULL DEFAULT 0,lastDispatch INTEGER NOT NULL DEFAULT 0,runId TEXT,conclusion TEXT,closed INTEGER,observed TEXT,UNIQUE(project,scope,role));
      CREATE TABLE IF NOT EXISTS communication_intents(id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),event TEXT NOT NULL,scope TEXT NOT NULL,kind TEXT NOT NULL,facts TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','composed','dismissed')),reason TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(project,event));
      CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),spec TEXT NOT NULL,next INTEGER NOT NULL,intervalMs INTEGER,enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS sources(session TEXT PRIMARY KEY,source TEXT NOT NULL,updated INTEGER NOT NULL);
      PRAGMA user_version=3;`);
  }
  close() {
    this.db.close();
  }
  all(sql, ...p) {
    return this.db.prepare(sql).all(...p);
  }
  get(sql, ...p) {
    return this.db.prepare(sql).get(...p);
  }
  run(sql, ...p) {
    return this.db.prepare(sql).run(...p);
  }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  once(key, input, fn) {
    return this.tx(() => {
      const digest = hash(input),
        old = this.get('SELECT * FROM receipts WHERE key=?', key);
      if (old) {
        assert.equal(old.input, digest, 'Operation identity reused with different input');
        return JSON.parse(old.result);
      }
      const r = fn();
      this.run('INSERT INTO receipts VALUES(?,?,?,?)', key, digest, JSON.stringify(r), this.now());
      return r;
    });
  }
  project(id) {
    const p = this.get('SELECT * FROM projects WHERE id=?', id);
    assert(p, 'Unknown project');
    return {
      ...p,
      productConversation: JSON.parse(p.product_conversation),
      engineeringConversation: p.engineering_conversation
        ? JSON.parse(p.engineering_conversation)
        : null,
      productFallback: JSON.parse(p.product_fallback),
      engineeringFallback: p.engineering_fallback ? JSON.parse(p.engineering_fallback) : null,
      boards: this.all('SELECT * FROM boards WHERE project=?', id),
    };
  }
  list() {
    return this.all('SELECT id FROM projects ORDER BY priority DESC,created').map((p) =>
      this.project(p.id),
    );
  }
  declare({
    key,
    name,
    purpose,
    route,
    productFallback,
    engineeringFallback = null,
    id = randomUUID(),
  }) {
    const input = {
      name: text(name, 120),
      purpose: text(purpose, 2000),
      route: conversation(route),
      productFallback: conversation(productFallback),
      engineeringFallback: engineeringFallback ? conversation(engineeringFallback) : null,
    };
    return this.once(`declare:${key}`, input, () => {
      this.run(
        'INSERT INTO projects(id,name,purpose,created,product_conversation,product_fallback,engineering_fallback) VALUES(?,?,?,?,?,?,?)',
        id,
        input.name,
        input.purpose,
        this.now(),
        JSON.stringify(input.route),
        JSON.stringify(input.productFallback),
        input.engineeringFallback ? JSON.stringify(input.engineeringFallback) : null,
      );
      return this.project(id);
    });
  }
  move({ key, id, managerRole, route, revision }) {
    role(managerRole);
    route = conversation(route);
    return this.once(`move:${key}`, { id, managerRole, route, revision }, () => {
      const p = this.project(id),
        column = managerRole === 'product' ? 'product_conversation' : 'engineering_conversation';
      assert.equal(p.revision, revision, 'Project changed; reread before moving');
      this.run(
        `UPDATE projects SET ${column}=?,revision=revision+1 WHERE id=?`,
        JSON.stringify(route),
        id,
      );
      return this.project(id);
    });
  }
  context(id, context, revision) {
    text(context, 6000);
    return this.tx(() => {
      const r = this.run(
        'UPDATE projects SET context=?,revision=revision+1 WHERE id=? AND revision=?',
        context,
        id,
        revision,
      );
      assert.equal(r.changes, 1, 'Project changed; reread');
      this.run(
        'UPDATE exchanges SET attempts=0,lastDispatch=0 WHERE project=? AND closed IS NULL',
        id,
      );
      return this.project(id);
    });
  }
  attach(project, board, repository = null) {
    this.project(project);
    const old = this.get('SELECT * FROM boards WHERE id=?', board);
    assert(!old || old.project === project, 'Board belongs to another project');
    assert(!old?.repository || old.repository === repository, 'Repository identity conflict');
    this.run(
      'INSERT INTO boards VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET repository=excluded.repository',
      board,
      project,
      repository,
    );
  }
  source(session, source) {
    this.run(
      'INSERT INTO sources VALUES(?,?,?) ON CONFLICT(session) DO UPDATE SET source=excluded.source,updated=excluded.updated',
      session,
      JSON.stringify(source),
      this.now(),
    );
  }
  getSource(session) {
    const r = this.get('SELECT * FROM sources WHERE session=?', session);
    return r ? JSON.parse(r.source) : null;
  }
  enqueue({
    project,
    event,
    kind = 'milestone',
    managerRole = 'product',
    message,
    route = null,
    due = this.now(),
  }) {
    role(managerRole);
    text(event, 240);
    text(message, 6000);
    this.project(project);
    if (route) route = conversation(route);
    const id = hash([project, event, managerRole]).slice(0, 40),
      old = this.get(
        'SELECT * FROM deliveries WHERE project=? AND event=? AND role=?',
        project,
        event,
        managerRole,
      );
    if (old) {
      assert.equal(old.text, message, 'Delivery event already has different content');
      return old;
    }
    this.run(
      'INSERT INTO deliveries(id,project,event,kind,role,text,route,due,created) VALUES(?,?,?,?,?,?,?,?,?)',
      id,
      project,
      event,
      kind,
      managerRole,
      message,
      route ? JSON.stringify(route) : null,
      due,
      this.now(),
    );
    return this.get('SELECT * FROM deliveries WHERE id=?', id);
  }
  requestCommunication({ project, event, scope, kind, facts }) {
    this.project(project);
    text(event, 240);
    text(scope, 160);
    text(kind, 80);
    const encoded = JSON.stringify(facts);
    assert(encoded.length <= 6000, 'Communication facts exceed bound');
    const id = hash([project, event]).slice(0, 40),
      old = this.get(
        'SELECT * FROM communication_intents WHERE project=? AND event=?',
        project,
        event,
      );
    if (old) {
      assert.equal(old.scope, scope, 'Communication scope changed');
      assert.equal(old.kind, kind, 'Communication kind changed');
      assert.equal(old.facts, encoded, 'Communication facts changed');
      return old;
    }
    this.run(
      'INSERT INTO communication_intents VALUES(?,?,?,?,?,?,?,?,?,?)',
      id,
      project,
      event,
      scope,
      kind,
      encoded,
      'pending',
      null,
      this.now(),
      this.now(),
    );
    this.run('UPDATE projects SET revision=revision+1 WHERE id=?', project);
    return this.get('SELECT * FROM communication_intents WHERE id=?', id);
  }
  copy({ project, event, managerRole, route, recurring = false }) {
    role(managerRole);
    this.project(project);
    route = conversation(route);
    assert(typeof recurring === 'boolean');
    if (recurring) {
      const match = /^schedule:([0-9a-f-]{36}):result$/.exec(event);
      assert(
        match && this.get('SELECT id FROM schedules WHERE id=? AND project=?', match[1], project),
        'Recurring copies require an existing project schedule',
      );
    }
    const encoded = JSON.stringify(route),
      old = this.get(
        'SELECT * FROM copies WHERE project=? AND event=? AND role=? AND route=?',
        project,
        event,
        managerRole,
        encoded,
      ),
      id = old?.id ?? hash([project, event, managerRole, route]).slice(0, 40);
    this.run(
      'INSERT INTO copies(id,project,event,role,route,recurring) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET recurring=excluded.recurring',
      id,
      project,
      text(event, 240),
      managerRole,
      encoded,
      recurring ? 1 : 0,
    );
    return { id };
  }
  exchange(project, scope, managerRole) {
    role(managerRole);
    const old = this.get(
        'SELECT * FROM exchanges WHERE project=? AND scope=? AND role=?',
        project,
        scope,
        managerRole,
      ),
      id = old?.id ?? hash([project, scope, managerRole]).slice(0, 32),
      session = projectSessionKey(managerRole, scope);
    this.run(
      'INSERT OR IGNORE INTO exchanges(id,project,scope,role,session) VALUES(?,?,?,?,?)',
      id,
      project,
      scope,
      managerRole,
      session,
    );
    this.run(
      'UPDATE exchanges SET closed=NULL,conclusion=NULL,session=? WHERE id=? AND closed IS NOT NULL',
      session,
      id,
    );
    return this.get('SELECT * FROM exchanges WHERE id=?', id);
  }
  schedule({ id = randomUUID(), project, spec, next, intervalMs = null }) {
    assert(Number.isSafeInteger(next) && next > 0);
    assert(intervalMs === null || (Number.isSafeInteger(intervalMs) && intervalMs >= 60000));
    this.project(project);
    text(spec.scope, 1400);
    this.run(
      'INSERT INTO schedules VALUES(?,?,?,?,?,1)',
      id,
      project,
      JSON.stringify(spec),
      next,
      intervalMs,
    );
    return this.get('SELECT * FROM schedules WHERE id=?', id);
  }
  reactivate(id, now = this.now()) {
    return this.tx(() => {
      this.project(id);
      for (const s of this.all(
        'SELECT * FROM schedules WHERE project=? AND enabled=1 AND next<=?',
        id,
        now,
      )) {
        if (s.intervalMs)
          this.run(
            'UPDATE schedules SET next=? WHERE id=?',
            s.next + (Math.floor((now - s.next) / s.intervalMs) + 1) * s.intervalMs,
            s.id,
          );
        else this.run('UPDATE schedules SET enabled=0 WHERE id=?', s.id);
      }
      this.run("UPDATE projects SET state='active',revision=revision+1 WHERE id=?", id);
      this.run(
        'UPDATE exchanges SET lastDispatch=0,attempts=0 WHERE project=? AND closed IS NULL',
        id,
      );
      return this.project(id);
    });
  }
}
