import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const sha = (x) => typeof x === 'string' && x.length === 40 && /^[0-9a-f]{40}$/.test(x);
const integer = (x) => Number.isSafeInteger(x) && x > 0;
export const githubRef = (x) =>
  typeof x === 'string' &&
  x.trim() === x &&
  x.length <= 160 &&
  /^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(x) &&
  !x.includes('//') &&
  !x.endsWith('/');

export function hostedSpec(repository, branch, workflows, hosted, operation) {
  assert(
    typeof repository === 'string' &&
      repository.trim() === repository &&
      /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\.git$/.test(
        repository,
      ),
    'Canonical GitHub HTTPS .git repository required',
  );
  const repo = repository.slice('https://github.com/'.length, -4);
  assert(githubRef(branch), 'Invalid integration ref');
  assert(
    hosted &&
      typeof hosted === 'object' &&
      !Array.isArray(hosted) &&
      Object.keys(hosted).every((k) => ['headRef', 'baseSha', 'prNumber'].includes(k)),
    'Invalid hosted input',
  );
  assert(
    githubRef(hosted.headRef) && hosted.headRef !== branch && sha(hosted.baseSha),
    'Invalid hosted candidate',
  );
  assert(
    hosted.prNumber === undefined ? operation === 'publish-gate' : integer(hosted.prNumber),
    'PR number required',
  );
  assert(
    Array.isArray(workflows) && workflows.length > 0 && workflows.length <= 4,
    'Required workflows missing or excessive',
  );
  const names = new Set();
  for (const w of workflows) {
    assert(
      w &&
        Object.keys(w).sort().join(',') === 'jobs,path' &&
        typeof w.path === 'string' &&
        w.path.trim() === w.path &&
        w.path.length <= 160 &&
        /^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/.test(w.path) &&
        !names.has(w.path),
      'Invalid workflow identity',
    );
    names.add(w.path);
    assert(
      Array.isArray(w.jobs) &&
        w.jobs.length > 0 &&
        w.jobs.length <= 20 &&
        new Set(w.jobs).size === w.jobs.length &&
        w.jobs.every(
          (j) => typeof j === 'string' && j.trim() === j && /^[\x20-\x7e]{1,120}$/.test(j),
        ),
      'Invalid required jobs',
    );
  }
  return { repo, branch, workflows, ...hosted };
}

// Shared structural check for durable continuation; no API reads or inferred defaults.
export function hostedCandidate(binding, operation = 'gate') {
  assert(
    binding &&
      typeof binding === 'object' &&
      !Array.isArray(binding) &&
      Object.keys(binding).every((k) =>
        [
          'repo',
          'branch',
          'headRef',
          'baseSha',
          'sha',
          'reviewId',
          'summary',
          'prNumber',
          'workflows',
        ].includes(k),
      ),
    'Invalid hosted candidate binding',
  );
  hostedSpec(
    `https://github.com/${binding.repo}.git`,
    binding.branch,
    binding.workflows,
    {
      headRef: binding.headRef,
      baseSha: binding.baseSha,
      ...(binding.prNumber === undefined ? {} : { prNumber: binding.prNumber }),
    },
    operation,
  );
  assert(
    sha(binding.sha) &&
      typeof binding.reviewId === 'string' &&
      binding.reviewId.length === 36 &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(binding.reviewId),
    'Invalid hosted candidate review',
  );
  assert(
    typeof binding.summary === 'string' &&
      binding.summary.trim().length > 0 &&
      binding.summary.length <= 1400 &&
      !/[\r\n]/.test(binding.summary),
    'Invalid hosted candidate summary',
  );
  return binding;
}

// Fixed API templates only. No pagination, credentials, raw responses or mutation API escape hatch.
export async function githubEvidence(
  spec,
  candidate,
  operation,
  request = (args) =>
    JSON.parse(
      execFileSync('gh', args, {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 2 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ),
) {
  try {
    assert(
      spec &&
        typeof spec === 'object' &&
        !Array.isArray(spec) &&
        Object.keys(spec).every((k) =>
          ['repo', 'branch', 'workflows', 'headRef', 'baseSha', 'prNumber'].includes(k),
        ),
    );
    const s = hostedSpec(
      `https://github.com/${spec.repo}.git`,
      spec.branch,
      spec.workflows,
      {
        headRef: spec.headRef,
        baseSha: spec.baseSha,
        ...(spec.prNumber === undefined ? {} : { prNumber: spec.prNumber }),
      },
      operation,
    );
    assert(['publish-gate', 'gate', 'finish'].includes(operation) && sha(candidate));
    let calls = 0,
      bytes = 0;
    const started = Date.now();
    const get = async (path) => {
      assert(++calls <= 32 && Date.now() - started < 30000);
      const value = await request([
        'api',
        '--hostname',
        'github.com',
        '--method',
        'GET',
        `repos/${s.repo}/${path}`,
      ]);
      const size = Buffer.byteLength(JSON.stringify(value));
      bytes += size;
      assert(size <= 2 * 1024 * 1024 && bytes <= 8 * 1024 * 1024 && Date.now() - started < 35000);
      return value;
    };
    const base = await get(`git/ref/heads/${s.branch}`);
    assert(
      base.ref === `refs/heads/${s.branch}` &&
        base.object?.type === 'commit' &&
        sha(base.object.sha),
    );
    if (operation !== 'finish') assert(base.object.sha === s.baseSha);
    if (operation === 'publish-gate') {
      if (s.prNumber !== undefined) {
        const pr = await get(`pulls/${s.prNumber}`);
        assert(
          pr.number === s.prNumber &&
            pr.state === 'open' &&
            pr.merged === false &&
            pr.head?.repo?.full_name === s.repo &&
            pr.base?.repo?.full_name === s.repo &&
            pr.head.ref === s.headRef &&
            pr.base.ref === s.branch &&
            pr.base.sha === s.baseSha,
        );
      }
      return { status: 'upload-ready', baseSha: s.baseSha };
    }
    if (operation === 'gate') {
      const head = await get(`git/ref/heads/${s.headRef}`);
      assert(
        head.ref === `refs/heads/${s.headRef}` &&
          head.object?.type === 'commit' &&
          head.object.sha === candidate,
      );
    }
    const pr = await get(`pulls/${s.prNumber}`);
    assert(
      pr.number === s.prNumber &&
        pr.head?.repo?.full_name === s.repo &&
        pr.base?.repo?.full_name === s.repo &&
        pr.head.ref === s.headRef &&
        pr.head.sha === candidate &&
        pr.base.ref === s.branch,
    );
    if (operation === 'finish') {
      assert(pr.merged === true && pr.state === 'closed' && sha(pr.merge_commit_sha));
      const commit = await get(`git/commits/${pr.merge_commit_sha}`);
      const candidateCommit = await get(`git/commits/${candidate}`);
      assert(
        commit.sha === pr.merge_commit_sha &&
          commit.parents?.length === 2 &&
          commit.parents[0].sha === s.baseSha &&
          commit.parents[1].sha === candidate &&
          candidateCommit.sha === candidate &&
          sha(commit.tree?.sha) &&
          commit.tree.sha === candidateCommit.tree?.sha,
      );
      if (base.object.sha !== commit.sha) {
        const ancestry = await get(`compare/${commit.sha}...${base.object.sha}`);
        assert(ancestry.status === 'ahead' && ancestry.merge_base_commit?.sha === commit.sha);
      }
      return { status: 'merged', mergeSha: commit.sha, treeSha: commit.tree.sha };
    }
    assert(
      pr.state === 'open' && pr.merged === false && pr.draft === false && pr.base.sha === s.baseSha,
    );
    const compare = await get(`compare/${s.baseSha}...${candidate}`);
    assert(
      ['ahead', 'identical'].includes(compare.status) &&
        compare.merge_base_commit?.sha === s.baseSha,
    );
    const runs = [],
      pending = [];
    for (const w of s.workflows) {
      const workflow = encodeURIComponent(w.path.slice('.github/workflows/'.length));
      const query = `?head_sha=${candidate}&branch=${encodeURIComponent(s.headRef)}&event=push&per_page=100`;
      const listing = await get(`actions/workflows/${workflow}/runs${query}`);
      const complete = (list) =>
        Array.isArray(list.workflow_runs) &&
        Number.isSafeInteger(list.total_count) &&
        list.total_count >= 0 &&
        list.total_count < 100 &&
        list.total_count === list.workflow_runs.length &&
        new Set(list.workflow_runs.map((r) => r.id)).size === list.total_count;
      assert(complete(listing));
      if (!listing.total_count) {
        pending.push(w.path);
        continue;
      }
      const validRun = (r) => {
        const path = typeof r.path === 'string' ? r.path.split('@') : [];
        const qualified =
          path.length === 1 ||
          (path.length === 2 &&
            [s.headRef, `refs/heads/${s.headRef}`, candidate].includes(path[1]));
        return (
          integer(r.id) &&
          integer(r.run_attempt) &&
          integer(r.run_number) &&
          integer(r.workflow_id) &&
          path[0] === w.path &&
          qualified &&
          r.event === 'push' &&
          r.head_branch === s.headRef &&
          r.head_sha === candidate &&
          r.repository?.full_name === s.repo &&
          r.head_repository?.full_name === s.repo
        );
      };
      assert(listing.workflow_runs.every(validRun));
      const selected = [...listing.workflow_runs].sort((a, b) => b.run_number - a.run_number)[0];
      assert(listing.workflow_runs.every((r) => r.workflow_id === selected.workflow_id));
      assert(
        listing.workflow_runs.filter((r) => r.run_number === selected.run_number).length === 1,
      );
      const run = await get(`actions/runs/${selected.id}`);
      assert(
        validRun(run) &&
          ['id', 'run_number', 'run_attempt', 'workflow_id'].every((k) => run[k] === selected[k]),
      );
      const jobs = await get(
        `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
      );
      assert(
        Array.isArray(jobs.jobs) &&
          Number.isSafeInteger(jobs.total_count) &&
          jobs.total_count >= 0 &&
          jobs.total_count < 100 &&
          jobs.total_count === jobs.jobs.length &&
          new Set(jobs.jobs.map((j) => j.id)).size === jobs.total_count,
      );
      assert(
        jobs.jobs.every((j) => integer(j.id) && j.run_id === run.id && j.head_sha === candidate),
      );
      const active = (x) =>
        ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(x.status) &&
        x.conclusion === null;
      const acceptable = (x) =>
        active(x) || (x.status === 'completed' && x.conclusion === 'success');
      assert(acceptable(selected) && acceptable(run));
      for (const name of w.jobs) {
        const matches = jobs.jobs.filter((j) => j.name === name);
        assert(matches.length <= 1);
        if (!matches.length) {
          assert(active(run));
          pending.push(w.path);
          continue;
        }
        const job = matches[0];
        assert(active(job) || (job.status === 'completed' && job.conclusion === 'success'));
        if (active(job)) pending.push(w.path);
      }
      if (active(selected) || active(run)) pending.push(w.path);
      // Detect a rerun/new run while its jobs were being read.
      const again = await get(`actions/workflows/${workflow}/runs${query}`);
      assert(complete(again) && again.workflow_runs.every(validRun));
      const identities = (list) =>
        [...list.workflow_runs]
          .sort((a, b) => a.id - b.id)
          .map((r) => [r.id, r.run_number, r.run_attempt, r.workflow_id]);
      assert.deepEqual(identities(again), identities(listing));
      const latestRun = again.workflow_runs.find((r) => r.id === selected.id);
      assert(acceptable(latestRun));
      if (active(latestRun)) pending.push(w.path);
      runs.push({ workflow: w.path, id: run.id, attempt: run.run_attempt, jobs: w.jobs });
    }
    if (pending.length) return { status: 'ci-wait', baseSha: s.baseSha };
    assert(pr.mergeable === true && pr.mergeable_state === 'clean');
    const latest = await get(`pulls/${s.prNumber}`);
    assert(JSON.stringify(latest) === JSON.stringify(pr));
    const lastBase = await get(`git/ref/heads/${s.branch}`);
    assert(lastBase.object?.sha === s.baseSha);
    return { status: 'merge-ready', baseSha: s.baseSha, runs };
  } catch {
    throw new Error(
      'GitHub evidence incomplete or rejected; reconcile exact candidate before retrying',
    );
  }
}
