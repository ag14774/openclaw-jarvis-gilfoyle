import assert from 'node:assert/strict';
import test from 'node:test';
import './support/setup.ts';
import {
  githubEvidence,
  githubPassedGateEvidence,
  githubStopEvidence,
  hostedSpec,
} from '../src/helpers/github-evidence.ts';
import { githubFixture } from './github-fixture.ts';

async function assertIncomplete(f, promise) {
  await assert.rejects(promise, /^Error: GitHub evidence incomplete/);
  assert.deepEqual(f.unexpectedEndpoints, [], 'Test exercised an unarranged fixture endpoint');
}

test('GitHub evidence uses exact fixed GET requests and returns bounded identities only', async () => {
  const f = githubFixture();
  const result = await githubEvidence(f.spec, f.candidate, 'gate', f.request);
  assert.deepEqual(result, {
    status: 'merge-ready',
    baseSha: f.spec.baseSha,
    runs: [{ workflow: '.github/workflows/ci.yml', id: 10, attempt: 1, jobs: ['test'] }],
  });
  assert(
    f.calls.every(
      (a) => a.slice(0, 5).join(' ') === 'api --hostname github.com --method GET' && a.length === 6,
    ),
  );
  f.merge();
  assert.equal(
    (await githubEvidence(f.spec, f.candidate, 'finish', f.request)).mergeSha,
    f.mergeSha,
  );
});

test('hosted stop settlement requires the exact pull request to be closed', async () => {
  const f = githubFixture();
  await assert.rejects(githubStopEvidence(f.spec, f.candidate, f.request), /not reconciled/);
  f.pr.state = 'closed';
  f.pr.merged = false;
  assert.deepEqual(await githubStopEvidence(f.spec, f.candidate, f.request), {
    state: 'closed',
    merged: false,
    mergeSha: f.pr.merge_commit_sha ?? null,
  });
});

test('hosted finish revalidates the exact retained successful run and jobs', async () => {
  const f = githubFixture();
  const gate = await githubEvidence(f.spec, f.candidate, 'gate', f.request);
  assert.deepEqual(await githubPassedGateEvidence(f.spec, f.candidate, gate.runs, f.request), {
    status: 'passed',
    runs: gate.runs,
  });
  f.run.conclusion = 'failure';
  await assert.rejects(
    githubPassedGateEvidence(f.spec, f.candidate, gate.runs, f.request),
    /could not be revalidated/,
  );
});

for (const change of [
  (f) => (f.pr.head.sha = 'c'.repeat(40)),
  (f) => (f.pr.base.sha = 'c'.repeat(40)),
  (f) => (f.pr.head.repo.full_name = 'other/repo'),
  (f) => (f.pr.base.repo.full_name = 'other/repo'),
  (f) => (f.pr.head.ref = 'wrong'),
  (f) => (f.pr.base.ref = 'wrong'),
  (f) => (f.pr.mergeable = null),
  (f) => (f.pr.mergeable_state = 'unknown'),
  (f) => (f.run.event = 'pull_request'),
  (f) => (f.run.head_sha = 'c'.repeat(40)),
  (f) => (f.run.head_branch = 'wrong'),
  (f) => (f.run.path = '.github/workflows/other.yml'),
  (f) => (f.run.status = 'unknown'),
  (f) => (f.run.conclusion = 'failure'),
  (f) => (f.jobs.jobs[0].conclusion = 'skipped'),
  (f) => (f.jobs.jobs[0].conclusion = 'neutral'),
  (f) => (f.jobs.jobs[0].conclusion = 'cancelled'),
  (f) => (f.jobs.jobs[0].conclusion = null),
  (f) => (f.jobs.jobs[0].head_sha = 'c'.repeat(40)),
  (f) => (f.jobs.jobs[0].run_id = 99),
  (f) => {
    f.jobs.total_count = 0;
    f.jobs.jobs = [];
  },
  (f) => (f.jobs.total_count = 100),
])
  test('wrong, unknown, red, skipped or incomplete GitHub evidence rejects', async () => {
    const f = githubFixture();
    change(f);
    await assertIncomplete(f, githubEvidence(f.spec, f.candidate, 'gate', f.request));
  });

for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested'])
  test(`ordinary ${status} CI returns wait, never merge readiness`, async () => {
    const f = githubFixture();
    f.run.status = status;
    f.run.conclusion = null;
    f.jobs.jobs[0].status = status;
    f.jobs.jobs[0].conclusion = null;
    assert.equal((await githubEvidence(f.spec, f.candidate, 'gate', f.request)).status, 'ci-wait');
  });

test('missing run is a bounded CI wait; truncated runs are not absence', async () => {
  const f = githubFixture();
  const request = (count) => async (args) =>
    args[5].includes('/workflows/') ? { total_count: count, workflow_runs: [] } : f.request(args);
  assert.equal((await githubEvidence(f.spec, f.candidate, 'gate', request(0))).status, 'ci-wait');
  await assertIncomplete(f, githubEvidence(f.spec, f.candidate, 'gate', request(100)));
});

for (const field of ['run_attempt', 'workflow_id', 'run_number'])
  test(`run detail ${field} must agree with selected latest run`, async () => {
    const f = githubFixture();
    await assertIncomplete(
      f,
      githubEvidence(f.spec, f.candidate, 'gate', async (args) => {
        const v = await f.request(args);
        if (args[5].endsWith('actions/runs/10')) v[field]++;
        return v;
      }),
    );
  });

test('new run or rerun during job reads invalidates the gate', async () => {
  const f = githubFixture();
  let listings = 0;
  await assertIncomplete(
    f,
    githubEvidence(f.spec, f.candidate, 'gate', async (args) => {
      const v = await f.request(args);
      if (args[5].includes('/workflows/') && ++listings === 2) v.workflow_runs[0].run_attempt++;
      return v;
    }),
  );
});

for (const qualifier of ['feature/test', 'refs/heads/feature/test', 'a'.repeat(40)])
  test(`qualified workflow path accepts exact ${qualifier}`, async () => {
    const f = githubFixture();
    f.run.path += `@${qualifier}`;
    assert.equal(
      (await githubEvidence(f.spec, f.candidate, 'gate', f.request)).status,
      'merge-ready',
    );
    // Listing and detail may use different valid representations of the same workflow.
    assert.equal(
      (
        await githubEvidence(f.spec, f.candidate, 'gate', async (args) => {
          const value = await f.request(args);
          if (args[5].endsWith('actions/runs/10')) value.path = '.github/workflows/ci.yml';
          return value;
        })
      ).status,
      'merge-ready',
    );
  });

test('qualified workflow paths reject wrong path/ref/SHA/repository/workflow identity', async () => {
  for (const path of [
    '.github/workflows/other.yml@feature/test',
    '.github/workflows/ci.yml@main',
    '.github/workflows/ci.yml@refs/tags/feature/test',
    `.github/workflows/ci.yml@${'b'.repeat(40)}`,
    '.github/workflows/ci.yml@feature/test@extra',
    '.github/workflows/ci.yml@',
    '.github/workflows/ci.yml@feature/test\n',
  ]) {
    const f = githubFixture();
    f.run.path = path;
    await assertIncomplete(f, githubEvidence(f.spec, f.candidate, 'gate', f.request));
  }
  for (const change of [
    (r) => (r.head_sha = 'b'.repeat(40)),
    (r) => (r.head_branch = 'other'),
    (r) => (r.repository.full_name = 'other/repo'),
    (r) => (r.head_repository.full_name = 'other/repo'),
    (r) => (r.workflow_id = 2),
  ]) {
    const f = githubFixture();
    f.run.path += '@feature/test';
    await assertIncomplete(
      f,
      githubEvidence(f.spec, f.candidate, 'gate', async (args) => {
        const value = await f.request(args);
        if (args[5].endsWith('actions/runs/10')) change(value);
        return value;
      }),
    );
  }
});

test('run-list reread tolerates timestamps and ordinary state progress but keeps waits conservative', async () => {
  for (const [before, after, expected] of [
    ['queued', 'in_progress', 'ci-wait'],
    ['in_progress', 'completed', 'ci-wait'],
    ['completed', 'completed', 'merge-ready'],
  ]) {
    const f = githubFixture();
    let listings = 0;
    f.run.status = before;
    f.run.conclusion = before === 'completed' ? 'success' : null;
    const result = await githubEvidence(f.spec, f.candidate, 'gate', async (args) => {
      const value = await f.request(args);
      if (args[5].includes('/workflows/') && ++listings === 2) {
        const r = value.workflow_runs[0];
        r.status = after;
        r.conclusion = after === 'completed' ? 'success' : null;
        r.updated_at = '2026-09-12T12:01:00Z';
        r.display_title = 'ordinary metadata update';
      }
      return value;
    });
    assert.equal(result.status, expected);
  }
});

test('progress tolerance never permits newer runs, reruns, truncation or red/unknown state', async () => {
  for (const change of [
    (l) => l.workflow_runs[0].run_attempt++,
    (l) => {
      l.total_count++;
      l.workflow_runs.push({ ...l.workflow_runs[0], id: 11, run_number: 3 });
    },
    (l) => {
      l.workflow_runs[0].id = 11;
      l.workflow_runs[0].run_number = 3;
    },
    (l) => (l.total_count = 100),
    (l) => (l.workflow_runs[0].conclusion = 'failure'),
    (l) => (l.workflow_runs[0].conclusion = 'skipped'),
    (l) => (l.workflow_runs[0].status = 'unknown'),
  ]) {
    const f = githubFixture();
    let listings = 0;
    await assertIncomplete(
      f,
      githubEvidence(f.spec, f.candidate, 'gate', async (args) => {
        const value = await f.request(args);
        if (args[5].includes('/workflows/') && ++listings === 2) change(value);
        return value;
      }),
    );
  }
});

test('latest relevant run wins over an earlier green run', async () => {
  const f = githubFixture();
  await assertIncomplete(
    f,
    githubEvidence(f.spec, f.candidate, 'gate', async (args) => {
      if (args[5].includes('/workflows/'))
        return {
          total_count: 2,
          workflow_runs: [f.run, { ...f.run, id: 11, run_number: 3, conclusion: 'failure' }],
        };
      if (args[5].endsWith('actions/runs/11'))
        return { ...f.run, id: 11, run_number: 3, conclusion: 'failure' };
      if (args[5].includes('runs/11/attempts/')) return { total_count: 0, jobs: [] };
      return f.request(args);
    }),
  );
});

for (const change of [
  (f) => (f.pr.merge_commit_sha = 'unknown'),
  (f) => (f.commit.sha = 'c'.repeat(40)),
  (f) => f.commit.parents.reverse(),
  (f) => {
    f.commit.parents = [];
  },
  (f) => (f.commit.tree.sha = 'c'.repeat(40)),
])
  test('finish requires actual merge identity, ordered parents and candidate tree', async () => {
    const f = githubFixture();
    f.merge();
    change(f);
    await assertIncomplete(f, githubEvidence(f.spec, f.candidate, 'finish', f.request));
  });

test('verified squash publication accepts the exact approved base and candidate tree', async () => {
  const f = githubFixture();
  f.merge();
  f.commit.parents.pop();
  const result = await githubEvidence(f.spec, f.candidate, 'finish', f.request);
  assert.equal(result.status, 'merged');
});

test('strict hosted normalization denies endpoint injection and excessive or empty requirements', () => {
  const f = githubFixture(),
    h = { headRef: f.spec.headRef, baseSha: f.spec.baseSha, prNumber: 7 };
  for (const repo of [
    'https://evil.test/owner/repo.git',
    'https://token@github.com/owner/repo.git',
    'https://github.com/owner/repo.git?token=secret',
    'git@github.com:owner/repo.git',
  ])
    assert.throws(() => hostedSpec(repo, 'main', f.spec.workflows, h, 'gate'));
  for (const hosted of [
    { ...h, endpoint: 'users/me' },
    { ...h, headRef: 'x?secret' },
    { ...h, headRef: 'main' },
    { ...h, prNumber: 1.5 },
    { ...h, prNumber: undefined },
    { ...h, baseSha: 'a'.repeat(41) },
  ])
    assert.throws(() =>
      hostedSpec('https://github.com/owner/repo.git', 'main', f.spec.workflows, hosted, 'gate'),
    );
  for (const workflows of [
    [],
    [{ path: '.github/workflows/ci.yml', jobs: [] }],
    Array(5).fill(f.spec.workflows[0]),
    [{ path: '../secrets', jobs: ['test'] }],
  ])
    assert.throws(() =>
      hostedSpec('https://github.com/owner/repo.git', 'main', workflows, h, 'gate'),
    );
  for (const hosted of [
    { ...h, headRef: 'feature\n' },
    { ...h, baseSha: f.spec.baseSha + '\n' },
  ])
    assert.throws(() =>
      hostedSpec('https://github.com/owner/repo.git', 'main', f.spec.workflows, hosted, 'gate'),
    );
  assert.throws(() =>
    hostedSpec('https://github.com/owner/repo.git\n', 'main', f.spec.workflows, h, 'gate'),
  );
  assert.throws(() =>
    hostedSpec(
      'https://github.com/owner/repo.git',
      'main',
      [{ path: '.github/workflows/ci.yml\n', jobs: ['test'] }],
      h,
      'gate',
    ),
  );
});

test('private API/command failures are sanitized', async () => {
  const f = githubFixture();
  await assert.rejects(
    githubEvidence(f.spec, f.candidate, 'gate', () => {
      throw Error('TOKEN private repo response');
    }),
    (error) => !error.message.includes('TOKEN') && !error.message.includes('private'),
  );
  await assert.rejects(
    githubEvidence({ ...f.spec, endpoint: 'users/me' }, f.candidate, 'gate', f.request),
  );
  assert.equal(f.calls.length, 0);
});

test('finish permits deleted candidate branch and a later integration descendant, not unrelated history', async () => {
  const f = githubFixture();
  f.merge();
  const tip = 'f'.repeat(40);
  const request = (ancestor) => async (args) => {
    assert(!args[5].includes(`git/ref/heads/${f.spec.headRef}`));
    if (args[5].endsWith('git/ref/heads/main'))
      return { ref: 'refs/heads/main', object: { type: 'commit', sha: tip } };
    if (args[5].includes('/compare/'))
      return { status: 'ahead', merge_base_commit: { sha: ancestor } };
    return f.request(args);
  };
  assert.equal(
    (await githubEvidence(f.spec, f.candidate, 'finish', request(f.mergeSha))).mergeSha,
    f.mergeSha,
  );
  await assertIncomplete(f, githubEvidence(f.spec, f.candidate, 'finish', request(f.spec.baseSha)));
});

test('every configured workflow and job must pass, and response bounds fail sanitized', async () => {
  const f = githubFixture();
  f.spec.workflows[0].jobs.push('lint');
  await assertIncomplete(f, githubEvidence(f.spec, f.candidate, 'gate', f.request));
  f.jobs.jobs.push({ ...f.jobs.jobs[0], id: 21, name: 'lint' });
  f.jobs.total_count++;
  assert.equal(
    (await githubEvidence(f.spec, f.candidate, 'gate', f.request)).status,
    'merge-ready',
  );
  f.spec.workflows.push({ path: '.github/workflows/second.yml', jobs: ['build'] });
  const missingSecondWorkflow = async (args) =>
    args[5].includes('/workflows/second.yml/')
      ? { total_count: 0, workflow_runs: [] }
      : f.request(args);
  assert.equal(
    (await githubEvidence(f.spec, f.candidate, 'gate', missingSecondWorkflow)).status,
    'ci-wait',
  );
  await assert.rejects(
    githubEvidence(f.spec, f.candidate, 'gate', async () => ({
      private: 'x'.repeat(2 * 1024 * 1024),
    })),
    /^Error: GitHub evidence incomplete/,
  );
});
