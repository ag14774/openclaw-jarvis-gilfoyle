import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  configureTopology,
  agentForRole,
  projectSessionKey,
  roleForAgent,
  workerProfile,
  workerProfiles,
} from '../src/topology.ts';
import { controllerKey } from '../src/helpers/record-contracts.ts';
import { Store } from '../src/store.ts';

const route = {
  conversationRef: `conv_${'a'.repeat(32)}`,
  channel: 'test',
  accountId: 'default',
  target: 'owner',
  kind: 'direct',
};

test('configured topology controls agents, sessions, and ordered worker profiles', () => {
  const profiles = [
    { id: 'routine', model: 'provider/worker', thinking: 'medium', description: 'Routine work.' },
    { id: 'expert', model: 'provider/expert', thinking: 'high', description: 'Difficult work.' },
  ];
  configureTopology({
    productAgentId: 'pm',
    engineeringAgentId: 'eng',
    workerAgentId: 'builder',
    workerRuntime: 'acp',
    sessionNamespace: 'project-flow',
    workerProfiles: profiles,
  });
  assert.equal(roleForAgent('pm'), 'product');
  assert.equal(roleForAgent('eng'), 'engineering');
  assert.equal(agentForRole('engineering'), 'eng');
  const id = '10000000-0000-4000-8000-000000000001',
    feature = {
      id,
      notes: `Type: feature\nProject identity: 20000000-0000-4000-8000-000000000002`,
    };
  assert.equal(projectSessionKey('engineering', id), `agent:eng:project-flow:${id}`);
  assert.equal(controllerKey([feature], feature), `agent:eng:project-flow:${id}`);
  assert.deepEqual(workerProfiles(), profiles);
  assert.deepEqual(workerProfile('expert'), profiles[1]);
  assert.throws(() => workerProfile('missing'));
  assert.throws(() =>
    configureTopology({
      workerProfiles: Array.from({ length: 6 }, (_, i) => ({
        id: `p${i}`,
        model: 'provider/model',
        thinking: 'low',
        description: 'Too many.',
      })),
    }),
  );
});

test('fresh registry stores only generic roles and configured sessions', () => {
  configureTopology({
    productAgentId: 'pm',
    engineeringAgentId: 'eng',
    workerAgentId: 'builder',
    sessionNamespace: 'project-flow',
  });
  const root = mkdtempSync(join(tmpdir(), 'project-registry-')),
    path = join(root, 'state.sqlite'),
    store = new Store(path),
    project = store.declare({
      key: 'fresh',
      name: 'Fresh',
      purpose: 'Generic roles',
      route,
      productFallback: route,
    }),
    scope = '20000000-0000-4000-8000-000000000002';
  store.enqueue({ project: project.id, event: 'result', message: 'done' });
  store.exchange(project.id, scope, 'engineering');
  assert.equal(store.get('PRAGMA user_version').user_version, 4);
  assert.equal(store.get('PRAGMA quick_check').quick_check, 'ok');
  assert.equal(store.get('SELECT role FROM deliveries').role, 'product');
  const exchange = store.get('SELECT role,session FROM exchanges');
  assert.equal(exchange.role, 'engineering');
  assert.equal(exchange.session, `agent:eng:project-flow:${scope}`);
  store.close();
  rmSync(root, { recursive: true });
});
