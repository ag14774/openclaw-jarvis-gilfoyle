import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import plugin from '../dist/index.js';
import { Store } from '../dist/store.js';

const tools = [],
  methods = [],
  services = [],
  hooks = [];
plugin.register({
  pluginConfig: {
    statePath: ':memory:',
    enabled: false,
    productAgentId: 'product',
    engineeringAgentId: 'engineering',
    ownerChat: { channel: 'test', accountId: 'product', to: 'test:owner' },
    worker: { agentId: 'worker', profiles: [{ id: 'routine', model: 'provider/worker' }] },
  },
  logger: { warn() {} },
  registerTool(_factory, options) {
    tools.push(options.name);
  },
  registerGatewayMethod(name) {
    methods.push(name);
  },
  registerService(service) {
    services.push(service.id);
  },
  on(name) {
    hooks.push(name);
  },
});
assert.deepEqual(tools, ['project_board']);
assert.deepEqual(methods, [
  'jarvis-gilfoyle.board.call',
  'jarvis-gilfoyle.board.tick',
  'jarvis-gilfoyle.board.health',
]);
assert.deepEqual(services, ['jarvis-gilfoyle-board']);
assert(hooks.includes('before_tool_call') && hooks.includes('before_prompt_build'));
const store = new Store(':memory:');
assert.equal(store.get('PRAGMA user_version').user_version, 16);
store.close();
const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url)));
assert.deepEqual(manifest.skills, ['./skills']);
assert.deepEqual(manifest.contracts.tools, ['project_board']);
const skill = readFileSync(
  new URL('../skills/project-coordination/SKILL.md', import.meta.url),
  'utf8',
);
assert.match(skill, /^name: project-coordination$/m);
console.log('Compiled distribution verified');
