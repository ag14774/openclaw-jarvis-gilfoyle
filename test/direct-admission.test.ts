import assert from 'node:assert/strict';
import test from 'node:test';
import { harness } from './support/harness.ts';
import { taskSessionKey } from '../src/topology.ts';

test('concurrent direct worker launches cannot both pass the last available slot', async () => {
  const h = await harness({
    config: {
      worker: {
        agentId: 'opencode',
        runtime: 'acp',
        limit: 1,
        profiles: [{ id: 'probe', model: 'fake/model' }],
      },
    },
  });
  try {
    const parent = 'agent:main:operator';
    const project = await h.call('main', parent, {
      operation: 'create_project',
      name: 'Admission',
    });
    assert(project.project, project.error);
    const tasks = [];
    for (const title of ['First', 'Second']) {
      const result = await h.call('main', parent, {
        operation: 'add_task',
        project: project.project,
        title,
      });
      assert(result.task, result.error);
      tasks.push(h.runtime.store.task(result.task));
    }
    const results = await Promise.all(
      tasks.map((task) =>
        h.spawn(taskSessionKey('engineering', task), {
          agentId: 'opencode',
          model: 'probe',
          task: 'Fake worker only',
        }),
      ),
    );
    assert.equal(results.filter((result) => result.childSessionKey).length, 1);
    assert.equal(
      h.native.sessions.filter((row) => row.key.startsWith('agent:opencode:') && row.hasActiveRun)
        .length,
      1,
    );
  } finally {
    h.runtime.store.close();
  }
});
