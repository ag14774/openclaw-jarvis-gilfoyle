import assert from 'node:assert/strict';
import test from 'node:test';
import plugin from '../src/index.ts';
import { configureTopology } from '../src/topology.ts';
import { projectRoleContext } from '../src/role-context.ts';

test('display identity is preferred, with configured name and ID fallbacks independent of roles', () => {
  configureTopology({ productAgentId: 'planner', engineeringAgentId: 'builder' });
  const config = {
    agents: {
      entries: {
        planner: { name: 'Internal label', identity: { name: 'Athena' } },
        builder: { name: 'Hephaestus' },
      },
    },
  };
  const context = projectRoleContext(config, 'planner');
  assert.match(context, /Your project role is product manager/);
  assert(!context.includes('Athena (agent id planner)'));
  assert.match(projectRoleContext(config, 'builder'), /Athena \(agent id planner\)/);
  assert.match(context, /Hephaestus \(agent id builder\)/);
  assert(!context.includes('Internal label'));
  config.agents.entries.planner.identity.name = '   ';
  assert.match(projectRoleContext(config, 'builder'), /Internal label \(agent id planner\)/);
  assert.match(projectRoleContext({}, 'builder'), /The product manager is agent id planner/);
  assert.equal(projectRoleContext(config, 'unrelated'), null);
});

test('prompt hook gives both configured managers role context in internal and sourceless turns', async () => {
  const hooks = new Map();
  const config = {
    agents: {
      entries: {
        planner: { identity: { name: 'Athena' } },
        builder: { identity: { name: 'Hephaestus' } },
      },
    },
  };
  plugin.register({
    config,
    pluginConfig: {
      enabled: false,
      statePath: ':memory:',
      productAgentId: 'planner',
      engineeringAgentId: 'builder',
      sessionNamespace: 'project-flow',
      worker: {
        agentId: 'worker',
        runtime: 'acp',
        profiles: [
          { id: 'routine', model: 'provider/model', thinking: 'low', description: 'Work' },
        ],
      },
    },
    logger: { warn() {} },
    on: (event, hook) => hooks.set(event, hook),
    registerTool() {},
    registerGatewayMethod() {},
    registerService() {},
  });
  const hook = hooks.get('before_prompt_build');
  for (const [agentId, role] of [
    ['planner', 'product'],
    ['builder', 'engineering'],
  ]) {
    for (const sessionKey of [`agent:${agentId}:main`, `agent:${agentId}:project-flow:feature`]) {
      const result = await hook({}, { agentId, sessionKey });
      assert(result.prependContext.includes(`Your project role is ${role} manager`));
      assert.equal(
        result.prependContext.includes('Athena (agent id planner)'),
        role === 'engineering',
      );
      assert.equal(
        result.prependContext.includes('Hephaestus (agent id builder)'),
        role === 'product',
      );
      assert(result.prependContext.includes('project-coordination'));
    }
  }
  assert.equal(await hook({}, { agentId: 'worker', sessionKey: 'agent:worker:main' }), undefined);
  config.agents.entries.planner.identity.name = 'Renamed';
  assert(
    (await hook({}, { agentId: 'builder' })).prependContext.includes('Renamed (agent id planner)'),
  );
});
