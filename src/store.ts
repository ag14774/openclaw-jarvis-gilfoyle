import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { repositoryInfo } from './repository-info.js';
import { projectSessionKey } from './topology.js';

export const REGISTRY_SCHEMA_VERSION = 9;
export const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const text = (value, max = 2000) => {
  assert(
    typeof value === 'string' && value.trim() && value.length <= max && !value.includes('\0'),
    'Nonempty bounded text required',
  );
  return value.trim();
};
export const role = (value) => {
  assert(['product', 'engineering'].includes(value), 'Manager role required');
  return value;
};
export const conversation = (value) => {
  assert(
    value && /^conv_[a-f0-9]{30,64}$/.test(value.conversationRef),
    'Native conversation reference required',
  );
  return {
    conversationRef: value.conversationRef,
    channel: text(value.channel, 60),
    accountId: text(value.accountId, 100),
    target: text(value.target, 240),
    ...(value.threadId ? { threadId: String(value.threadId) } : {}),
    kind: value.kind,
  };
};

const json = (value, max = 12000) => {
  const encoded = JSON.stringify(value);
  assert(encoded.length <= max, 'Structured registry value exceeds bound');
  return encoded;
};

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
      version === 0 || version === REGISTRY_SCHEMA_VERSION,
      `Fresh v${REGISTRY_SCHEMA_VERSION} project registry required`,
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,purpose TEXT NOT NULL,context TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','draining','inactive')),priority INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,created INTEGER NOT NULL,product_conversation TEXT NOT NULL,engineering_conversation TEXT,product_fallback TEXT NOT NULL,engineering_fallback TEXT);
      CREATE TABLE IF NOT EXISTS boards(id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),repository TEXT,metadata TEXT);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),source TEXT NOT NULL,title TEXT NOT NULL,scope TEXT NOT NULL,request_key TEXT,created INTEGER NOT NULL,UNIQUE(project,source,request_key));
      CREATE TABLE IF NOT EXISTS features(id TEXT PRIMARY KEY,request TEXT NOT NULL REFERENCES requests(id),project TEXT NOT NULL REFERENCES projects(id),board TEXT NOT NULL REFERENCES boards(id),card TEXT UNIQUE,native_key TEXT NOT NULL UNIQUE,creation_payload TEXT NOT NULL,scope TEXT NOT NULL,scope_revision INTEGER NOT NULL DEFAULT 1,created INTEGER NOT NULL,UNIQUE(request,board));
      CREATE TABLE IF NOT EXISTS feature_scope_revisions(feature TEXT NOT NULL REFERENCES features(id),revision INTEGER NOT NULL,scope TEXT NOT NULL,reason TEXT NOT NULL,source TEXT NOT NULL,projected INTEGER,created INTEGER NOT NULL,PRIMARY KEY(feature,revision),UNIQUE(feature,source));
      CREATE TABLE IF NOT EXISTS obligations(id TEXT PRIMARY KEY,feature TEXT NOT NULL REFERENCES features(id),board TEXT NOT NULL REFERENCES boards(id),card TEXT UNIQUE,native_key TEXT NOT NULL UNIQUE,creation_payload TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('feature','work','review','intervention')),key TEXT NOT NULL,required INTEGER NOT NULL DEFAULT 1,candidate TEXT,created INTEGER NOT NULL,UNIQUE(feature,key),CHECK((kind='review' AND candidate IS NOT NULL) OR (kind<>'review' AND candidate IS NULL)));
      CREATE TABLE IF NOT EXISTS dependencies(obligation TEXT NOT NULL REFERENCES obligations(id),requires TEXT NOT NULL REFERENCES obligations(id),PRIMARY KEY(obligation,requires),CHECK(obligation<>requires));
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,obligation TEXT NOT NULL REFERENCES obligations(id),sequence INTEGER NOT NULL,profile_id TEXT NOT NULL,model TEXT NOT NULL,thinking TEXT NOT NULL,task_name TEXT NOT NULL,timeout_seconds INTEGER NOT NULL,base_sha TEXT NOT NULL,worktree TEXT NOT NULL,branch TEXT NOT NULL,replaces TEXT REFERENCES attempts(id),remaining TEXT,reconciliation TEXT,task_id TEXT UNIQUE,wrapper_task_id TEXT UNIQUE,run_id TEXT UNIQUE,child_session TEXT UNIQUE,created INTEGER NOT NULL,bound INTEGER,UNIQUE(obligation,sequence),UNIQUE(worktree),UNIQUE(branch));
      CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY,feature TEXT NOT NULL REFERENCES features(id),obligation TEXT REFERENCES obligations(id),authority TEXT NOT NULL CHECK(authority IN ('user','agent')),question TEXT NOT NULL,reason TEXT NOT NULL,suggestion TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('open','sent','answered','applied')),answer TEXT,source TEXT,question_delivery TEXT REFERENCES deliveries(id),answer_message TEXT,application TEXT,replacement_required INTEGER,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS publication_checkpoints(feature TEXT PRIMARY KEY REFERENCES features(id),candidate TEXT NOT NULL,review_obligation TEXT NOT NULL REFERENCES obligations(id),backend TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('candidate','waiting','passed','merged')),details TEXT NOT NULL,next_check INTEGER,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS terminal_checkpoints(feature TEXT PRIMARY KEY REFERENCES features(id),kind TEXT NOT NULL CHECK(kind IN ('finalize','publication')),summary TEXT NOT NULL,evidence TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('staged','completed')),created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS control_intents(id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),request TEXT REFERENCES requests(id),feature TEXT NOT NULL REFERENCES features(id),kind TEXT NOT NULL CHECK(kind='stop'),reason TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applied','dismissed')),created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(key TEXT PRIMARY KEY,input TEXT NOT NULL,result TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),event TEXT NOT NULL,kind TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,fallback_text TEXT,route TEXT,status TEXT NOT NULL DEFAULT 'pending',due INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,receipt TEXT,error TEXT,created INTEGER NOT NULL,UNIQUE(project,event,role));
      CREATE TABLE IF NOT EXISTS copies(id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),event TEXT NOT NULL,role TEXT NOT NULL,route TEXT NOT NULL,consumed TEXT,recurring INTEGER NOT NULL DEFAULT 0,UNIQUE(project,event,role,route));
      CREATE TABLE IF NOT EXISTS exchanges(id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),scope TEXT NOT NULL,role TEXT NOT NULL,session TEXT NOT NULL UNIQUE,attempts INTEGER NOT NULL DEFAULT 0,lastDispatch INTEGER NOT NULL DEFAULT 0,runId TEXT,conclusion TEXT,closed INTEGER,observed TEXT,UNIQUE(project,scope,role));
      CREATE TABLE IF NOT EXISTS communication_intents(id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),event TEXT NOT NULL,scope TEXT NOT NULL,kind TEXT NOT NULL,facts TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','composed','dismissed')),eligible INTEGER NOT NULL DEFAULT 1,reason TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(project,event));
      CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),spec TEXT NOT NULL,next INTEGER NOT NULL,intervalMs INTEGER,enabled INTEGER NOT NULL DEFAULT 1,source_key TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS sources(session TEXT PRIMARY KEY,source TEXT NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inactivation_plans(project TEXT NOT NULL REFERENCES projects(id),item TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('obligation','delivery','communication','control','schedule')),disposition TEXT NOT NULL CHECK(disposition IN ('finish','stop','pending')),created INTEGER NOT NULL,PRIMARY KEY(project,item));
      PRAGMA user_version=9;
    `);
  }
  close() {
    this.db.close();
  }
  all(sql, ...parameters) {
    return this.db.prepare(sql).all(...parameters);
  }
  get(sql, ...parameters) {
    return this.db.prepare(sql).get(...parameters);
  }
  run(sql, ...parameters) {
    return this.db.prepare(sql).run(...parameters);
  }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  once(key, input, fn) {
    return this.tx(() => {
      const digest = hash(input);
      const old = this.get('SELECT * FROM receipts WHERE key=?', key);
      if (old) {
        assert.equal(old.input, digest, 'Operation identity reused with different input');
        return JSON.parse(old.result);
      }
      const result = fn();
      this.run(
        'INSERT INTO receipts VALUES(?,?,?,?)',
        key,
        digest,
        JSON.stringify(result),
        this.now(),
      );
      return result;
    });
  }
  project(id) {
    const project = this.get('SELECT * FROM projects WHERE id=?', id);
    assert(project, 'Unknown project');
    return {
      ...project,
      productConversation: JSON.parse(project.product_conversation),
      engineeringConversation: project.engineering_conversation
        ? JSON.parse(project.engineering_conversation)
        : null,
      productFallback: JSON.parse(project.product_fallback),
      engineeringFallback: project.engineering_fallback
        ? JSON.parse(project.engineering_fallback)
        : null,
      boards: this.all('SELECT * FROM boards WHERE project=? ORDER BY id', id).map((board) => ({
        ...board,
        metadata: board.metadata ? repositoryInfo(JSON.parse(board.metadata)) : null,
      })),
    };
  }
  list() {
    return this.all('SELECT id FROM projects ORDER BY priority DESC,created').map(({ id }) =>
      this.project(id),
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
      const project = this.project(id);
      assert.equal(project.revision, revision, 'Project changed; reread before moving');
      const column =
        managerRole === 'product' ? 'product_conversation' : 'engineering_conversation';
      this.run(
        `UPDATE projects SET ${column}=?,revision=revision+1 WHERE id=?`,
        JSON.stringify(route),
        id,
      );
      return this.project(id);
    });
  }
  context(id, value, revision) {
    text(value, 6000);
    return this.tx(() => {
      const result = this.run(
        'UPDATE projects SET context=?,revision=revision+1 WHERE id=? AND revision=?',
        value,
        id,
        revision,
      );
      assert.equal(result.changes, 1, 'Project changed; reread');
      this.run(
        'UPDATE exchanges SET attempts=0,lastDispatch=0 WHERE project=? AND closed IS NULL',
        id,
      );
      return this.project(id);
    });
  }
  attach(project, board, metadata = null) {
    this.project(project);
    const old = this.get('SELECT * FROM boards WHERE id=?', board);
    const info = metadata ? repositoryInfo(metadata) : null;
    assert(!old || old.project === project, 'Board belongs to another project');
    assert(!old?.repository || old.repository === info?.repository, 'Repository identity conflict');
    this.run(
      'INSERT INTO boards(id,project,repository,metadata) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET repository=excluded.repository,metadata=excluded.metadata',
      board,
      project,
      info?.repository ?? null,
      info ? JSON.stringify(info) : null,
    );
  }
  createRequest({ project, source, title, scope, requestKey = null, id = randomUUID() }) {
    const input = {
      project,
      source: json(source, 2000),
      title: text(title, 180),
      scope: text(scope, 1400),
      requestKey: requestKey === null ? null : text(requestKey, 80),
    };
    this.project(project);
    const old = this.get(
      'SELECT * FROM requests WHERE project=? AND source=? AND request_key IS ?',
      project,
      input.source,
      input.requestKey,
    );
    if (old) {
      assert.equal(old.title, input.title, 'Request title changed');
      assert.equal(old.scope, input.scope, 'Request scope changed');
      return old;
    }
    this.run(
      'INSERT INTO requests VALUES(?,?,?,?,?,?,?)',
      id,
      project,
      input.source,
      input.title,
      input.scope,
      input.requestKey,
      this.now(),
    );
    return this.get('SELECT * FROM requests WHERE id=?', id);
  }
  reserveFeature({ request, project, board, scope, creationPayload, id = randomUUID() }) {
    const encodedPayload = json(creationPayload, 6000);
    const prior = this.get('SELECT * FROM features WHERE request=? AND board=?', request, board);
    if (prior) {
      assert.equal(prior.project, project, 'Feature project changed');
      assert.equal(prior.creation_payload, encodedPayload, 'Feature creation payload changed');
      return prior;
    }
    const nativeKey = `feature:${id}`;
    this.tx(() => {
      this.run(
        'INSERT INTO features(id,request,project,board,native_key,creation_payload,scope,created) VALUES(?,?,?,?,?,?,?,?)',
        id,
        request,
        project,
        board,
        nativeKey,
        encodedPayload,
        text(scope, 1400),
        this.now(),
      );
      this.run(
        "INSERT INTO obligations(id,feature,board,native_key,creation_payload,kind,key,required,created) VALUES(?,?,?,?,?,?,'feature',1,?)",
        id,
        id,
        board,
        nativeKey,
        encodedPayload,
        'feature',
        this.now(),
      );
      this.run(
        'INSERT INTO feature_scope_revisions VALUES(?,?,?,?,?,?,?)',
        id,
        1,
        text(scope, 1400),
        'Initial accepted scope',
        `request:${request}`,
        null,
        this.now(),
      );
    });
    return this.get('SELECT * FROM features WHERE id=?', id);
  }
  bindFeatureCard(id, card) {
    return this.tx(() => {
      const feature = this.get('SELECT * FROM features WHERE id=?', id);
      assert(feature, 'Reserved Feature required');
      if (feature.card) assert.equal(feature.card, card, 'Feature card identity changed');
      else {
        this.run('UPDATE features SET card=? WHERE id=? AND card IS NULL', card, id);
        this.run('UPDATE obligations SET card=? WHERE id=? AND card IS NULL', card, id);
      }
      return this.get('SELECT * FROM features WHERE id=?', id);
    });
  }
  reserveObligation({
    feature,
    board,
    kind,
    key,
    required = true,
    requires = [],
    candidate = null,
    creationPayload,
    id = randomUUID(),
  }) {
    assert(['work', 'review', 'intervention'].includes(kind), 'Invalid obligation kind');
    const encodedPayload = json(creationPayload, 6000);
    text(key, 160);
    const parent = this.get('SELECT * FROM features WHERE id=?', feature);
    assert(parent && parent.board === board, 'Feature and board relationship required');
    const old = this.get('SELECT * FROM obligations WHERE feature=? AND key=?', feature, key);
    if (old) {
      assert(
        old.kind === kind && old.required === (required ? 1 : 0),
        'Obligation identity conflict',
      );
      assert.equal(old.candidate, candidate, 'Review candidate changed');
      assert.equal(old.creation_payload, encodedPayload, 'Obligation creation payload changed');
      assert.deepEqual(
        this.all(
          'SELECT requires FROM dependencies WHERE obligation=? ORDER BY requires',
          old.id,
        ).map((row) => row.requires),
        [...requires].sort(),
        'Obligation dependencies changed',
      );
      return old;
    }
    assert(kind === 'review' ? /^[0-9a-f]{40}$/.test(candidate ?? '') : candidate === null);
    const nativeKey = `obligation:${id}`;
    this.tx(() => {
      this.run(
        'INSERT INTO obligations(id,feature,board,native_key,creation_payload,kind,key,required,candidate,created) VALUES(?,?,?,?,?,?,?,?,?,?)',
        id,
        feature,
        board,
        nativeKey,
        encodedPayload,
        kind,
        key,
        required ? 1 : 0,
        candidate,
        this.now(),
      );
      for (const dependency of requires) {
        const row = this.get(
          'SELECT * FROM obligations WHERE id=? AND feature=?',
          dependency,
          feature,
        );
        assert(row, 'Dependency belongs to another Feature');
        this.run('INSERT INTO dependencies VALUES(?,?)', id, dependency);
      }
    });
    return this.get('SELECT * FROM obligations WHERE id=?', id);
  }
  bindObligationCard(id, card) {
    const obligation = this.obligation(id);
    if (obligation.card) assert.equal(obligation.card, card, 'Obligation card identity changed');
    else this.run('UPDATE obligations SET card=? WHERE id=? AND card IS NULL', card, id);
    return this.get('SELECT * FROM obligations WHERE id=?', id);
  }
  feature(id) {
    const row = this.get('SELECT * FROM features WHERE id=? OR card=?', id, id);
    assert(row, 'Unknown registered Feature');
    return row;
  }
  obligation(id) {
    const row = this.get('SELECT * FROM obligations WHERE id=? OR card=?', id, id);
    assert(row, 'Unknown registered obligation');
    return row;
  }
  records(project) {
    return {
      requests: this.all('SELECT * FROM requests WHERE project=? ORDER BY created', project),
      features: this.all('SELECT * FROM features WHERE project=? ORDER BY created', project),
      obligations: this.all(
        'SELECT o.* FROM obligations o JOIN features f ON f.id=o.feature WHERE f.project=? ORDER BY o.created',
        project,
      ),
      dependencies: this.all(
        'SELECT d.* FROM dependencies d JOIN obligations o ON o.id=d.obligation JOIN features f ON f.id=o.feature WHERE f.project=?',
        project,
      ),
      attempts: this.all(
        'SELECT a.* FROM attempts a JOIN obligations o ON o.id=a.obligation JOIN features f ON f.id=o.feature WHERE f.project=? ORDER BY a.created',
        project,
      ),
      decisions: this.all(
        'SELECT d.* FROM decisions d JOIN features f ON f.id=d.feature WHERE f.project=? ORDER BY d.created',
        project,
      ),
      publications: this.all(
        'SELECT p.* FROM publication_checkpoints p JOIN features f ON f.id=p.feature WHERE f.project=?',
        project,
      ),
      terminalCheckpoints: this.all(
        'SELECT t.* FROM terminal_checkpoints t JOIN features f ON f.id=t.feature WHERE f.project=?',
        project,
      ),
      controls: this.all('SELECT * FROM control_intents WHERE project=? ORDER BY created', project),
    };
  }
  prepareAttempt(input) {
    const obligation = this.obligation(input.obligation);
    assert(
      obligation.kind === 'work' || obligation.kind === 'review',
      'Executable obligation required',
    );
    const old = this.get(
      'SELECT * FROM attempts WHERE obligation=? AND sequence=?',
      obligation.id,
      input.sequence,
    );
    if (old) {
      const expected = {
        profile_id: input.profileId,
        model: input.model,
        thinking: input.thinking,
        task_name: input.taskName,
        timeout_seconds: input.timeoutSeconds,
        base_sha: input.baseSha,
        worktree: input.worktree,
        branch: input.branch,
        replaces: input.replaces ?? null,
        remaining: input.remaining ?? null,
        reconciliation: input.reconciliation ?? null,
      };
      for (const [field, value] of Object.entries(expected))
        assert.equal(old[field], value, 'Prepared attempt conflicts with retry');
      return old;
    }
    const id = input.id ?? randomUUID();
    this.run(
      'INSERT INTO attempts(id,obligation,sequence,profile_id,model,thinking,task_name,timeout_seconds,base_sha,worktree,branch,replaces,remaining,reconciliation,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id,
      obligation.id,
      input.sequence,
      input.profileId,
      input.model,
      input.thinking,
      input.taskName,
      input.timeoutSeconds,
      input.baseSha,
      input.worktree,
      input.branch,
      input.replaces ?? null,
      input.remaining ?? null,
      input.reconciliation ?? null,
      this.now(),
    );
    return this.get('SELECT * FROM attempts WHERE id=?', id);
  }
  bindAttempt(id, refs) {
    return this.tx(() => {
      const attempt = this.get('SELECT * FROM attempts WHERE id=?', id);
      assert(attempt, 'Prepared attempt required');
      if (attempt.bound) {
        for (const [field, value] of Object.entries(refs)) assert.equal(attempt[field], value);
        return attempt;
      }
      this.run(
        'UPDATE attempts SET task_id=?,wrapper_task_id=?,run_id=?,child_session=?,bound=? WHERE id=?',
        refs.task_id,
        refs.wrapper_task_id,
        refs.run_id,
        refs.child_session,
        this.now(),
        id,
      );
      return this.get('SELECT * FROM attempts WHERE id=?', id);
    });
  }
  recordDecision(input) {
    const old = this.get('SELECT * FROM decisions WHERE id=?', input.id);
    if (old) {
      assert.equal(old.feature, this.feature(input.feature).id, 'Decision Feature changed');
      assert.equal(old.obligation, input.obligation ?? null, 'Decision obligation changed');
      assert.equal(old.authority, input.authority, 'Decision authority changed');
      assert.equal(old.question, text(input.question, 1400), 'Decision question changed');
      assert.equal(old.reason, text(input.reason, 1400), 'Decision reason changed');
      assert.equal(old.suggestion, text(input.suggestion, 1400), 'Decision suggestion changed');
      return old;
    }
    const feature = this.feature(input.feature);
    if (input.obligation) assert.equal(this.obligation(input.obligation).feature, feature.id);
    this.run(
      "INSERT INTO decisions(id,feature,obligation,authority,question,reason,suggestion,phase,source,created,updated) VALUES(?,?,?,?,?,?,?,'open',?,?,?)",
      input.id,
      feature.id,
      input.obligation ?? null,
      input.authority,
      text(input.question, 1400),
      text(input.reason, 1400),
      text(input.suggestion, 1400),
      input.source ? json(input.source, 2000) : null,
      this.now(),
      this.now(),
    );
    return this.get('SELECT * FROM decisions WHERE id=?', input.id);
  }
  publication({ feature, candidate, reviewObligation, backend, state, details, nextCheck = null }) {
    feature = this.feature(feature).id;
    const review = this.obligation(reviewObligation);
    assert(review.feature === feature && review.kind === 'review', 'Registered review required');
    assert.equal(review.candidate, candidate, 'Publication candidate differs from review');
    const old = this.get('SELECT * FROM publication_checkpoints WHERE feature=?', feature);
    if (old) {
      assert.equal(old.candidate, candidate, 'Publication candidate changed');
      assert.equal(old.review_obligation, review.id, 'Publication review changed');
      assert.equal(old.backend, backend, 'Publication backend changed');
    }
    this.run(
      'INSERT INTO publication_checkpoints VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(feature) DO UPDATE SET candidate=excluded.candidate,review_obligation=excluded.review_obligation,backend=excluded.backend,state=excluded.state,details=excluded.details,next_check=excluded.next_check,updated=excluded.updated',
      feature,
      candidate,
      review.id,
      backend,
      state,
      json(details),
      nextCheck,
      this.now(),
    );
    return this.get('SELECT * FROM publication_checkpoints WHERE feature=?', feature);
  }
  stageFeatureRevision({ feature, expectedRevision, scope, reason, source }) {
    feature = this.feature(feature).id;
    scope = text(scope, 1400);
    reason = text(reason, 1400);
    source = text(source, 2000);
    return this.tx(() => {
      const current = this.feature(feature);
      const bySource = this.get(
        'SELECT * FROM feature_scope_revisions WHERE feature=? AND source=?',
        feature,
        source,
      );
      if (bySource) {
        assert.equal(bySource.scope, scope, 'Amendment source scope changed');
        assert.equal(bySource.reason, reason, 'Amendment source reason changed');
        return bySource;
      }
      assert.equal(current.scope_revision, expectedRevision, 'Feature scope changed; reread');
      const terminal = this.get('SELECT * FROM terminal_checkpoints WHERE feature=?', feature);
      assert(terminal?.state !== 'completed', 'Completed Feature cannot be amended');
      if (terminal) {
        const event = `result:${feature}`;
        const intent = this.get(
          'SELECT * FROM communication_intents WHERE project=? AND event=?',
          current.project,
          event,
        );
        assert(
          !intent || (intent.status === 'pending' && intent.eligible === 0),
          'Active terminal communication cannot be invalidated',
        );
        assert(
          !this.get(
            'SELECT id FROM deliveries WHERE project=? AND event=?',
            current.project,
            event,
          ),
          'Terminal delivery already exists',
        );
        if (intent) this.run('DELETE FROM communication_intents WHERE id=?', intent.id);
        this.run('DELETE FROM terminal_checkpoints WHERE feature=?', feature);
      }
      const revision = expectedRevision + 1;
      this.run(
        'INSERT INTO feature_scope_revisions VALUES(?,?,?,?,?,?,?)',
        feature,
        revision,
        scope,
        reason,
        source,
        null,
        this.now(),
      );
      this.run(
        'UPDATE features SET scope=?,scope_revision=? WHERE id=? AND scope_revision=?',
        scope,
        revision,
        feature,
        expectedRevision,
      );
      this.run('DELETE FROM publication_checkpoints WHERE feature=?', feature);
      return this.get(
        'SELECT * FROM feature_scope_revisions WHERE feature=? AND revision=?',
        feature,
        revision,
      );
    });
  }
  markFeatureRevisionProjected(feature, revision) {
    this.run(
      'UPDATE feature_scope_revisions SET projected=? WHERE feature=? AND revision=?',
      this.now(),
      this.feature(feature).id,
      revision,
    );
  }
  stageTerminal({ feature, kind, summary, evidence }) {
    feature = this.feature(feature);
    assert(['finalize', 'publication'].includes(kind));
    summary = text(summary, 2000);
    const encodedEvidence = json(evidence, 4000);
    const event = `result:${feature.id}`;
    return this.tx(() => {
      const old = this.get('SELECT * FROM terminal_checkpoints WHERE feature=?', feature.id);
      if (old) {
        assert.equal(old.kind, kind, 'Terminal checkpoint kind changed');
        assert.equal(old.summary, summary, 'Terminal summary changed');
        assert.equal(old.evidence, encodedEvidence, 'Terminal evidence changed');
      } else
        this.run(
          "INSERT INTO terminal_checkpoints VALUES(?,?,?,?, 'staged',?,?)",
          feature.id,
          kind,
          summary,
          encodedEvidence,
          this.now(),
          this.now(),
        );
      const intent = this.get(
        'SELECT * FROM communication_intents WHERE project=? AND event=?',
        feature.project,
        event,
      );
      const facts = json({
        condition: 'terminal-result',
        featureId: feature.id,
        featureCardId: feature.card,
        summary,
        evidence,
      });
      if (intent) {
        assert.equal(intent.kind, 'result', 'Terminal communication kind changed');
        assert.equal(intent.facts, facts, 'Terminal communication facts changed');
      } else
        this.run(
          "INSERT INTO communication_intents(id,project,event,scope,kind,facts,status,eligible,created,updated) VALUES(?,?,?,?,?,?,'pending',0,?,?)",
          hash([feature.project, event]).slice(0, 40),
          feature.project,
          event,
          feature.id,
          'result',
          facts,
          this.now(),
          this.now(),
        );
      return this.get('SELECT * FROM terminal_checkpoints WHERE feature=?', feature.id);
    });
  }
  completeTerminal(feature) {
    feature = this.feature(feature);
    return this.tx(() => {
      const checkpoint = this.get('SELECT * FROM terminal_checkpoints WHERE feature=?', feature.id);
      assert(checkpoint, 'Staged terminal checkpoint required');
      this.run(
        "UPDATE terminal_checkpoints SET state='completed',updated=? WHERE feature=?",
        this.now(),
        feature.id,
      );
      this.run(
        "UPDATE communication_intents SET eligible=1,updated=? WHERE project=? AND event=? AND status='pending'",
        this.now(),
        feature.project,
        `result:${feature.id}`,
      );
      return this.get('SELECT * FROM terminal_checkpoints WHERE feature=?', feature.id);
    });
  }
  pendingStop(feature) {
    return this.get(
      "SELECT * FROM control_intents WHERE feature=? AND kind='stop' AND state='pending'",
      this.feature(feature).id,
    );
  }
  settleControl(id) {
    const result = this.run(
      "UPDATE control_intents SET state='applied',updated=? WHERE id=? AND state='pending'",
      this.now(),
      id,
    );
    assert.equal(result.changes, 1, 'Pending stop control required');
    return this.get('SELECT * FROM control_intents WHERE id=?', id);
  }
  control({ project, request = null, feature, kind = 'stop', reason, id = randomUUID() }) {
    assert.equal(kind, 'stop', 'Only stop control intent is supported');
    this.project(project);
    if (request)
      assert.equal(this.get('SELECT project FROM requests WHERE id=?', request)?.project, project);
    const target = this.feature(feature);
    assert.equal(target.project, project);
    const old = this.get(
      "SELECT * FROM control_intents WHERE feature=? AND kind='stop' AND state='pending'",
      target.id,
    );
    if (old) {
      assert.equal(old.reason, text(reason, 1400), 'Stop reason changed');
      return old;
    }
    this.run(
      "INSERT INTO control_intents VALUES(?,?,?,?,?,?,'pending',?,?)",
      id,
      project,
      request,
      target.id,
      kind,
      text(reason, 1400),
      this.now(),
      this.now(),
    );
    return this.get('SELECT * FROM control_intents WHERE id=?', id);
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
    const row = this.get('SELECT * FROM sources WHERE session=?', session);
    return row ? JSON.parse(row.source) : null;
  }
  enqueue({
    project,
    event,
    kind = 'milestone',
    managerRole = 'product',
    message,
    fallbackMessage,
    route = null,
    due = this.now(),
  }) {
    role(managerRole);
    text(event, 240);
    text(message, 6000);
    if (fallbackMessage !== undefined) text(fallbackMessage, 6000);
    this.project(project);
    if (route) route = conversation(route);
    const id = hash([project, event, managerRole]).slice(0, 40);
    const old = this.get(
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
      'INSERT INTO deliveries(id,project,event,kind,role,text,fallback_text,route,due,created) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id,
      project,
      event,
      kind,
      managerRole,
      message,
      fallbackMessage ?? null,
      route ? JSON.stringify(route) : null,
      due,
      this.now(),
    );
    return this.get('SELECT * FROM deliveries WHERE id=?', id);
  }
  requestCommunication({ project, event, scope, kind, facts }) {
    this.project(project);
    const encoded = json(facts, 6000);
    const id = hash([project, event]).slice(0, 40);
    const old = this.get(
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
      'INSERT INTO communication_intents(id,project,event,scope,kind,facts,status,eligible,reason,created,updated) VALUES(?,?,?,?,?,? ,?,1,?,?,?)',
      id,
      project,
      text(event, 240),
      text(scope, 160),
      text(kind, 80),
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
    route = conversation(route);
    this.project(project);
    if (recurring) {
      const match = /^schedule:([0-9a-f-]{36}):result$/.exec(event);
      assert(
        match && this.get('SELECT id FROM schedules WHERE id=? AND project=?', match[1], project),
        'Recurring copies require an existing project schedule',
      );
    }
    const encoded = JSON.stringify(route);
    const old = this.get(
      'SELECT * FROM copies WHERE project=? AND event=? AND role=? AND route=?',
      project,
      event,
      managerRole,
      encoded,
    );
    const id = old?.id ?? hash([project, event, managerRole, route]).slice(0, 40);
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
    );
    const id = old?.id ?? hash([project, scope, managerRole]).slice(0, 32);
    const session = projectSessionKey(managerRole, scope);
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
  schedule({ id = randomUUID(), project, spec, next, intervalMs = null, sourceKey }) {
    assert(Number.isSafeInteger(next) && next > 0);
    assert(intervalMs === null || (Number.isSafeInteger(intervalMs) && intervalMs >= 60000));
    this.project(project);
    text(spec.scope, 1400);
    text(sourceKey, 240);
    const encoded = JSON.stringify(spec);
    const old = this.get('SELECT * FROM schedules WHERE source_key=?', sourceKey);
    if (old) {
      assert.equal(old.project, project, 'Schedule project changed');
      assert.equal(old.spec, encoded, 'Schedule specification changed');
      assert.equal(old.next, next, 'Schedule start changed');
      assert.equal(old.intervalMs, intervalMs, 'Schedule interval changed');
      return old;
    }
    this.run(
      'INSERT INTO schedules(id,project,spec,next,intervalMs,enabled,source_key) VALUES(?,?,?,?,?,1,?)',
      id,
      project,
      encoded,
      next,
      intervalMs,
      sourceKey,
    );
    return this.get('SELECT * FROM schedules WHERE id=?', id);
  }
  reactivate(id, now = this.now()) {
    return this.tx(() => {
      this.project(id);
      for (const schedule of this.all(
        'SELECT * FROM schedules WHERE project=? AND enabled=1 AND next<=?',
        id,
        now,
      )) {
        if (schedule.intervalMs)
          this.run(
            'UPDATE schedules SET next=? WHERE id=?',
            schedule.next +
              (Math.floor((now - schedule.next) / schedule.intervalMs) + 1) * schedule.intervalMs,
            schedule.id,
          );
        else this.run('UPDATE schedules SET enabled=0 WHERE id=?', schedule.id);
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
