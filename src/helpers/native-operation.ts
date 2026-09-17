import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { pageCards } from './workboard-page.js';
import {
  assertNoNativeCardLinks,
  controllerKey,
  projectIdentity,
  currentAttempt,
  handoffHeld,
  handoffMarker,
  reconciledAttempts,
} from './record-contracts.js';
import { githubEvidence, hostedCandidate, hostedSpec } from './github-evidence.js';
import { handoffCard, settledWorkers, assertCommentCapacity } from './handoff-card.js';
import {
  assertCanonicalReviewCard,
  ensureCreatedCard,
  sealCreationPayload,
} from './create-card.js';
import { topology, workerProfile } from '../topology.js';

const uuid = (value) =>
  typeof value === 'string' &&
  value.length === 36 &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const sha = (value) =>
  typeof value === 'string' && value.length === 40 && /^[0-9a-f]{40}$/.test(value);
const text = (value, max) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const type = (c, name) =>
  typeof c.notes === 'string' &&
  (c.notes.match(/^Type:/gim) ?? []).length === 1 &&
  new RegExp(`^Type: ${name}$`, 'mi').test(c.notes);
const field = (notes, name) => {
  const values = notes.split('\n').filter((l) => l.startsWith(`${name}: `));
  assert.equal(values.length, 1, `Expected one ${name} field`);
  return values[0].slice(name.length + 2);
};
function owned(c, claimed) {
  const { engineeringAgentId } = topology();
  assert(
    c && c.agentId === engineeringAgentId && !c.metadata?.archivedAt,
    'Wrong owner or archived card',
  );
  assert(
    !c.execution && !c.sessionKey && !c.runId && !c.taskId,
    'Unexpected native execution linkage',
  );
  if (claimed)
    assert(
      ['running', 'review'].includes(c.status) &&
        c.metadata?.claim?.ownerId === engineeringAgentId &&
        c.metadata.claim.expiresAt > Date.now() + 20000,
      'Live engineering manager claim required',
    );
  else assert(!c.metadata?.claim, 'Unclaimed card required');
}
function block(c, p, refs = {}) {
  const unknown = 'unresolved acceptance';
  return `<!-- current-attempt -->\nDelegated attempt: ${c.id}-a${p.attempt}\nTask name: ${p.taskName}\nProfile ID: ${p.profileId}\nModel: ${p.model}\nThinking: ${p.thinking}\nTask ID: ${refs.taskId ?? unknown}\nRun ID: ${refs.runId ?? unknown}\nChild session: ${refs.childSessionKey ?? unknown}\nWrapper task ID: ${refs.wrapperTaskId ?? unknown}\nTimeout seconds: ${p.timeoutSeconds}\nBackend: acpx\nAcceptance comment ID: ${refs.commentId ?? unknown}\n<!-- /current-attempt -->`;
}
function plan(p) {
  assert(
    Number.isInteger(p.attempt) &&
      p.attempt >= 1 &&
      p.attempt <= 999999 &&
      typeof p.taskName === 'string' &&
      p.taskName.trim() === p.taskName &&
      /^[a-z][a-z0-9_-]{0,63}$/.test(p.taskName) &&
      !['all', 'last'].includes(p.taskName),
  );
  assert(Number.isInteger(p.timeoutSeconds) && p.timeoutSeconds >= 1 && p.timeoutSeconds <= 1800);
  assert(
    sha(p.baseSha) &&
      isAbsolute(p.worktree) &&
      text(p.branch, 160) &&
      !/[\r\n]/.test(p.worktree + p.branch),
  );
}
function canonicalReviewCandidate(c, parent, cards) {
  const key = c.metadata?.automation?.idempotencyKey;
  if (
    !c.labels?.includes('review') &&
    !(typeof key === 'string' && /^work-item:[^:]+:review-/.test(key))
  )
    return null;
  const candidate = field(c.notes, 'Candidate');
  assertCanonicalReviewCard(c, parent.id, candidate, cards);
  const scope = field(c.notes, 'Scope');
  assert(
    text(scope, 1400) && scope.trim() === scope && !/[\r\n\x00-\x1f\x7f]/.test(scope),
    'Invalid canonical review Scope',
  );
  return { candidate, scope };
}
function spawnArguments(c, p, review) {
  const { workerAgentId, workerRuntime } = topology(),
    profile = p.model
      ? { id: p.profileId, model: p.model, thinking: p.thinking }
      : workerProfile(p.profileId);
  const taskPrefix = `Work item: ${c.id}\nTask name: ${p.taskName}\n${review ? `Assignment: independent-review\nCandidate: ${review.candidate}\nScope: ${review.scope}\nRead-only review: do not edit files or create commits. Do not use Workboard, send messages, push, merge, or publish.\nInspect only this exact candidate checkout and verify HEAD is ${review.candidate} before and after review.\nRun the repository checks required by Scope. Report prioritized findings with file references; report no findings explicitly when applicable.\nVerify HEAD and the working tree are unchanged before completing.\n` : ''}${p.remaining ? `Remaining assignment: ${p.remaining}\n` : ''}`;
  const spawnArgs = {
    runtime: workerRuntime,
    agentId: workerAgentId,
    mode: 'run',
    cwd: p.worktree,
    taskName: p.taskName,
    model: profile.model,
    thinking: profile.thinking,
    runTimeoutSeconds: p.timeoutSeconds,
    cleanup: 'keep',
    expectsCompletionMessage: true,
    ...(review ? { task: taskPrefix } : {}),
  };
  return {
    profile: { id: profile.id, model: profile.model, thinking: profile.thinking },
    spawnArgs,
    taskPrefix,
    ...(review
      ? {
          reviewProof: {
            status: 'passed',
            label: 'Independent review',
            notePrefix: `Candidate: ${review.candidate}`,
          },
        }
      : {}),
  };
}

function inspectReviewWorktree(info, p, review, git) {
  assert.equal(p.baseSha, review.candidate, 'Review base must equal the exact candidate');
  const checkout = field(info.notes, 'Checkout'),
    integration = field(info.notes, 'Integration branch');
  assert.notEqual(p.branch, integration, 'Review branch must be distinct from integration');
  const common = git(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const worktrees = git(checkout, ['worktree', 'list', '--porcelain']).split('\n\n');
  assert.equal(
    worktrees.filter((entry) => entry.split('\n').includes(`worktree ${p.worktree}`)).length,
    1,
    'Review worktree must be precreated and uniquely registered',
  );
  assert.equal(
    worktrees.filter((entry) => entry.split('\n').includes(`branch refs/heads/${p.branch}`)).length,
    1,
    'Review branch must be uniquely registered',
  );
  assert.equal(
    worktrees.filter(
      (entry) =>
        entry.split('\n').includes(`worktree ${p.worktree}`) &&
        entry.split('\n').includes(`branch refs/heads/${p.branch}`),
    ).length,
    1,
    'Review worktree and branch registration must match',
  );
  assert.equal(
    git(p.worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    common,
    'Review worktree belongs to another repository',
  );
  assert.equal(
    git(p.worktree, ['rev-parse', '--show-toplevel']),
    p.worktree,
    'Canonical review worktree root required',
  );
  assert.equal(
    git(p.worktree, ['symbolic-ref', '--short', 'HEAD']),
    p.branch,
    'Review branch changed',
  );
  assert.equal(
    git(p.worktree, ['rev-parse', 'HEAD']),
    review.candidate,
    'Review HEAD differs from candidate',
  );
  assert.equal(
    git(p.worktree, ['status', '--porcelain', '--untracked-files=all']),
    '',
    'Dirty review worktree',
  );
}
function acceptedReviewProof(proof, candidate) {
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (
    proof?.status !== 'passed' ||
    proof.label !== 'Independent review' ||
    typeof proof.note !== 'string' ||
    proof.note.length > 2000
  )
    return false;
  const firstLine = proof.note.split('\n', 1)[0];
  return (
    firstLine === `Candidate: ${candidate}` ||
    new RegExp(`^Candidate: ${escaped}\\. .+$`).test(firstLine)
  );
}
const withoutOneFinalLf = (value) =>
  typeof value === 'string' && value.endsWith('\n') ? value.slice(0, -1) : value;

// One bounded operation per invocation. No worker launch, publishing, messaging or separate ledger.
export async function operate(
  operation,
  p,
  rpc,
  git = (cwd, args) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000 }).trim(),
  githubRequest,
) {
  const { productAgentId, engineeringAgentId, workerAgentId, workerRuntime } = topology();
  if (operation.startsWith('handoff')) return handoffCard(operation, p, rpc);
  assert(p && typeof p === 'object' && !Array.isArray(p));
  const fields =
    operation === 'prepare'
      ? [
          'boardId',
          'id',
          'attempt',
          'taskName',
          'profileId',
          'timeoutSeconds',
          'baseSha',
          'worktree',
          'branch',
          'replaces',
          'inspectedHead',
          'remaining',
          'reconciliation',
        ]
      : operation === 'record'
        ? [
            'boardId',
            'id',
            'runId',
            'childSessionKey',
            'taskId',
            'wrapperTaskId',
            'attempt',
            'taskName',
            'timeoutSeconds',
            'baseSha',
            'worktree',
            'branch',
          ]
        : ['boardId', 'id', 'sha', 'reviewId', 'summary', 'hosted'];
  assert(
    Object.keys(p).every((k) => fields.includes(k)),
    'Unknown operation input',
  );
  if (Object.hasOwn(p, 'hosted'))
    assert(
      p.hosted && typeof p.hosted === 'object' && !Array.isArray(p.hosted),
      'Invalid hosted input',
    );
  assert(['prepare', 'record', 'publish-gate', 'gate', 'finish'].includes(operation));
  assert(operation !== 'publish-gate' || p.hosted, 'Upload gate requires hosted input');
  assert(
    uuid(p.id) &&
      typeof p.boardId === 'string' &&
      p.boardId.trim() === p.boardId &&
      /^[a-zA-Z0-9:_-]{1,160}$/.test(p.boardId) &&
      p.boardId !== 'default',
    'Invalid scope',
  );
  const read = async () => {
    const response = await rpc('workboard.cards.list', { boardId: p.boardId });
    pageCards(response, { boardId: p.boardId, includeArchived: true });
    const info = response.cards.filter(
      (c) =>
        /^project-info:/.test(c.metadata?.automation?.idempotencyKey ?? '') ||
        /^Type: project-info\b/im.test(c.notes ?? '') ||
        c.labels?.includes('type:project-info') ||
        (c.metadata?.automation?.tenant === `project:${p.boardId}` && !type(c, 'feature')),
    );
    assert.equal(info.length, 1, 'Project information must be unique');
    const i = info[0];
    const card = response.cards.find((c) => c.id === p.id);
    assert(card, 'Card missing');
    const projectId = projectIdentity(response.cards, card);
    if (projectId && ['prepare', 'publish-gate', 'gate'].includes(operation)) {
      const featureId = /^Type: feature$/m.test(card.notes)
        ? card.id
        : card.metadata?.automation?.tenant;
      const guard = await rpc('jarvis-gilfoyle.projects.guard', { projectId, featureId });
      assert(guard.active === true, 'Project is inactive or deliberately pending');
    }
    assertNoNativeCardLinks(card);
    assertNoNativeCardLinks(i);
    if (operation === 'prepare') {
      const parent = response.cards.find((x) => x.id === card.metadata?.automation?.tenant);
      if (parent) assertNoNativeCardLinks(parent);
      assert(
        parent &&
          ['todo', 'ready', 'review', 'running'].includes(parent.status) &&
          !parent.labels?.includes('user-held') &&
          !/^Wait:/m.test(parent.notes) &&
          !handoffHeld(parent) &&
          !handoffHeld(card) &&
          !card.labels?.includes('user-held') &&
          !/^Wait:/m.test(card.notes),
        'Parent or target held',
      );
      assert(
        !response.cards.some(
          (x) =>
            [parent.id, card.id].includes(x.metadata?.automation?.tenant) &&
            type(x, 'action') &&
            x.status !== 'done',
        ),
        'Pending decision/stop/intervention',
      );
      const requires = field(card.notes, 'Requires Work items');
      const dependencies = requires === 'none' ? [] : requires.split(', ');
      assert(
        new Set(dependencies).size === dependencies.length &&
          dependencies.every((id) => {
            const dependency = response.cards.find((x) => x.id === id);
            return (
              uuid(id) &&
              id !== card.id &&
              dependency &&
              type(dependency, 'work[ -]item') &&
              dependency.metadata?.automation?.tenant === parent.id &&
              field(dependency.notes, 'Feature') === parent.id &&
              dependency.status === 'done' &&
              !handoffHeld(dependency) &&
              dependency.metadata?.proof?.some((x) => x.status === 'passed') &&
              (assertNoNativeCardLinks(dependency), true)
            );
          }),
        'Required predecessor unfinished or held',
      );
    }
    assert(
      type(i, 'project-info') &&
        Array.isArray(i.labels) &&
        i.labels.length === 1 &&
        i.labels[0] === 'type:project-info' &&
        i.metadata?.automation?.tenant === `project:${p.boardId}` &&
        i.status === 'todo' &&
        !i.agentId &&
        !i.metadata?.claim &&
        !i.execution &&
        !i.sessionKey &&
        !i.runId &&
        !i.taskId &&
        i.metadata.automation.idempotencyKey === `project-info:${p.boardId}`,
      'Invalid project information',
    );
    if (!(operation === 'finish' && card.status === 'done'))
      assert(!i.metadata?.archivedAt && /^Readiness: ready\b/m.test(i.notes), 'Project not ready');
    return { cards: response.cards, card, info: i };
  };
  let state = await read(),
    c = state.card;
  const MAIN = controllerKey(state.cards, c);
  const initialUpdatedAt = c.updatedAt;
  if (operation === 'prepare' || operation === 'record') {
    assert(type(c, 'work[ -]item') && uuid(c.metadata?.automation?.tenant), 'Work item required');
    const parent = state.cards.find((f) => f.id === c.metadata.automation.tenant);
    assert(
      parent &&
        type(parent, 'feature') &&
        (parent.agentId === engineeringAgentId ||
          (operation === 'record' &&
            parent.agentId === productAgentId &&
            handoffHeld(parent) &&
            !handoffMarker(parent)?.uncertain)) &&
        !parent.metadata?.archivedAt &&
        parent.status !== 'done',
      'Invalid parent',
    );
    assert.equal(field(c.notes, 'Feature'), parent.id);
    const review = canonicalReviewCandidate(c, parent, state.cards);
    let old = currentAttempt(c);
    if (
      operation === 'record' &&
      old?.uncertain &&
      c.notes.includes('Acceptance comment ID: unresolved acceptance')
    ) {
      const attempt = /^Delegated attempt: (.+)$/m.exec(c.notes)?.[1];
      assert(
        (c.metadata?.comments ?? []).filter((x) =>
          x.body?.startsWith(`Accepted delegation ${attempt}: `),
        ).length <= 1,
        'Ambiguous accepted delegation comments',
      );
      old = currentAttempt({
        ...c,
        events: [],
        metadata: {
          ...c.metadata,
          comments: (c.metadata?.comments ?? []).filter(
            (x) => !x.body?.startsWith(`Accepted delegation ${attempt}: `),
          ),
        },
      });
      assert(
        old && !old.taskId && !old.runId && !old.childSessionKey,
        'Only an unresolved prepared block may recover a partial handoff',
      );
    }
    if (operation === 'prepare') {
      owned(c, false);
      assert.equal(c.status, 'todo');
      plan(p);
      const selected = workerProfile(p.profileId);
      p = { ...p, profileId: selected.id, model: selected.model, thinking: selected.thinking };
      if (review) inspectReviewWorktree(state.info, p, review, git);
      if (p.attempt > 1) {
        assert.equal(
          p.taskName,
          `wi-${c.id}-a${p.attempt}`,
          'Replacement task name must use the unique card/attempt identity',
        );
        assert.notEqual(
          p.branch,
          field(state.info.notes, 'Integration branch'),
          'Worker cannot use the integration branch',
        );
        assert(
          p.replaces &&
            Object.keys(p.replaces).sort().join(',') ===
              'attempt,childSessionKey,commentId,runId,taskId,wrapperTaskId',
          'Exact prior attempt identity required',
        );
        assert(
          sha(p.inspectedHead) &&
            text(p.remaining, 240) &&
            text(p.reconciliation, 500) &&
            !/[\r\n]/.test(p.remaining + p.reconciliation) &&
            p.reconciliation.includes(p.inspectedHead) &&
            p.reconciliation.includes(p.remaining) &&
            p.reconciliation.length > p.inspectedHead.length + p.remaining.length + 12,
          'Inspected surviving HEAD and meaningful remaining-scope reconciliation required',
        );
        assert(old && !old.uncertain, 'Prior attempt must reconcile');
        const archives = reconciledAttempts(c);
        const existing = archives.find((a) => a.next.attempt === p.attempt);
        const next = Object.fromEntries(
          [
            'attempt',
            'taskName',
            'profileId',
            'model',
            'thinking',
            'timeoutSeconds',
            'baseSha',
            'worktree',
            'branch',
            'replaces',
            'inspectedHead',
            'remaining',
            'reconciliation',
          ].map((k) => [
            k,
            k === 'replaces'
              ? Object.fromEntries(
                  [
                    'attempt',
                    'taskId',
                    'wrapperTaskId',
                    'runId',
                    'childSessionKey',
                    'commentId',
                  ].map((name) => [name, p.replaces[name]]),
                )
              : p[k],
          ]),
        );
        if (existing) assert.deepEqual(existing.next, next, 'Conflicting replacement preparation');
        const reused = old.attempt === `${c.id}-a${p.attempt}`;
        assert(
          !reused ||
            (existing && !old.taskId && !old.wrapperTaskId && !old.runId && !old.childSessionKey),
          'Current attempt already accepted or uncertain; never respawn',
        );
        const prior = reused
          ? existing.prior
          : {
              ...old,
              baseSha: field(c.notes, 'Immutable base'),
              worktree: field(c.notes, 'Worktree'),
              branch: field(c.notes, 'Branch'),
              ...(/^Remaining assignment:/m.test(c.notes)
                ? { remaining: field(c.notes, 'Remaining assignment') }
                : {}),
            };
        assert(
          prior.attempt === `${c.id}-a${p.attempt - 1}`,
          'Replacement must be exactly the subsequent attempt',
        );
        assert(
          !archives.some((a) => a.next.attempt < p.attempt) ||
            archives.some(
              (a) => a.commentId === prior.reconciliationId && a.next.attempt === p.attempt - 1,
            ),
          'Prior later attempt requires retained reconciliation lineage',
        );
        for (const k of Object.keys(p.replaces))
          assert.equal(p.replaces[k], prior[k], 'Prior immutable identity mismatch');
        assert(
          prior.taskId && prior.wrapperTaskId && prior.commentId,
          'Accepted prior attempt required',
        );
        if (existing) assert.deepEqual(existing.prior, prior, 'Prior archive changed');
        const assignments = [
          prior,
          ...archives.filter((a) => a.next.attempt !== p.attempt).flatMap((a) => [a.prior, a.next]),
          ...state.cards
            .filter((x) => x.id !== c.id)
            .map((x) => ({
              taskName: currentAttempt(x)?.taskName,
              worktree: /^Worktree: (.+)$/m.exec(x.notes ?? '')?.[1],
              branch: /^Branch: (.+)$/m.exec(x.notes ?? '')?.[1],
            })),
        ];
        assert(
          assignments.every(
            (a) => a.taskName !== p.taskName && a.worktree !== p.worktree && a.branch !== p.branch,
          ),
          'Replacement task name, branch and worktree must be new',
        );
        const priorNotes = `Type: work-item\nFeature: ${parent.id}\nImmutable base: ${prior.baseSha}\nWorktree: ${prior.worktree}\nBranch: ${prior.branch}\n${block(c, { attempt: p.attempt - 1, taskName: prior.taskName, profileId: prior.profileId, model: prior.model, thinking: prior.thinking, timeoutSeconds: prior.timeoutSeconds }, prior)}${prior.reconciliationId ? `\nAttempt reconciliation: ${prior.reconciliationId}\nRemaining assignment: ${prior.remaining}` : ''}`;
        const priorCard = { ...c, notes: priorNotes };
        const inspect = () => {
          const common = git(field(state.info.notes, 'Checkout'), [
            'rev-parse',
            '--path-format=absolute',
            '--git-common-dir',
          ]);
          const worktrees = git(field(state.info.notes, 'Checkout'), [
            'worktree',
            'list',
            '--porcelain',
          ]).split('\n\n');
          assert(
            worktrees.filter((x) => x.split('\n').includes(`branch refs/heads/${p.branch}`))
              .length === 1 &&
              worktrees.filter((x) => x.split('\n').includes(`worktree ${p.worktree}`)).length ===
                1,
            'Replacement branch/worktree must be uniquely registered',
          );
          for (const [worktree, branch, head] of [
            [prior.worktree, prior.branch, p.inspectedHead],
            [p.worktree, p.branch, p.baseSha],
          ]) {
            assert.equal(
              git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
              common,
              'Replacement worktree belongs to another repository',
            );
            assert.equal(
              git(worktree, ['rev-parse', '--show-toplevel']),
              worktree,
              'Canonical worktree root required',
            );
            assert.equal(
              git(worktree, ['symbolic-ref', '--short', 'HEAD']),
              branch,
              'Inspected branch changed',
            );
            assert.equal(
              git(worktree, ['rev-parse', 'HEAD']),
              head,
              'Inspected surviving HEAD changed',
            );
            assert.equal(
              git(worktree, ['status', '--porcelain', '--untracked-files=all']),
              '',
              'Dirty worktree must reconcile externally',
            );
          }
          git(prior.worktree, ['merge-base', '--is-ancestor', prior.baseSha, p.inspectedHead]);
          git(p.worktree, ['merge-base', '--is-ancestor', p.inspectedHead, p.baseSha]);
        };
        await settledWorkers(state.cards, [priorCard], rpc, 24);
        inspect();
        const body = `Reconciled attempt: ${JSON.stringify({ prior, next })}`;
        assert(body.length <= 2000, 'Attempt archive exceeds native comment limit');
        const preserved = c.notes.replace(/^Attempt reconciliation:.*\n?/gm, '');
        let notes = preserved.replace(
          /<!-- current-attempt -->[\s\S]*?<!-- \/current-attempt -->/,
          block(c, p),
        );
        for (const [key, value] of [
          ['Immutable base', p.baseSha],
          ['Worktree', p.worktree],
          ['Branch', p.branch],
        ])
          notes = notes.replace(new RegExp(`^${key}: .*`, 'm'), () => `${key}: ${value}`);
        notes =
          notes.replace(/^Remaining assignment:.*\n?/gm, '').trimEnd() +
          `\nRemaining assignment: ${p.remaining}\nAttempt reconciliation: ${existing?.commentId ?? p.id}`;
        const acceptedNotes = notes.replace(
          /<!-- current-attempt -->[\s\S]*?<!-- \/current-attempt -->/,
          block(c, p, {
            taskId: p.id,
            wrapperTaskId: p.id,
            runId: p.id,
            childSessionKey: `agent:${workerAgentId}:${workerRuntime}:${p.id}`,
            commentId: p.id,
          }),
        );
        assert(
          Math.max(notes.length, acceptedNotes.length) <= 4000,
          'Replacement notes exceed native acceptance capacity; preserve scope',
        );
        assert(
          (c.metadata.comments ?? []).length <= (existing ? 49 : 48),
          'Native comment capacity must retain archive and next acceptance',
        );
        const baseline = c;
        const fresh = async () => {
          const s = await read();
          owned(s.card, false);
          assert.equal(s.card.status, 'todo');
          assert.deepEqual(s.info, state.info, 'Project changed during replacement');
          assert.deepEqual(
            s.cards.find((x) => x.id === parent.id),
            parent,
            'Parent changed during replacement',
          );
          return s.card;
        };
        c = await fresh();
        assert.deepEqual(c, baseline, 'Card changed during reconciliation');
        const acceptance = `Accepted delegation ${c.id}-a${p.attempt}: ${JSON.stringify({ taskId: c.id, wrapperTaskId: c.id, runId: c.id, childSessionKey: `agent:${workerAgentId}:${workerRuntime}:${c.id}` })}`;
        const claim = {
          ownerId: engineeringAgentId,
          token: c.id,
          claimedAt: Number.MAX_SAFE_INTEGER,
          lastHeartbeatAt: Number.MAX_SAFE_INTEGER,
          expiresAt: Number.MAX_SAFE_INTEGER,
        };
        assertCommentCapacity(
          { ...c, metadata: { ...c.metadata, claim } },
          existing ? [] : [body],
          [{ body: acceptance, textLimit: 0 }],
        );
        if (!existing) {
          await rpc('workboard.cards.comment', { id: c.id, body });
        }
        c = await fresh();
        assert.equal(c.notes, baseline.notes, 'Concurrent attempt mutation');
        for (const [key, value] of Object.entries(baseline.metadata))
          if (key !== 'comments')
            assert.deepEqual(c.metadata[key], value, 'Retained metadata changed during archive');
        assert.deepEqual(c.metadata.proof, baseline.metadata.proof);
        assert.equal(c.metadata.failureCount, baseline.metadata.failureCount);
        assert(
          (baseline.metadata.comments ?? []).every((old) =>
            c.metadata.comments?.some((x) => JSON.stringify(x) === JSON.stringify(old)),
          ),
          'Prior receipts were lost',
        );
        const receipts = c.metadata.comments.filter((x) => x.body === body);
        assert.equal(receipts.length, 1, 'Ambiguous archive comment');
        assert(uuid(receipts[0].id));
        notes = notes.replace(
          /^Attempt reconciliation: .*$/m,
          `Attempt reconciliation: ${receipts[0].id}`,
        );
        await settledWorkers(state.cards, [{ ...priorCard, metadata: c.metadata }], rpc, 24);
        inspect();
        const checked = await fresh();
        assert.deepEqual(checked, c, 'Card changed before replacement CAS');
        if (notes !== c.notes)
          await rpc('workboard.cards.update', {
            id: c.id,
            expectedUpdatedAt: c.updatedAt,
            patch: { notes },
          });
        const result = await fresh();
        assert.equal(result.notes, notes);
        inspect();
        assert.deepEqual(result.metadata.automation, baseline.metadata.automation);
        assert.deepEqual(result.metadata.proof, baseline.metadata.proof);
        assert.equal(result.metadata.failureCount, baseline.metadata.failureCount);
        for (const [key, value] of Object.entries(baseline.metadata))
          if (key !== 'comments')
            assert.deepEqual(result.metadata[key], value, 'Retained metadata evidence changed');
        assert(
          (baseline.metadata.comments ?? []).every((old) =>
            result.metadata.comments?.some((x) => JSON.stringify(x) === JSON.stringify(old)),
          ),
          'Retained comment history changed',
        );
        const prepared = currentAttempt(result);
        assert(
          prepared &&
            !prepared.uncertain &&
            prepared.attempt === `${c.id}-a${p.attempt}` &&
            !prepared.taskId,
          'Replacement preparation not confirmed',
        );
        return {
          id: c.id,
          status: 'prepared',
          attempt: prepared.attempt,
          reused,
          executionAccepted: false,
          ...spawnArguments(c, p, review),
        };
      }
      assert(
        !['replaces', 'inspectedHead', 'remaining', 'reconciliation'].some((k) =>
          Object.hasOwn(p, k),
        ),
        'Attempt 1 cannot replace an earlier attempt',
      );
      if (old) {
        assert(
          !old.uncertain &&
            old.attempt === `${c.id}-a1` &&
            old.taskName === p.taskName &&
            old.profileId === p.profileId &&
            old.model === p.model &&
            old.thinking === p.thinking &&
            old.timeoutSeconds === p.timeoutSeconds &&
            !old.taskId &&
            !old.runId &&
            !old.childSessionKey,
          'Existing attempt must reconcile',
        );
        assert.equal(field(c.notes, 'Immutable base'), p.baseSha);
        assert.equal(field(c.notes, 'Worktree'), p.worktree);
        assert.equal(field(c.notes, 'Branch'), p.branch);
        return { id: c.id, status: 'prepared', reused: true, ...spawnArguments(c, p, review) };
      }
      assert(
        !/^Immutable base:|^Worktree:|^Branch:/m.test(c.notes),
        'Do not overwrite preexisting assignment fields',
      );
      const notes = `${c.notes.trimEnd()}\nImmutable base: ${p.baseSha}\nWorktree: ${p.worktree}\nBranch: ${p.branch}\n${block(c, p)}`;
      await rpc('workboard.cards.update', {
        id: c.id,
        expectedUpdatedAt: c.updatedAt,
        patch: { notes },
      });
      const result = (await read()).card;
      owned(result, false);
      assert.equal(result.notes, notes);
      return {
        id: c.id,
        status: 'prepared',
        attempt: `${c.id}-a1`,
        ...spawnArguments(c, p, review),
      };
    }
    assert(
      uuid(p.runId) &&
        p.childSessionKey ===
          `agent:${workerAgentId}:${workerRuntime}:${p.childSessionKey.split(':').at(-1)}` &&
        uuid(p.childSessionKey.split(':').at(-1)),
    );
    assert(c.notes.includes('<!-- current-attempt -->'), 'Prepared current attempt required');
    assert(old && !old.uncertain, 'Prepared current attempt required');
    if (p.attempt !== undefined)
      assert.equal(old.attempt, `${c.id}-a${p.attempt}`, 'Prepared attempt number mismatch');
    assert(
      !reconciledAttempts(c).some(
        (a) =>
          a.prior.attempt !== old.attempt &&
          (a.prior.runId === p.runId || a.prior.childSessionKey === p.childSessionKey),
      ),
      'Prior execution cannot become the new attempt',
    );
    for (const name of ['runId', 'childSessionKey', 'taskId', 'wrapperTaskId'])
      if (old[name]) assert.equal(p[name] ?? old[name], old[name], 'Immutable reference mismatch');
    const reviewBlockedWithoutHold = (card, cards = state.cards) => {
      const currentParent = cards.find((item) => item.id === card.metadata?.automation?.tenant);
      return (
        review &&
        currentParent &&
        card.status === 'blocked' &&
        card.agentId === engineeringAgentId &&
        !card.metadata?.claim &&
        !card.execution &&
        !card.sessionKey &&
        !card.runId &&
        !card.taskId &&
        !handoffMarker(card) &&
        !card.labels?.includes('user-held') &&
        !/^Wait:/m.test(card.notes) &&
        !handoffMarker(currentParent) &&
        !currentParent.labels?.includes('user-held') &&
        !/^Wait:/m.test(currentParent.notes) &&
        !cards.some(
          (x) =>
            [currentParent.id, card.id].includes(x.metadata?.automation?.tenant) &&
            type(x, 'action') &&
            x.status !== 'done',
        )
      );
    };
    const blockedReviewRecovery =
      reviewBlockedWithoutHold(c) &&
      !old.taskId &&
      !old.wrapperTaskId &&
      !old.runId &&
      !old.childSessionKey;
    if (blockedReviewRecovery)
      assert(
        uuid(p.taskId) && uuid(p.wrapperTaskId),
        'Blocked review recovery requires exact native task IDs',
      );
    let tasks;
    const taskId = p.taskId ?? old.taskId,
      wrapperTaskId = p.wrapperTaskId ?? old.wrapperTaskId;
    if (taskId && wrapperTaskId) {
      assert(uuid(taskId) && uuid(wrapperTaskId));
      tasks = await Promise.all(
        [taskId, wrapperTaskId].map(async (taskId) => (await rpc('tasks.get', { taskId })).task),
      );
    } else {
      const list = await rpc('tasks.list', { sessionKey: MAIN, limit: 100 });
      assert(
        Array.isArray(list.tasks) &&
          (!list.nextCursor || list.tasks.at(-1)?.updatedAt < c.createdAt),
        'Task discovery window incomplete; use exact IDs',
      );
      tasks = list.tasks.filter(
        (t) => t.runId === p.runId && t.childSessionKey === p.childSessionKey,
      );
    }
    const matches = (runtime) =>
      tasks.filter(
        (t) =>
          t?.runtime === runtime &&
          t.agentId === workerAgentId &&
          t.runId === p.runId &&
          t.childSessionKey === p.childSessionKey &&
          t.sessionKey === MAIN &&
          t.ownerKey === MAIN,
      );
    assert.equal(matches(workerRuntime).length, 1);
    assert.equal(matches('subagent').length, 1);
    const refs = {
      taskId: matches(workerRuntime)[0].taskId,
      wrapperTaskId: matches('subagent')[0].taskId,
      runId: p.runId,
      childSessionKey: p.childSessionKey,
    };
    assert(uuid(refs.taskId) && uuid(refs.wrapperTaskId) && refs.taskId !== refs.wrapperTaskId);
    if (p.taskId) assert.equal(p.taskId, refs.taskId, 'Explicit task ID mismatch');
    if (p.wrapperTaskId)
      assert.equal(p.wrapperTaskId, refs.wrapperTaskId, 'Explicit wrapper ID mismatch');
    const backing = (await rpc('tasks.get', { taskId: refs.taskId })).task;
    let wrapper;
    if (review) {
      wrapper = (await rpc('tasks.get', { taskId: refs.wrapperTaskId })).task;
      for (const [task, runtime, taskId] of [
        [backing, workerRuntime, refs.taskId],
        [wrapper, 'subagent', refs.wrapperTaskId],
      ]) {
        assert(
          task?.taskId === taskId &&
            task.runtime === runtime &&
            task.agentId === workerAgentId &&
            task.runId === p.runId &&
            task.childSessionKey === p.childSessionKey &&
            task.sessionKey === MAIN &&
            task.ownerKey === MAIN,
          'Native review task identity required',
        );
      }
      const expected = spawnArguments(
        c,
        {
          ...p,
          taskName: old.taskName,
          profileId: old.profileId,
          model: old.model,
          thinking: old.thinking,
          remaining: old.reconciliationId ? field(c.notes, 'Remaining assignment') : undefined,
        },
        review,
      ).spawnArgs.task;
      assert.equal(
        withoutOneFinalLf(wrapper.prompt),
        withoutOneFinalLf(expected),
        'Native wrapper prompt must equal the canonical independent review task',
      );
    }
    let prompt = backing?.prompt ?? '';
    if (
      !prompt.includes(old.taskName) ||
      (old.reconciliationId && !prompt.includes(field(c.notes, 'Remaining assignment')))
    )
      prompt +=
        (wrapper ?? (await rpc('tasks.get', { taskId: refs.wrapperTaskId })).task)?.prompt ?? '';
    assert(
      prompt.includes(c.id) && prompt.includes(old.taskName),
      'Native worker prompt does not bind this Work item/task name',
    );
    if (old.reconciliationId)
      assert(
        prompt.includes(field(c.notes, 'Remaining assignment')),
        'Native worker prompt must bind the remaining assignment',
      );
    assert(
      !state.cards.some((x) => x.id !== c.id && currentAttempt(x)?.runId === p.runId),
      'Execution already belongs to another card',
    );
    const blockedReviewEvidence = blockedReviewRecovery
      ? {
          proof: c.metadata.proof,
          failureCount: c.metadata.failureCount,
          automation: c.metadata.automation,
        }
      : null;
    if (blockedReviewRecovery) {
      const terminal = new Set([
        'completed',
        'succeeded',
        'failed',
        'lost',
        'timed_out',
        'cancelled',
      ]);
      assert(
        [backing, wrapper].every(
          (task) =>
            terminal.has(task.status) &&
            Number.isFinite(task.createdAt) &&
            Number.isFinite(task.endedAt) &&
            task.endedAt >= task.createdAt,
        ),
        'Blocked review recovery requires terminal native tasks',
      );
      const sessions = await rpc('sessions.list', {
        agentId: workerAgentId,
        limit: 100,
        archived: 'all',
      });
      const matches = Array.isArray(sessions.sessions)
        ? sessions.sessions.filter((session) => session.key === p.childSessionKey)
        : [];
      assert(
        !sessions.hasMore &&
          matches.length === 1 &&
          matches[0].hasActiveRun === false &&
          [false, undefined].includes(matches[0].hasActiveSubagentRun) &&
          (!matches[0].lastRunId || matches[0].lastRunId === p.runId),
        'Blocked review recovery requires an inactive exact session',
      );
    }
    if (old.taskId) {
      assert.equal(old.taskId, refs.taskId);
      assert.equal(old.wrapperTaskId, refs.wrapperTaskId);
      if (handoffHeld(c)) {
        const h = handoffMarker(c);
        assert(
          !h.uncertain &&
            c.status === 'blocked' &&
            !c.metadata?.claim &&
            c.agentId === (h.phase === 'answer-ready' ? engineeringAgentId : productAgentId),
          'Invalid held reconciliation',
        );
        return {
          id: c.id,
          status: 'reconciled',
          ...refs,
          reused: true,
          executionAuthorized: false,
        };
      }
      if (reviewBlockedWithoutHold(c))
        return {
          id: c.id,
          status: 'reconciled',
          ...refs,
          reused: true,
          executionAuthorized: false,
        };
      owned(c, false);
      assert(['todo', 'done', 'review'].includes(c.status));
      return { id: c.id, status: 'delegated', ...refs, reused: true };
    }
    const body = `Accepted delegation ${old.attempt}: ${JSON.stringify(refs)}`;
    let receipts = (c.metadata?.comments ?? []).filter((r) =>
      r.body?.startsWith(`Accepted delegation ${old.attempt}: `),
    );
    assert(
      receipts.length <= 1 && (!receipts.length || receipts[0].body === body),
      'Ambiguous accepted delegation comments',
    );
    let receipt = receipts[0];
    if (!receipt) {
      if (!blockedReviewRecovery) owned(c, true);
      assertCommentCapacity(c, [body]);
      await rpc('workboard.cards.comment', { id: c.id, body });
      c = (await read()).card;
      receipts = (c.metadata?.comments ?? []).filter((r) =>
        r.body?.startsWith(`Accepted delegation ${old.attempt}: `),
      );
      assert(
        receipts.length === 1 && receipts[0].body === body,
        'Ambiguous accepted delegation comments',
      );
      receipt = receipts[0];
    }
    if (c.metadata?.claim) {
      owned(c, true);
      await rpc('workboard.cards.release', {
        id: c.id,
        ownerId: engineeringAgentId,
        status: 'todo',
      });
    }
    const afterAcceptance = await read();
    c = afterAcceptance.card;
    if (blockedReviewRecovery) {
      assert(
        reviewBlockedWithoutHold(c, afterAcceptance.cards),
        'Blocked review recovery state changed',
      );
      assert.deepEqual(
        {
          proof: c.metadata.proof,
          failureCount: c.metadata.failureCount,
          automation: c.metadata.automation,
        },
        blockedReviewEvidence,
        'Blocked review failure evidence changed',
      );
    } else {
      owned(c, false);
      assert(c.status === 'todo');
    }
    const replacement = block(
      c,
      {
        attempt: Number(old.attempt.split('-a').at(-1)),
        taskName: old.taskName,
        profileId: old.profileId,
        model: old.model,
        thinking: old.thinking,
        timeoutSeconds: old.timeoutSeconds,
      },
      { ...refs, commentId: receipt.id },
    );
    const notes = c.notes.replace(
      /<!-- current-attempt -->[\s\S]*?<!-- \/current-attempt -->/,
      replacement,
    );
    await rpc('workboard.cards.update', {
      id: c.id,
      expectedUpdatedAt: c.updatedAt,
      patch: { notes },
    });
    const afterUpdate = await read(),
      result = afterUpdate.card;
    if (blockedReviewRecovery) {
      assert(
        reviewBlockedWithoutHold(result, afterUpdate.cards),
        'Blocked review recovery state changed',
      );
      assert.deepEqual(
        {
          proof: result.metadata.proof,
          failureCount: result.metadata.failureCount,
          automation: result.metadata.automation,
        },
        blockedReviewEvidence,
        'Blocked review failure evidence changed',
      );
    } else owned(result, false);
    assert.equal(result.notes, notes);
    assert.equal(currentAttempt(result)?.taskId, refs.taskId);
    return {
      id: c.id,
      status: blockedReviewRecovery ? 'reconciled' : 'delegated',
      ...refs,
      ...(blockedReviewRecovery ? { executionAuthorized: false } : {}),
    };
  }

  assert(
    sha(p.sha) && uuid(p.reviewId) && text(p.summary, 1400) && !/[\r\n]/.test(p.summary),
    'Single-line bounded summary and immutable review IDs required',
  );
  assert(
    type(c, 'feature') &&
      c.agentId === engineeringAgentId &&
      (!c.metadata?.archivedAt || c.status === 'done'),
    'Feature required',
  );
  const deliveryLines = c.notes.split('\n').filter((l) => l.startsWith('Delivery: '));
  assert(deliveryLines.length <= 1, 'Ambiguous delivery context');
  const delivery = deliveryLines.length
    ? field(c.notes, 'Delivery')
    : 'Default owner route through Jarvis; preserve current project protocol';
  assert(text(delivery, 500), 'Invalid delivery context');
  const key = `action:${c.id}:owner-notification`;
  const validate = (state) => {
    const f = state.card;
    assertNoNativeCardLinks(f);
    assert(
      !handoffHeld(f) &&
        !f.labels?.includes('user-held') &&
        (f.status === 'done' || f.status !== 'blocked') &&
        !/^Wait: (?!hosted-ci$)/m.test(f.notes),
      'Unresolved parent handoff/hold',
    );
    const children = state.cards.filter((x) => x.metadata?.automation?.tenant === f.id);
    assert(
      children.every(
        (x) =>
          x.metadata?.automation?.boardId === p.boardId &&
          (type(x, 'work[ -]item') || type(x, 'action')),
      ),
      'Malformed Feature child',
    );
    children.forEach(assertNoNativeCardLinks);
    const workPrefix = `work-item:${f.id}:`;
    const relevantItems = state.cards.filter((x) => {
      const automation = x.metadata?.automation,
        featureLines = (x.notes ?? '').split('\n').filter((line) => line.startsWith('Feature: '));
      const related =
        automation?.tenant === f.id ||
        automation?.idempotencyKey?.startsWith(workPrefix) ||
        featureLines.includes(`Feature: ${f.id}`);
      return (
        related && !type(x, 'action') && !automation?.idempotencyKey?.startsWith(`action:${f.id}:`)
      );
    });
    assert(
      relevantItems.every((x) => {
        const featureLines = (x.notes ?? '')
          .split('\n')
          .filter((line) => line.startsWith('Feature: '));
        return (
          type(x, 'work[ -]item') &&
          x.metadata?.automation?.boardId === p.boardId &&
          x.metadata.automation.tenant === f.id &&
          typeof x.metadata.automation.idempotencyKey === 'string' &&
          x.metadata.automation.idempotencyKey.startsWith(workPrefix) &&
          featureLines.length === 1 &&
          featureLines[0] === `Feature: ${f.id}`
        );
      }),
      'Malformed Feature Work item',
    );
    relevantItems.forEach(assertNoNativeCardLinks);
    const actionPrefix = `action:${f.id}:`;
    const actions = state.cards.filter(
      (x) =>
        type(x, 'action') &&
        (x.metadata?.automation?.tenant === f.id ||
          x.metadata?.automation?.idempotencyKey?.startsWith(actionPrefix) ||
          (x.notes ?? '').split('\n').includes(`Feature: ${f.id}`)),
    );
    assert(
      actions.every((x) => {
        const featureLines = (x.notes ?? '')
          .split('\n')
          .filter((line) => line.startsWith('Feature: '));
        const actionKey = x.metadata?.automation?.idempotencyKey,
          creation = (x.notes ?? '').match(/^Creation: sha256:[0-9a-f]{64}$/gm) ?? [];
        const canonicalNotice =
          actionKey === key &&
          /^Kind: owner-notification$/m.test(x.notes ?? '') &&
          x.labels?.includes('owner-notification');
        const canonicalStop =
          actionKey === `action:${f.id}:cancellation:stop` &&
          /^Kind: cancellation$/m.test(x.notes ?? '') &&
          x.labels?.includes('stop');
        const intervention =
          /^action:[0-9a-f-]{36}:intervention:(cancellation-uncertain|communication-urgent)$/.exec(
            actionKey ?? '',
          );
        const canonicalIntervention =
          intervention &&
          /^Kind: exceptional-intervention$/m.test(x.notes ?? '') &&
          new RegExp(`^Intervention: ${intervention[1]}$`, 'm').test(x.notes ?? '') &&
          x.labels?.includes('exceptional-intervention');
        return (
          x.metadata?.automation?.boardId === p.boardId &&
          x.metadata.automation.tenant === f.id &&
          featureLines.length === 1 &&
          featureLines[0] === `Feature: ${f.id}` &&
          creation.length === 1 &&
          (canonicalNotice || canonicalStop || canonicalIntervention)
        );
      }),
      'Malformed Feature Action',
    );
    actions.forEach(assertNoNativeCardLinks);
    const items = relevantItems.filter((x) => !/^Optional: true$/m.test(x.notes ?? ''));
    assert(
      items.every((x) => !handoffHeld(x)),
      'Unresolved required-child handoff',
    );
    assert(
      items.length > 0 &&
        items.every(
          (x) =>
            x.agentId === engineeringAgentId &&
            field(x.notes, 'Feature') === f.id &&
            x.status === 'done' &&
            !x.metadata?.claim &&
            (x.metadata?.proof?.some((p) => p.status === 'passed') ||
              (x.labels?.includes('review') &&
                x.metadata?.proof?.some((p) => p.status === 'failed'))),
        ),
      'Required work unfinished, mismatched or unproved',
    );
    assert(
      actions
        .filter((x) => x.metadata.automation.idempotencyKey !== key)
        .every((x) => x.status === 'done'),
      'Pending decision/stop/intervention',
    );
    const review = items.find((x) => x.id === p.reviewId);
    assert(
      review &&
        field(review.notes, 'Candidate') === p.sha &&
        review.metadata?.proof?.some((x) => acceptedReviewProof(x, p.sha)),
      'SHA-bound passed review required',
    );
    assertCanonicalReviewCard(review, f.id, p.sha, state.cards);
    assert(
      items.some(
        (x) => x.id !== review.id && field(x.notes, 'Assignment') !== 'independent-review',
      ),
      'Independent review must be separate from implementation',
    );
    if (p.hosted) {
      assert(
        field(review.notes, 'Assignment') === 'independent-review' &&
          field(review.notes, 'Candidate') === p.sha &&
          field(review.notes, 'Immutable base') === p.sha &&
          review.metadata.proof.some((x) => acceptedReviewProof(x, p.sha)),
        'Exact independent review required',
      );
      const a = currentAttempt(review);
      const implementations = items.filter(
        (x) => x.id !== review.id && field(x.notes, 'Assignment') !== 'independent-review',
      );
      assert(
        a &&
          !a.uncertain &&
          implementations.length > 0 &&
          implementations.every((x) => {
            const other = currentAttempt(x);
            return (
              other &&
              !other.uncertain &&
              other.runId !== a.runId &&
              other.childSessionKey !== a.childSessionKey &&
              other.taskId !== a.taskId &&
              other.wrapperTaskId !== a.wrapperTaskId &&
              field(x.notes, 'Worktree') !== field(review.notes, 'Worktree')
            );
          }),
        'Distinct independent review execution required',
      );
    }
    return children;
  };
  let children = validate(state);
  const items = children.filter(
    (x) => type(x, 'work[ -]item') && !/^Optional: true$/m.test(x.notes ?? ''),
  );
  if (c.status !== 'done') {
    const live = await rpc('sessions.list', {
      agentId: workerAgentId,
      limit: 100,
      archived: 'all',
    });
    assert(Array.isArray(live.sessions) && !live.hasMore, 'Worker liveness enumeration incomplete');
    await Promise.all(
      items.map(async (item) => {
        const a = currentAttempt(item);
        assert(
          a && !a.uncertain && a.taskId && a.wrapperTaskId && a.runId && a.childSessionKey,
          'Required worker references incomplete',
        );
        const session = live.sessions.find((s) => s.key === a.childSessionKey);
        assert(
          session &&
            session.hasActiveRun === false &&
            session.hasActiveSubagentRun !== true &&
            (!session.lastRunId || session.lastRunId === a.runId),
          'Worker live state is not settled',
        );
        let taskPrompt = '';
        for (const taskId of [a.taskId, a.wrapperTaskId]) {
          const t = (await rpc('tasks.get', { taskId })).task;
          assert(
            t &&
              t.runId === a.runId &&
              t.childSessionKey === a.childSessionKey &&
              t.ownerKey === MAIN &&
              t.sessionKey === MAIN &&
              ['completed', 'succeeded', 'failed', 'lost', 'timed_out', 'cancelled'].includes(
                t.status,
              ) &&
              Number.isFinite(t.endedAt),
            'Required worker not reconciled terminal',
          );
          if (p.hosted) {
            assert(
              t.runtime === (taskId === a.taskId ? workerRuntime : 'subagent') &&
                t.agentId === workerAgentId,
              'Native worker task identity required',
            );
            taskPrompt += typeof t.prompt === 'string' ? t.prompt : '';
            if (item.id === p.reviewId)
              assert(
                ['completed', 'succeeded'].includes(t.status),
                'Successful independent review required',
              );
          }
        }
        if (p.hosted)
          assert(
            taskPrompt.includes(item.id) &&
              taskPrompt.includes(a.taskName) &&
              (item.id !== p.reviewId ||
                (taskPrompt.includes(p.sha) && taskPrompt.includes('independent-review'))),
            'Native independent review assignment required',
          );
      }),
    );
  }
  const checkout = field(state.info.notes, 'Checkout'),
    repository = field(state.info.notes, 'Repository'),
    branch = field(state.info.notes, 'Integration branch');
  assert(isAbsolute(checkout) && /^[a-zA-Z0-9/_-]+$/.test(branch) && !branch.startsWith('-'));
  const remote = new URL(repository);
  const hosted = p.hosted
    ? hostedSpec(
        repository,
        branch,
        JSON.parse(field(state.info.notes, 'Required CI')),
        p.hosted,
        operation,
      )
    : null;
  if (hosted)
    assert(
      checkout.length <= 4096 &&
        !/[\x00-\x1f\x7f]/.test(checkout) &&
        !state.info.execution &&
        !state.info.sessionKey &&
        !state.info.runId &&
        !state.info.taskId,
      'Invalid hosted project context',
    );
  assert(
    hosted || (remote.protocol === 'file:' && !remote.hostname && !remote.search && !remote.hash),
    'Selected backend requires matching hosted input',
  );
  assert.equal(git(checkout, ['remote', 'get-url', '--all', 'origin']), repository);
  assert.equal(git(checkout, ['remote', 'get-url', '--push', '--all', 'origin']), repository);
  assert.equal(git(checkout, ['rev-parse', '--show-toplevel']), checkout);
  assert.equal(git(checkout, ['symbolic-ref', '--short', 'HEAD']), branch);
  const localSha = git(checkout, ['rev-parse', 'HEAD']);
  if (c.status !== 'done')
    assert.equal(localSha, p.sha, 'Prepared HEAD differs from reviewed candidate');
  assert.equal(git(checkout, ['status', '--porcelain']), '', 'Dirty publication checkout');
  let hostedResult;
  if (hosted) {
    assert(
      !c.labels?.includes('user-held') &&
        (c.notes.match(/^Wait:/gm) ?? []).length <= 1 &&
        !/^Wait: (?!hosted-ci$)/m.test(c.notes),
      'Unresolved hosted publication wait',
    );
    const snapshot = (s) =>
      JSON.stringify([
        s.info,
        s.card,
        s.cards
          .filter(
            (x) =>
              x.metadata?.automation?.tenant === p.id &&
              x.metadata?.automation?.idempotencyKey !== key,
          )
          .sort((a, b) => a.id.localeCompare(b.id)),
      ]);
    const baseline = snapshot(state);
    const fresh = async () => {
      state = await read();
      c = state.card;
      children = validate(state);
      assert.equal(snapshot(state), baseline, 'Native scope changed during hosted validation');
      if (c.status !== 'done') owned(c, true);
    };
    const receiptKey = `Hosted gate: `;
    const receipts = c.notes.split('\n').filter((l) => l.startsWith(receiptKey));
    assert(
      c.notes.length <= 4000 &&
        receipts.length <= 1 &&
        receipts.length === (c.notes.match(/^Hosted gate:/gm) ?? []).length,
      'Invalid hosted gate receipt',
    );
    const binding = hostedCandidate(
      {
        repo: hosted.repo,
        branch,
        headRef: hosted.headRef,
        baseSha: hosted.baseSha,
        sha: p.sha,
        reviewId: p.reviewId,
        summary: p.summary,
        prNumber: hosted.prNumber,
        workflows: hosted.workflows,
      },
      operation,
    );
    const digest = createHash('sha256')
      .update(JSON.stringify([p.boardId, p.id, binding]))
      .digest('hex');
    const candidateLine = `Hosted candidate: ${JSON.stringify(binding)}`;
    assert(
      (c.notes.match(/^Hosted candidate:/gm) ?? []).length <= 1,
      'Invalid hosted candidate checkpoint',
    );
    const preserved = c.notes
      .replace(
        /^(?:Hosted candidate:.*|Hosted gate:.*|Wait: hosted-ci|CI observed at:.*|CI recheck at:.*)\n?/gm,
        '',
      )
      .trimEnd();
    if (operation !== 'finish') {
      // Reserve all later checkpoint phases before upload, including a not-yet-known PR/run/attempt.
      const maximum = Number.MAX_SAFE_INTEGER;
      const reservedCandidate = `Hosted candidate: ${JSON.stringify({ ...binding, prNumber: maximum })}`;
      const reservedReceipt = `${receiptKey}${JSON.stringify({ binding: digest, runs: hosted.workflows.map(() => [maximum, maximum]) })}`;
      const waitLength = 'Wait: hosted-ci\nCI observed at: \nCI recheck at: '.length + 48;
      assert(
        preserved.length +
          1 +
          reservedCandidate.length +
          1 +
          Math.max(reservedReceipt.length, waitLength) <=
          4000,
        'Hosted checkpoint capacity exceeds native 4000-character notes limit; preserve scope and reconcile before upload',
      );
    }
    if (operation === 'finish') {
      assert.equal(receipts.length, 1, 'Retained successful hosted gate required');
      assert.deepEqual(
        hostedCandidate(JSON.parse(field(c.notes, 'Hosted candidate'))),
        binding,
        'Hosted receipt candidate mismatch',
      );
      const receipt = JSON.parse(receipts[0].slice(receiptKey.length));
      assert.equal(receipt.binding, digest, 'Hosted receipt candidate mismatch');
      assert(
        Object.keys(receipt).sort().join(',') === 'binding,runs' &&
          Array.isArray(receipt.runs) &&
          receipt.runs.length === hosted.workflows.length,
        'Invalid hosted receipt',
      );
      assert(
        receipt.runs.every(
          (r) =>
            Array.isArray(r) && r.length === 2 && r.every((n) => Number.isSafeInteger(n) && n > 0),
        ),
        'Invalid retained workflow identity',
      );
      assert(
        new Set(receipt.runs.map((r) => r[0])).size === hosted.workflows.length,
        'Duplicate hosted workflow run',
      );
    }
    git(checkout, ['merge-base', '--is-ancestor', hosted.baseSha, p.sha]);
    hostedResult = await githubEvidence(hosted, p.sha, operation, githubRequest);
    await fresh();
    if (operation !== 'finish') {
      assert(c.status !== 'done', 'Cannot republish a completed Feature');
      let notes = `${preserved}\n${candidateLine}`;
      if (operation === 'publish-gate') {
        assert(!/^Wait:/m.test(c.notes), 'Resolve prior wait before upload');
      } else if (hostedResult.status === 'ci-wait') {
        const now = Date.now();
        notes += `\nWait: hosted-ci\nCI observed at: ${new Date(now).toISOString()}\nCI recheck at: ${new Date(now + 30 * 60 * 1000).toISOString()}`;
      } else {
        const receipt = `${receiptKey}${JSON.stringify({ binding: digest, runs: hostedResult.runs.map((r) => [r.id, r.attempt]) })}`;
        notes += `\n${receipt}`;
      }
      assert(notes.length <= 4000, 'Hosted checkpoint exceeds native notes limit');
      if (notes !== c.notes) {
        const updated = (
          await rpc('workboard.cards.update', {
            id: c.id,
            expectedUpdatedAt: c.updatedAt,
            patch: { notes },
          })
        ).card;
        assert(
          updated?.id === c.id && updated.notes === notes,
          'Hosted checkpoint write not confirmed',
        );
        // Native CAS may add its own audit fields; compare reread to the actual mutation receipt.
        const expected = { ...state, card: updated };
        state = await read();
        c = state.card;
        children = validate(state);
        owned(c, true);
        assert.equal(
          snapshot(state),
          snapshot(expected),
          'Native scope changed while retaining hosted checkpoint',
        );
      }
      return operation === 'publish-gate'
        ? {
            id: c.id,
            status: 'publication-ready',
            sha: p.sha,
            remoteBefore: hosted.baseSha,
            branch: hosted.headRef,
          }
        : {
            id: c.id,
            status: hostedResult.status,
            sha: p.sha,
            baseSha: hosted.baseSha,
            prNumber: hosted.prNumber,
          };
    }
    // Finish shares canonical staged notification/receipt recovery with local delivery.
  } else {
    const bareSha = git(fileURLToPath(remote), ['rev-parse', `refs/heads/${branch}`]);
    if (operation === 'gate') {
      git(checkout, ['merge-base', '--is-ancestor', bareSha, p.sha]);
      state = await read();
      c = state.card;
      validate(state);
      owned(c, true);
      assert.equal(c.updatedAt, initialUpdatedAt, 'Feature changed during publication validation');
      return { id: c.id, status: 'publication-ready', sha: p.sha, remoteBefore: bareSha, branch };
    }
    if (c.status !== 'done')
      assert.equal(bareSha, p.sha, 'Publication not independently confirmed');
    else {
      git(checkout, ['merge-base', '--is-ancestor', p.sha, localSha]);
      git(checkout, ['merge-base', '--is-ancestor', p.sha, bareSha]);
    }
  }
  const finishSnapshot = hosted
    ? JSON.stringify([
        state.info,
        state.cards
          .filter(
            (x) =>
              x.metadata?.automation?.tenant === p.id &&
              x.metadata?.automation?.idempotencyKey !== key,
          )
          .sort((a, b) => a.id.localeCompare(b.id)),
      ])
    : null;
  const summary = `Outcome: delivered. ${p.summary}\nCandidate: ${p.sha}${hostedResult ? `\nMerged commit: ${hostedResult.mergeSha}` : ''}`;
  const expectedNotice = sealCreationPayload({
    boardId: p.boardId,
    tenant: c.id,
    idempotencyKey: key,
    title: 'Owner notification',
    agentId: engineeringAgentId,
    status: 'todo',
    priority: 'normal',
    labels: ['type:action', 'owner-notification'],
    workspace: { kind: 'scratch' },
    maxRuntimeSeconds: 1,
    maxRetries: 1,
    notes: `Type: action\nKind: owner-notification\nFeature: ${c.id}\nDelivery: ${delivery}\nCandidate: ${p.sha}\nSummary: ${p.summary}`,
  });
  let notices = children.filter((x) => x.metadata?.automation?.idempotencyKey === key);
  assert(notices.length <= 1, 'Duplicate notification identity');
  if (notices.length) assert(type(notices[0], 'action'), 'Malformed canonical notification');
  assert(
    !children.some(
      (x) =>
        type(x, 'action') &&
        (/^Kind: (owner-)?notification$/im.test(x.notes ?? '') ||
          x.labels?.includes('notification') ||
          x.labels?.includes('owner-notification')) &&
        x.metadata.automation.idempotencyKey !== key,
    ),
    'Existing noncanonical notice requires reconciliation, not replacement',
  );
  if (c.status !== 'done') {
    owned(c, true);
    await ensureCreatedCard(expectedNotice, rpc);
    state = await read();
    c = state.card;
    children = validate(state);
    owned(c, true);
    if (hosted)
      assert.equal(
        JSON.stringify([
          state.info,
          state.cards
            .filter(
              (x) =>
                x.metadata?.automation?.tenant === p.id &&
                x.metadata?.automation?.idempotencyKey !== key,
            )
            .sort((a, b) => a.id.localeCompare(b.id)),
        ]),
        finishSnapshot,
        'Hosted scope changed before completion',
      );
    assert.equal(c.updatedAt, initialUpdatedAt, 'Feature changed before completion');
    notices = children.filter((x) => x.metadata?.automation?.idempotencyKey === key);
    assert.equal(notices.length, 1);
    owned(notices[0], false);
    assert.equal(notices[0].status, 'todo');
    assert(
      type(notices[0], 'action') &&
        field(notices[0].notes, 'Feature') === c.id &&
        field(notices[0].notes, 'Candidate') === p.sha &&
        field(notices[0].notes, 'Summary') === p.summary,
      'Reused notification payload mismatch',
    );
    assert.equal(field(notices[0].notes, 'Delivery'), delivery, 'Staged delivery context changed');
    await rpc('workboard.cards.complete', {
      id: c.id,
      summary,
      proof: {
        status: 'passed',
        label: hosted ? 'Verified hosted delivery' : 'Verified local delivery',
        note: hosted
          ? `Candidate: ${p.sha}; merged commit: ${hostedResult.mergeSha}; base: ${hosted.baseSha}; independent review: ${p.reviewId}; retained hosted gate verified.`
          : `Manager acceptance: ${p.summary}. Independent review ${p.reviewId}; prepared HEAD and selected bare main match ${p.sha}.`,
      },
    });
  }
  state = await read();
  c = state.card;
  validate(state);
  assert.equal(c.status, 'done');
  assert(
    c.metadata.automation.summary.startsWith('Outcome: delivered.') &&
      c.metadata.automation.summary.includes(p.sha),
  );
  if (hosted)
    assert(
      c.metadata.automation.summary === summary &&
        c.metadata.proof?.some(
          (x) =>
            x.status === 'passed' &&
            x.label === 'Verified hosted delivery' &&
            x.note?.includes(`merged commit: ${hostedResult.mergeSha};`),
        ),
      'Hosted terminal merge evidence mismatch',
    );
  notices = state.cards.filter(
    (x) => x.metadata?.automation?.tenant === c.id && x.metadata.automation.idempotencyKey === key,
  );
  assert.equal(notices.length, 1);
  await ensureCreatedCard(expectedNotice, rpc);
  const notice = notices[0];
  assertNoNativeCardLinks(notice);
  assert(
    type(notice, 'action') &&
      field(notice.notes, 'Feature') === c.id &&
      field(notice.notes, 'Candidate') === p.sha &&
      field(notice.notes, 'Summary') === p.summary,
    'Notification identity mismatch',
  );
  assert(!notice.metadata?.archivedAt || notice.status === 'done');
  if (notice.agentId === engineeringAgentId) {
    owned(notice, false);
    assert.equal(notice.status, 'todo');
    // CAS changes only ownership, preserving failures/proof and rejecting a concurrent claim.
    await rpc('workboard.cards.update', {
      id: notice.id,
      expectedUpdatedAt: notice.updatedAt,
      patch: { agentId: productAgentId },
    });
  } else assert.equal(notice.agentId, productAgentId, 'Unexpected notification owner');
  const final = (await read()).cards.find((x) => x.id === notice.id);
  assert.equal(final.agentId, productAgentId);
  assert(
    !final.metadata?.claim || final.metadata.claim.ownerId === productAgentId,
    'Unexpected notification claim',
  );
  return {
    id: c.id,
    status: 'finished',
    notificationId: notice.id,
    notificationStatus: final.status,
    sha: p.sha,
    ...(hostedResult ? { mergeSha: hostedResult.mergeSha } : {}),
    wakeRequired: final.status !== 'done' && !final.metadata?.claim,
  };
}
