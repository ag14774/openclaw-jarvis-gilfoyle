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

test('capacity deferral uses acted short check-ins without pausing or stalling', async () => {
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
      name: 'Capacity wait',
    });
    const first = await h.call('main', parent, {
      operation: 'add_task',
      project: project.project,
      title: 'Owns worker',
    });
    const waiting = await h.call('main', parent, {
      operation: 'add_task',
      project: project.project,
      title: 'Needs capacity',
    });
    const firstKey = taskSessionKey('engineering', h.runtime.store.task(first.task));
    const waitingKey = taskSessionKey('engineering', h.runtime.store.task(waiting.task));
    assert(
      (await h.spawn(firstKey, { agentId: 'opencode', model: 'probe', task: 'Fake worker' }))
        .childSessionKey,
    );
    for (let check = 0; check < 6; check++) {
      assert(
        (await h.spawn(waitingKey, { agentId: 'opencode', model: 'probe', task: 'Must defer' }))
          .blocked,
      );
      const action = await h.call('gilfoyle', waitingKey, {
        operation: 'update_task',
        note: 'Waiting for a free worker; checking again shortly.',
        check_in_minutes: 5,
      });
      assert(!action.error, action.error);
      const row = h.runtime.store.task(waiting.task);
      assert.equal(row.status, 'open');
      assert.equal(row.holder, 'engineering');
      assert.equal(row.idle_wakes, 0);
      assert.equal(row.stalled, null);
      assert.equal(row.check_at, h.now() + 300_000);
      assert.equal(h.runtime.store.project(project.project).state, 'active');
      h.endAllRuns();
      h.advance(300_000);
      await h.tick();
      assert.equal(h.runtime.store.task(waiting.task).stalled, null);
    }
    assert.equal(h.runtime.store.get('SELECT COUNT(*) AS n FROM outbox').n, 0);
  } finally {
    h.runtime.store.close();
  }
});
