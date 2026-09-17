import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configureTopology,agentForRole,projectSessionKey,roleForAgent} from '../src/topology.ts';
import {advisoryArgs} from '../src/helpers/advisory-args.ts';
import {controllerKey} from '../src/helpers/record-contracts.ts';
import {Store} from '../src/store.ts';

const route={conversationRef:`conv_${'a'.repeat(32)}`,channel:'test',accountId:'default',target:'owner',kind:'direct'};

test('configured topology controls agents, sessions, workers, and advisors',()=>{
  configureTopology({productAgentId:'pm',engineeringAgentId:'eng',workerAgentId:'builder',workerRuntime:'acp',sessionNamespace:'project-flow',workerModel:'provider/worker',workerThinking:'medium',advisorModel:'provider/advisor',advisorThinking:'high',advisorTimeoutSeconds:321});
  assert.equal(roleForAgent('pm'),'product');assert.equal(roleForAgent('eng'),'engineering');assert.equal(agentForRole('engineering'),'eng');
  const id='10000000-0000-4000-8000-000000000001',feature={id,notes:`Type: feature\nProject identity: 20000000-0000-4000-8000-000000000002`};
  assert.equal(projectSessionKey('engineering',id),`agent:eng:project-flow:${id}`);assert.equal(controllerKey([feature],feature),`agent:eng:project-flow:${id}`);
  assert.deepEqual(advisoryArgs().spawnArgs,{runtime:'subagent',mode:'run',visible:false,context:'isolated',model:'provider/advisor',thinking:'high',runTimeoutSeconds:321,cleanup:'keep',expectsCompletionMessage:true});
});

test('v1 registry migration preserves counts and translates durable roles and sessions',()=>{
  configureTopology({productAgentId:'pm',engineeringAgentId:'eng',workerAgentId:'builder',sessionNamespace:'project-flow'});
  const root=mkdtempSync(join(tmpdir(),'project-migration-')),path=join(root,'state.sqlite'),db=new DatabaseSync(path),project='10000000-0000-4000-8000-000000000001',scope='20000000-0000-4000-8000-000000000002',encoded=JSON.stringify(route);
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,purpose TEXT NOT NULL,context TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'active',priority INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,created INTEGER NOT NULL,jarvis TEXT NOT NULL,gilfoyle TEXT,fallback TEXT NOT NULL);
    CREATE TABLE deliveries(id TEXT PRIMARY KEY,project TEXT,event TEXT,kind TEXT,role TEXT,text TEXT,route TEXT,status TEXT DEFAULT 'pending',due INTEGER,attempts INTEGER DEFAULT 0,receipt TEXT,error TEXT,created INTEGER);
    CREATE TABLE copies(id TEXT PRIMARY KEY,project TEXT,event TEXT,role TEXT,route TEXT,consumed TEXT,recurring INTEGER DEFAULT 0);
    CREATE TABLE exchanges(id TEXT PRIMARY KEY,project TEXT,scope TEXT,role TEXT,session TEXT UNIQUE,attempts INTEGER DEFAULT 0,lastDispatch INTEGER DEFAULT 0,runId TEXT,conclusion TEXT,closed INTEGER,observed TEXT);
    PRAGMA user_version=1;`);
  db.prepare('INSERT INTO projects(id,name,purpose,created,jarvis,fallback) VALUES(?,?,?,?,?,?)').run(project,'Migrated','Preserve state',1,encoded,encoded);
  db.prepare('INSERT INTO deliveries(id,project,event,kind,role,text,due,created) VALUES(?,?,?,?,?,?,?,?)').run('delivery',project,'event','result','main','done',1,1);
  db.prepare('INSERT INTO copies(id,project,event,role,route) VALUES(?,?,?,?,?)').run('copy',project,'event','gilfoyle',encoded);
  db.prepare('INSERT INTO exchanges(id,project,scope,role,session) VALUES(?,?,?,?,?)').run('exchange',project,scope,'gilfoyle',`agent:gilfoyle:jg:${scope}`);db.close();
  const store=new Store(path);assert.equal(store.get('PRAGMA user_version').user_version,2);assert.equal(store.get('PRAGMA quick_check').quick_check,'ok');
  assert.equal(store.project(project).productConversation.conversationRef,route.conversationRef);assert.equal(store.get('SELECT role FROM deliveries').role,'product');assert.equal(store.get('SELECT role FROM copies').role,'engineering');
  const exchange=store.get('SELECT role,session FROM exchanges');assert.equal(exchange.role,'engineering');assert.equal(exchange.session,`agent:eng:project-flow:${scope}`);store.close();rmSync(root,{recursive:true});
});
