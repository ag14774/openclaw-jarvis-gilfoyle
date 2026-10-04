import assert from 'node:assert/strict';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// The board: projects, tasks (whose turn it is), their notes, and the notification outbox.
export const SCHEMA_VERSION = 18;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  route TEXT,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','archived')),
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','cancelled')),
  holder TEXT CHECK(holder IN ('product','engineering','user')),
  created_by TEXT NOT NULL CHECK(created_by IN ('product','engineering')),
  workers TEXT NOT NULL DEFAULT '[]',
  poked INTEGER,
  woken INTEGER,
  check_at INTEGER,
  idle_wakes INTEGER NOT NULL DEFAULT 0,
  stalled INTEGER,
  cleaned INTEGER,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS tasks_open ON tasks(status, project);
CREATE TABLE IF NOT EXISTS notes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task INTEGER NOT NULL REFERENCES tasks(id),
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS notes_task ON notes(task, id);
CREATE TABLE IF NOT EXISTS outbox(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL REFERENCES projects(id),
  task INTEGER REFERENCES tasks(id),
  text TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]',
  fallback INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','handed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  error TEXT,
  receipt TEXT,
  recorded INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(state, next_at);
`;

export class Store {
  constructor(path, { now = () => Date.now() } = {}) {
    this.now = now;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;',
    );
    const version = this.get('PRAGMA user_version').user_version;
    assert(
      version === 0 || version === SCHEMA_VERSION,
      `statePath is not a project board (schema ${version}, expected ${SCHEMA_VERSION}); point it at a new or existing board file`,
    );
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
  }
  get(sql, ...args) {
    return this.db.prepare(sql).get(...args);
  }
  all(sql, ...args) {
    return this.db.prepare(sql).all(...args);
  }
  run(sql, ...args) {
    return this.db.prepare(sql).run(...args);
  }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
  }

  project(id) {
    const row = this.get('SELECT * FROM projects WHERE id=?', String(id ?? ''));
    assert(row, `Unknown project ${id}; call list for project ids`);
    return { ...row, route: row.route ? JSON.parse(row.route) : null };
  }
  projects() {
    return this.all('SELECT * FROM projects ORDER BY created').map((row) => ({
      ...row,
      route: row.route ? JSON.parse(row.route) : null,
    }));
  }
  task(id) {
    const row = this.get(
      'SELECT * FROM tasks WHERE id=?',
      Number(String(id ?? '').replace(/^#/, '')),
    );
    assert(row, `Unknown task ${id}; call list for task ids`);
    return { ...row, workers: JSON.parse(row.workers) };
  }
  notes(task, limit = 50) {
    return this.all(
      'SELECT author,text,created FROM (SELECT * FROM notes WHERE task=? ORDER BY id DESC LIMIT ?) ORDER BY id',
      task,
      limit,
    );
  }
  note(task, author, text) {
    this.run(
      'INSERT INTO notes(task,author,text,created) VALUES(?,?,?,?)',
      task,
      author,
      text,
      this.now(),
    );
  }
  enqueue(project, task, text, files = []) {
    const now = this.now();
    return Number(
      this.run(
        'INSERT INTO outbox(project,task,text,files,next_at,created) VALUES(?,?,?,?,?,?)',
        project,
        task ?? null,
        text,
        JSON.stringify(files),
        now,
        now,
      ).lastInsertRowid,
    );
  }
}
