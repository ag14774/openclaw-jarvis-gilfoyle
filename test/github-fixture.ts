// In-memory API fixture only; never invokes gh or native APIs.
export function githubFixture() {
  const candidate = 'a'.repeat(40),
    baseSha = 'b'.repeat(40),
    mergeSha = 'd'.repeat(40),
    treeSha = 'e'.repeat(40);
  const spec = {
    repo: 'owner/repo',
    branch: 'main',
    headRef: 'feature/test',
    baseSha,
    prNumber: 7,
    workflows: [{ path: '.github/workflows/ci.yml', jobs: ['test'] }],
  };
  const run = {
    id: 10,
    run_attempt: 1,
    run_number: 2,
    workflow_id: 1,
    path: '.github/workflows/ci.yml',
    event: 'push',
    head_branch: spec.headRef,
    head_sha: candidate,
    repository: { full_name: spec.repo },
    head_repository: { full_name: spec.repo },
    status: 'completed',
    conclusion: 'success',
  };
  const pr = {
    number: 7,
    state: 'open',
    merged: false,
    draft: false,
    mergeable: true,
    mergeable_state: 'clean',
    head: { repo: { full_name: spec.repo }, ref: spec.headRef, sha: candidate },
    base: { repo: { full_name: spec.repo }, ref: 'main', sha: baseSha },
  };
  const jobs = {
    total_count: 1,
    jobs: [
      {
        id: 20,
        run_id: 10,
        head_sha: candidate,
        name: 'test',
        status: 'completed',
        conclusion: 'success',
      },
    ],
  };
  const commit = {
    sha: mergeSha,
    parents: [{ sha: baseSha }, { sha: candidate }],
    tree: { sha: treeSha },
  };
  let merged = false;
  const calls = [],
    unexpectedEndpoints = [];
  const request = async (args) => {
    calls.push(args);
    if (args.slice(0, 5).join(' ') !== 'api --hostname github.com --method GET')
      throw Error('Only GET allowed');
    const path = args[5];
    if (!path.startsWith('repos/owner/repo/')) throw Error('Wrong repository');
    const endpoint = path.slice('repos/owner/repo/'.length);
    let value;
    if (endpoint === 'git/ref/heads/main')
      value = {
        ref: 'refs/heads/main',
        object: { type: 'commit', sha: merged ? mergeSha : baseSha },
      };
    else if (endpoint === `git/ref/heads/${spec.headRef}`)
      value = { ref: `refs/heads/${spec.headRef}`, object: { type: 'commit', sha: candidate } };
    else if (endpoint === 'pulls/7') value = pr;
    else if (endpoint === `compare/${baseSha}...${candidate}`)
      value = { status: 'ahead', merge_base_commit: { sha: baseSha } };
    else if (
      endpoint ===
      `actions/workflows/ci.yml/runs?head_sha=${candidate}&branch=feature%2Ftest&event=push&per_page=100`
    )
      value = { total_count: 1, workflow_runs: [run] };
    else if (endpoint === 'actions/runs/10') value = run;
    else if (endpoint === 'actions/runs/10/attempts/1/jobs?per_page=100') value = jobs;
    else if (endpoint === `git/commits/${mergeSha}`) value = commit;
    else if (endpoint === `git/commits/${candidate}`)
      value = { sha: candidate, tree: { sha: treeSha } };
    else {
      unexpectedEndpoints.push(endpoint);
      throw Error('Unexpected endpoint');
    }
    return structuredClone(value);
  };
  return {
    spec,
    candidate,
    mergeSha,
    pr,
    run,
    jobs,
    commit,
    calls,
    unexpectedEndpoints,
    request,
    merge: () => {
      merged = true;
      pr.state = 'closed';
      pr.merged = true;
      pr.merge_commit_sha = mergeSha;
    },
  };
}
