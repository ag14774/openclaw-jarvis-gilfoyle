import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isAbsolute, posix } from 'node:path';
import { pageCards } from './workboard-page.js';
import {
  assertNoNativeCardLinks,
  currentAttempt,
  deliverySource,
  handoffMarker,
} from './record-contracts.js';
import { githubRef, hostedCandidate } from './github-evidence.js';
import { topology } from '../topology.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const SCOPE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SOURCE =
  /^channel=([a-z][a-z0-9_-]*);account=([A-Za-z0-9._:@%+-]+);recipient=([A-Za-z0-9._:@%+-]+);thread=([A-Za-z0-9._:@%+-]+)$/;
const SOURCE_MESSAGE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CREATE_FIELDS = [
  'agentId',
  'boardId',
  'idempotencyKey',
  'labels',
  'maxRetries',
  'maxRuntimeSeconds',
  'notes',
  'priority',
  'status',
  'tenant',
  'title',
  'workspace',
];
const PROJECT_CREATE_FIELDS = CREATE_FIELDS.filter((key) => key !== 'agentId');

const exactKeys = (value, keys, message = 'Invalid input schema') => {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.equal(Object.keys(value).sort().join(','), [...keys].sort().join(','), message);
};
const line = (value, max, name) => {
  assert(
    typeof value === 'string' &&
      value.trim() === value &&
      value.length > 0 &&
      value.length <= max &&
      !/[\r\n\x00-\x1f\x7f]/.test(value),
    `Invalid ${name}`,
  );
  return value;
};
const cardType = (card) => {
  const matches =
    (card.notes ?? '').match(/^Type: (project-info|feature|work-item|action)$/gim) ?? [];
  return matches.length === 1 ? matches[0].slice(6).toLowerCase() : null;
};
const field = (notes, name) => {
  const values = (notes ?? '').split('\n').filter((value) => value.startsWith(`${name}: `));
  assert.equal(values.length, 1, `Expected one ${name} field`);
  return values[0].slice(name.length + 2);
};
const createFields = (expected) =>
  cardType(expected) === 'project-info' ? PROJECT_CREATE_FIELDS : CREATE_FIELDS;
const digest = (expected) =>
  createHash('sha256')
    .update(
      JSON.stringify(Object.fromEntries(createFields(expected).map((key) => [key, expected[key]]))),
    )
    .digest('hex');

export function sealCreationPayload(expected) {
  exactKeys(expected, createFields(expected), 'Invalid generated create payload');
  assert(!/^Creation:/m.test(expected.notes ?? ''), 'Creation marker is generated internally');
  return { ...expected, notes: `${expected.notes}\nCreation: sha256:${digest(expected)}` };
}

function projectInfo(cards, boardId, allowMissing = false) {
  const matches = cards.filter(
    (card) =>
      /^project-info:/.test(card.metadata?.automation?.idempotencyKey ?? '') ||
      /^Type: project-info\b/im.test(card.notes ?? '') ||
      card.labels?.includes('type:project-info') ||
      (card.metadata?.automation?.tenant === `project:${boardId}` && cardType(card) !== 'feature'),
  );
  assert(
    matches.length === 1 || (allowMissing && matches.length === 0),
    'Project information must be unique',
  );
  if (!matches.length) return null;
  const info = matches[0];
  assert(
    (info.notes?.match(/^Type:/gim) ?? []).length === 1 &&
      /^Type: project-info$/im.test(info.notes) &&
      Array.isArray(info.labels) &&
      info.labels.length === 1 &&
      info.labels[0] === 'type:project-info',
    'Invalid project information type',
  );
  assert(
    info.metadata?.automation?.boardId === boardId &&
      info.metadata.automation.tenant === `project:${boardId}` &&
      info.metadata.automation.idempotencyKey === `project-info:${boardId}` &&
      info.status === 'todo' &&
      !info.agentId &&
      !info.metadata?.claim &&
      !info.metadata?.archivedAt,
    'Invalid project information',
  );
  assert(
    !info.execution && !info.sessionKey && !info.runId && !info.taskId,
    'Invalid project information linkage',
  );
  assertNoNativeCardLinks(info);
  const readiness = field(info.notes, 'Readiness');
  assert(['setup', 'ready', 'paused'].includes(readiness), 'Project is not initialized');
  return readiness;
}

function validateExpected(expected) {
  const { engineeringAgentId } = topology();
  const type = cardType(expected);
  exactKeys(
    expected,
    type === 'project-info' ? PROJECT_CREATE_FIELDS : CREATE_FIELDS,
    'Invalid generated create payload',
  );
  assert(
    typeof expected.boardId === 'string' &&
      SCOPE.test(expected.boardId) &&
      expected.boardId !== 'default',
    'Invalid board',
  );
  line(expected.title, 180, 'title');
  line(expected.idempotencyKey, 160, 'idempotency key');
  assert(
    type === 'project-info'
      ? !Object.hasOwn(expected, 'agentId') && expected.status === 'todo'
      : expected.agentId === engineeringAgentId && expected.status === 'todo',
  );
  assert(['normal', 'urgent'].includes(expected.priority));
  assert.deepEqual(expected.workspace, { kind: 'scratch' });
  assert.equal(expected.maxRuntimeSeconds, 1);
  assert.equal(expected.maxRetries, 1);
  assert(
    Array.isArray(expected.labels) &&
      expected.labels.length > 0 &&
      new Set(expected.labels).size === expected.labels.length,
  );
  assert(
    typeof expected.notes === 'string' &&
      expected.notes.length > 0 &&
      expected.notes.length <= 4000,
  );
  assert(type && expected.labels.includes(`type:${type}`), 'Generated type mismatch');
  const markers = expected.notes.match(/^Creation: sha256:[0-9a-f]{64}$/gm) ?? [];
  assert.equal(markers.length, 1, 'Missing generated creation marker');
  const unsealed = { ...expected, notes: expected.notes.slice(0, -markers[0].length - 1) };
  assert.equal(
    markers[0],
    `Creation: sha256:${digest(unsealed)}`,
    'Invalid generated creation marker',
  );
  return type;
}

function immutableNotes(card, expected, type, cards) {
  const prefix = expected.notes;
  assert(
    card.notes === prefix || card.notes.startsWith(`${prefix}\n`),
    'Reused card payload mismatch',
  );
  assert(
    (card.notes.match(/^Creation:/gm) ?? []).length === 1,
    'Invalid persisted creation marker',
  );
  const names = prefix.split('\n').map((value) => value.slice(0, value.indexOf(':')));
  for (const name of names)
    assert.equal(
      card.notes.split('\n').filter((value) => value.startsWith(`${name}:`)).length,
      1,
      `Expected one immutable ${name} field`,
    );
  const suffix = card.notes.slice(prefix.length).replace(/^\n/, '');
  if (!suffix) return;
  if (type === 'action') {
    const additions = suffix.split('\n');
    assert(
      additions.length <= 8 &&
        additions.every((value) =>
          /^[A-Z][A-Za-z ]{0,39}: [^\r\n\x00-\x1f\x7f]{1,500}$/.test(value),
        ),
      'Malformed Action lifecycle suffix',
    );
    const addedNames = additions.map((value) => value.slice(0, value.indexOf(':')));
    assert(
      new Set(addedNames).size === addedNames.length &&
        addedNames.every((name) => !names.includes(name)),
      'Duplicate Action lifecycle field',
    );
    return;
  }
  let remaining = suffix;
  if (/^Handoff:/m.test(remaining)) {
    const handoff = handoffMarker(card);
    assert(handoff && !handoff.uncertain, 'Malformed progressed handoff');
    deliverySource(cards, card);
    remaining = remaining.replace(/^Handoff:.*\n?/m, '');
  }
  if (type === 'work-item' && /<!-- current-attempt -->/.test(remaining)) {
    const attempt = currentAttempt(card);
    assert(attempt && !attempt.uncertain, 'Malformed progressed attempt');
    remaining = remaining.replace(
      /<!-- current-attempt -->[\s\S]*?<!-- \/current-attempt -->\n?/,
      '',
    );
    remaining = remaining
      .split('\n')
      .filter(
        (value) =>
          !/^(Immutable base|Worktree|Branch|Model|Remaining assignment|Attempt reconciliation): /.test(
            value,
          ),
      )
      .join('\n');
  }
  if (type === 'feature' && /^Hosted candidate:/m.test(remaining)) {
    const candidate = hostedCandidate(JSON.parse(field(card.notes, 'Hosted candidate')));
    const gate = card.notes.split('\n').filter((value) => value.startsWith('Hosted gate: '));
    assert(gate.length <= 1);
    if (gate.length) {
      const value = JSON.parse(gate[0].slice(13));
      assert(
        value &&
          Object.keys(value).sort().join(',') === 'binding,runs' &&
          typeof value.binding === 'string' &&
          /^[0-9a-f]{64}$/.test(value.binding),
        'Malformed hosted gate',
      );
      assert(
        Array.isArray(value.runs) &&
          value.runs.length === candidate.workflows.length &&
          value.runs.length > 0 &&
          value.runs.length <= 4 &&
          value.runs.every(
            (run) =>
              Array.isArray(run) &&
              run.length === 2 &&
              run.every((number) => Number.isSafeInteger(number) && number > 0),
          ) &&
          new Set(value.runs.map((run) => run[0])).size === value.runs.length,
        'Malformed hosted gate',
      );
      const binding = createHash('sha256')
        .update(JSON.stringify([card.metadata.automation.boardId, card.id, candidate]))
        .digest('hex');
      assert.equal(value.binding, binding, 'Hosted gate binding mismatch');
    }
    remaining = remaining
      .split('\n')
      .filter(
        (value) =>
          !(
            /^Hosted candidate: .+$/.test(value) ||
            /^Hosted gate: .+$/.test(value) ||
            value === 'Wait: hosted-ci' ||
            /^CI observed at: .+$/.test(value) ||
            /^CI recheck at: .+$/.test(value)
          ),
      )
      .join('\n');
  }
  assert(!remaining.trim(), 'Unrecognized creation lifecycle suffix');
}

export function assertCanonicalReviewCard(card, featureId, candidate, cards = [card]) {
  const { engineeringAgentId } = topology();
  assert(
    cardType(card) === 'work-item' && UUID.test(featureId) && SHA.test(candidate),
    'Canonical review required',
  );
  const automation = card.metadata?.automation,
    prefix = `work-item:${featureId}:review-`,
    key = automation?.idempotencyKey;
  assert(
    typeof key === 'string' && key.startsWith(prefix) && SLUG.test(key.slice(prefix.length)),
    'Canonical review identity required',
  );
  assert(
    automation.boardId &&
      automation.tenant === featureId &&
      card.agentId === engineeringAgentId &&
      card.priority === 'normal' &&
      card.title &&
      card.title.length <= 180,
    'Canonical review identity required',
  );
  assert.deepEqual(automation.workspace, { kind: 'scratch' }, 'Canonical review identity required');
  assert.equal(automation.maxRuntimeSeconds, 1, 'Canonical review identity required');
  assert.equal(automation.maxRetries, 1, 'Canonical review identity required');
  assert.deepEqual(card.labels, ['type:work-item', 'review'], 'Canonical review labels required');
  const lines = (card.notes ?? '').split('\n'),
    markerIndexes = lines.flatMap((line, index) =>
      /^Creation: sha256:[0-9a-f]{64}$/.test(line) ? [index] : [],
    );
  assert.equal(markerIndexes.length, 1, 'Canonical review creation seal required');
  const immutable = lines.slice(0, markerIndexes[0] + 1);
  assert(
    immutable.length === 7 &&
      immutable[0] === 'Type: work-item' &&
      immutable[1] === `Feature: ${featureId}` &&
      /^Requires Work items: (?:none|[0-9a-f, -]+)$/.test(immutable[2]) &&
      immutable[3] === 'Assignment: independent-review' &&
      immutable[4] === `Candidate: ${candidate}` &&
      /^Scope: [^\r\n\x00-\x1f\x7f]{1,1400}$/.test(immutable[5]),
    'Canonical review fields required',
  );
  const requires = immutable[2].slice('Requires Work items: '.length),
    prerequisiteIds = requires === 'none' ? [] : requires.split(', ');
  assert(
    prerequisiteIds.length <= 40 &&
      new Set(prerequisiteIds).size === prerequisiteIds.length &&
      prerequisiteIds.every((id) => UUID.test(id)),
    'Canonical review prerequisites required',
  );
  const expected = {
    boardId: automation.boardId,
    tenant: featureId,
    idempotencyKey: key,
    title: card.title,
    agentId: engineeringAgentId,
    status: 'todo',
    priority: 'normal',
    labels: ['type:work-item', 'review'],
    workspace: { kind: 'scratch' },
    maxRuntimeSeconds: 1,
    maxRetries: 1,
    notes: immutable.join('\n'),
  };
  validateExpected(expected);
  immutableNotes(card, expected, 'work-item', cards, false);
  assertNoNativeCardLinks(card);
  return true;
}

function validHandoffOwner(card, cards, owner) {
  const { productAgentId } = topology();
  const marker = handoffMarker(card);
  if (!marker || marker.uncertain || card.status !== 'blocked' || card.metadata?.claim)
    return false;
  try {
    deliverySource(cards, card);
  } catch {
    return false;
  }
  return owner === productAgentId
    ? ['needs-message', 'uncertain', 'sent'].includes(marker.phase)
    : marker.phase === 'answer-ready';
}

function progressedState(card, type, expected, cards) {
  const { productAgentId, engineeringAgentId } = topology();
  if (type === 'project-info') {
    assert(
      !card.agentId &&
        !card.metadata?.claim &&
        card.status === 'todo' &&
        !card.metadata?.archivedAt,
      'Invalid project information progression',
    );
    return;
  }
  const pristine =
    card.agentId === engineeringAgentId &&
    card.status === 'todo' &&
    !card.metadata?.claim &&
    card.notes === expected.notes &&
    !card.metadata?.archivedAt;
  if (pristine) return;
  if (card.agentId === productAgentId) {
    const notification =
      type === 'action' && expected.idempotencyKey.endsWith(':owner-notification');
    const claim = card.metadata?.claim;
    const claimedNotification =
      claim &&
      claim.ownerId === productAgentId &&
      ['running', 'review'].includes(card.status) &&
      Number.isFinite(claim.expiresAt) &&
      claim.expiresAt > Date.now();
    assert(
      notification
        ? claimedNotification ||
            (!claim &&
              (card.status === 'todo' ||
                (card.status === 'done' &&
                  Number.isFinite(card.completedAt) &&
                  card.metadata?.automation?.summary)))
        : validHandoffOwner(card, cards, productAgentId),
      'Invalid product-owned progression',
    );
    return;
  }
  assert.equal(card.agentId, engineeringAgentId, 'Invalid progressed owner');
  const claim = card.metadata?.claim;
  if (claim)
    assert(
      claim.ownerId === engineeringAgentId &&
        ['running', 'review'].includes(card.status) &&
        Number.isFinite(claim.expiresAt) &&
        claim.expiresAt > Date.now(),
      'Invalid progressed claim',
    );
  else if (card.status === 'blocked')
    assert(
      validHandoffOwner(card, cards, engineeringAgentId) ||
        card.labels?.includes('user-held') ||
        /^Wait: (human|external|schedule)$/m.test(card.notes),
      'Invalid blocked progression',
    );
  else
    assert(
      ['triage', 'backlog', 'todo', 'scheduled', 'ready', 'done'].includes(card.status) ||
        (type === 'work-item' && card.status === 'review'),
      'Invalid progressed status',
    );
  if (type === 'work-item' && card.notes.includes('<!-- current-attempt -->'))
    assert(currentAttempt(card) && !currentAttempt(card).uncertain, 'Invalid delegated Work item');
  if (card.status === 'done')
    assert(
      Number.isFinite(card.completedAt) && card.metadata?.automation?.summary,
      'Invalid terminal progression',
    );
}

function immutableMatch(card, expected, type, cards) {
  assertNoNativeCardLinks(card);
  const automation = card.metadata?.automation;
  assert(cardType(card) === type && card.title === expected.title, 'Reused card payload mismatch');
  immutableNotes(card, expected, type, cards);
  assert.deepEqual(card.labels, expected.labels, 'Reused card labels mismatch');
  assert.equal(card.priority, expected.priority, 'Reused card priority mismatch');
  assert(
    automation?.boardId === expected.boardId &&
      automation.tenant === expected.tenant &&
      automation.idempotencyKey === expected.idempotencyKey,
    'Reused card identity mismatch',
  );
  assert.deepEqual(automation.workspace, expected.workspace, 'Reused card workspace mismatch');
  assert.equal(
    automation.maxRuntimeSeconds,
    expected.maxRuntimeSeconds,
    'Reused card runtime mismatch',
  );
  assert.equal(automation.maxRetries, expected.maxRetries, 'Reused card retry mismatch');
  progressedState(card, type, expected, cards);
  if (card.metadata?.archivedAt)
    assert(
      (expected.idempotencyKey.endsWith(':owner-notification') ||
        expected.idempotencyKey.endsWith(':cancellation:stop')) &&
        card.status === 'done',
      'Archived product card requires reconciliation',
    );
  assert(
    !card.execution && !card.sessionKey && !card.runId && !card.taskId,
    'Unexpected native execution linkage',
  );
}

function validateReferences(cards, expected, type, existing = false) {
  if (type === 'project-info') {
    assert(
      expected.tenant === `project:${expected.boardId}` &&
        expected.idempotencyKey === `project-info:${expected.boardId}`,
      'Invalid project information identity',
    );
    return;
  }
  if (type === 'feature') {
    assert(
      expected.tenant === expected.boardId &&
        expected.idempotencyKey.startsWith(`feature:${expected.boardId}:`),
      'Invalid Feature identity',
    );
    return;
  }
  const featureId = field(expected.notes, 'Feature');
  assert(UUID.test(featureId) && expected.tenant === featureId, 'Invalid Feature reference');
  const features = cards.filter((card) => card.id === featureId);
  assert.equal(features.length, 1, 'Invalid Feature reference');
  const feature = features[0];
  const terminalNotification =
    type === 'action' &&
    expected.idempotencyKey.endsWith(':owner-notification') &&
    feature.status === 'done' &&
    typeof feature.metadata?.automation?.summary === 'string' &&
    feature.metadata.automation.summary.trim() &&
    feature.metadata?.proof?.some((proof) => proof.status === 'passed');
  const terminalReuse =
    terminalNotification ||
    (existing && type === 'action' && expected.idempotencyKey.endsWith(':cancellation:stop'));
  const canonicalStopParent =
    !expected.idempotencyKey.endsWith(':cancellation:stop') ||
    (feature.metadata?.automation?.tenant === expected.boardId &&
      typeof feature.metadata?.automation?.idempotencyKey === 'string' &&
      feature.metadata.automation.idempotencyKey.startsWith(`feature:${expected.boardId}:`));
  assert(
    cardType(feature) === 'feature' &&
      feature.metadata?.automation?.boardId === expected.boardId &&
      canonicalStopParent &&
      (terminalReuse || (!feature.metadata?.archivedAt && feature.status !== 'done')),
    'Invalid or completed Feature',
  );
  assertNoNativeCardLinks(feature);
  if (type === 'work-item') {
    const pending = cards.filter(
      (card) =>
        card.metadata?.automation?.tenant === featureId &&
        card.status !== 'done' &&
        cardType(card) === 'action',
    );
    pending.forEach(assertNoNativeCardLinks);
    assert(!pending.length, 'Pending decision/stop/intervention');
  }
  if (type !== 'work-item') return;
  const requires = field(expected.notes, 'Requires Work items');
  const ids = requires === 'none' ? [] : requires.split(', ');
  assert(
    new Set(ids).size === ids.length &&
      ids.every((id) => {
        const item = cards.find((card) => card.id === id);
        return (
          UUID.test(id) &&
          item &&
          cardType(item) === 'work-item' &&
          item.metadata?.automation?.boardId === expected.boardId &&
          item.metadata?.automation?.tenant === featureId &&
          field(item.notes, 'Feature') === featureId &&
          !item.metadata?.archivedAt &&
          (assertNoNativeCardLinks(item), true)
        );
      }),
    'Invalid Work item prerequisites',
  );
  const graph = new Map();
  const load = (id) => {
    if (graph.has(id)) return;
    const item = cards.find((card) => card.id === id);
    assert(
      item &&
        cardType(item) === 'work-item' &&
        item.metadata?.automation?.tenant === featureId &&
        field(item.notes, 'Feature') === featureId,
      'Invalid Work item prerequisite graph',
    );
    assertNoNativeCardLinks(item);
    const values = (item.notes ?? '')
      .split('\n')
      .filter((row) => row.startsWith('Requires Work items: '));
    assert.equal(values.length, 1, 'Malformed Work item prerequisites');
    const dependencies = values[0].slice(21) === 'none' ? [] : values[0].slice(21).split(', ');
    assert(
      new Set(dependencies).size === dependencies.length &&
        dependencies.every((dependency) => UUID.test(dependency) && dependency !== id),
      'Invalid Work item prerequisite graph',
    );
    graph.set(id, dependencies);
    dependencies.forEach(load);
  };
  ids.forEach(load);
  const visiting = new Set(),
    visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw Error('Work item prerequisite cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
}

async function readBoard(
  boardId,
  rpc,
  { allowMissingProject = false, skipProjectInfo = false } = {},
) {
  const response = await rpc('workboard.cards.list', { boardId });
  pageCards(response, { boardId, includeArchived: true });
  const readiness = skipProjectInfo
    ? null
    : projectInfo(response.cards, boardId, allowMissingProject);
  return { cards: response.cards, readiness };
}

const creationResult = (card, reused, type) => ({
  card,
  reused,
  ...(type === 'feature'
    ? {
        durable: true,
        disposition: reused ? 'reused' : 'created',
        acknowledgementReady: true,
        wakeMessage: `PROJECT WAKE\ncard: ${card.id}\nreason: new-feature`,
      }
    : {}),
});

export async function ensureCreatedCard(expected, rpc) {
  const type = validateExpected(expected);
  const stop = type === 'action' && expected.idempotencyKey.endsWith(':cancellation:stop');
  const repositoryPending =
    type === 'feature' &&
    /^Project identity: [0-9a-f-]{36}$/m.test(expected.notes) &&
    /^Repository scope: pending$/m.test(expected.notes);
  let state = await readBoard(expected.boardId, rpc, {
      allowMissingProject: type === 'project-info',
      skipProjectInfo: stop || repositoryPending,
    }),
    cards = state.cards;
  if (['feature', 'work-item'].includes(type) && !repositoryPending)
    assert.equal(state.readiness, 'ready', 'Project is paused');
  let matches = cards.filter(
    (card) => card.metadata?.automation?.idempotencyKey === expected.idempotencyKey,
  );
  assert(matches.length <= 1, 'Duplicate canonical card identity');
  if (matches.length) {
    immutableMatch(matches[0], expected, type, cards);
    validateReferences(cards, expected, type, true);
    return creationResult(matches[0], true, type);
  }
  validateReferences(cards, expected, type);
  const response = await rpc('workboard.cards.create', expected);
  const receipt = response?.card ?? response;
  assert(receipt && UUID.test(receipt.id), 'Invalid creation response');
  immutableMatch(receipt, expected, type, [...cards, receipt]);
  state = await readBoard(expected.boardId, rpc, { skipProjectInfo: stop || repositoryPending });
  cards = state.cards;
  if (['feature', 'work-item'].includes(type) && !repositoryPending)
    assert.equal(state.readiness, 'ready', 'Project is paused');
  validateReferences(cards, expected, type);
  matches = cards.filter(
    (card) => card.metadata?.automation?.idempotencyKey === expected.idempotencyKey,
  );
  assert.equal(matches.length, 1, 'Creation reread is missing or ambiguous');
  assert.equal(matches[0].id, receipt.id, 'Creation response identity changed');
  immutableMatch(matches[0], expected, type, cards);
  return creationResult(matches[0], false, type);
}

const CREATION_ERRORS = {
  'project-info-invalid': 'Project information is invalid or ambiguous.',
  'native-link': 'A relevant card has unsupported native linkage.',
  'identity-conflict': 'The requested card identity conflicts with durable state.',
  'project-paused': 'The project is not ready for new engineering work.',
  'invalid-input': 'The creation request is invalid.',
  'incomplete-read': 'The complete board could not be safely read.',
  operation: 'The creation operation is unsupported.',
  'validation-failed': 'Card creation validation failed; native state was not safely reconciled.',
};

export function creationError(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  let code = 'validation-failed';
  if (error instanceof SyntaxError) code = 'invalid-input';
  else if (/Unsupported creation operation/.test(message)) code = 'operation';
  else if (/Project information|project information|Project is not initialized/.test(message))
    code = 'project-info-invalid';
  else if (
    /Native (?:createdByCardId|dependency links).*forbidden|Unexpected native execution linkage/.test(
      message,
    )
  )
    code = 'native-link';
  else if (/Project is paused/.test(message)) code = 'project-paused';
  else if (
    /Incomplete native response|enumeration changed|truncated|board scope mismatch|Missing board total|Unknown board|Invalid native board totals/.test(
      message,
    )
  )
    code = 'incomplete-read';
  else if (
    /Duplicate canonical|payload mismatch|identity changed|identity mismatch|progressed|creation marker|Creation reread/.test(
      message,
    )
  )
    code = 'identity-conflict';
  else if (
    error?.code === 'ERR_ASSERTION' &&
    /Invalid|Expected|Missing generated|Ready project requires|Generated|Use one supported/.test(
      message,
    )
  )
    code = 'invalid-input';
  return { complete: false, code, error: CREATION_ERRORS[code] };
}

function generated(type, input) {
  const common = {
    boardId: input.boardId,
    agentId: topology().engineeringAgentId,
    status: 'todo',
    workspace: { kind: 'scratch' },
    maxRuntimeSeconds: 1,
    maxRetries: 1,
  };
  if (type === 'project-info')
    return sealCreationPayload({
      boardId: input.boardId,
      tenant: `project:${input.boardId}`,
      idempotencyKey: `project-info:${input.boardId}`,
      title: `${input.name} project information`,
      status: 'todo',
      priority: 'normal',
      labels: ['type:project-info'],
      workspace: { kind: 'scratch' },
      maxRuntimeSeconds: 1,
      maxRetries: 1,
      notes: `Type: project-info\nName: ${input.name}\nRepository: ${input.repository}\nCheckout: ${input.checkout}\nIntegration branch: ${input.integrationBranch}\nProduct docs: ${input.productDocs.join(', ')}\nArchitecture docs: ${input.architectureDocs.length ? input.architectureDocs.join(', ') : 'none'}\nRequired CI: ${JSON.stringify(input.requiredCI)}\nReadiness: ${input.readiness}\nScope: ${input.scope}\nSetup evidence: ${input.evidence}`,
    });
  if (type === 'feature') {
    const channel = SOURCE.exec(input.deliverySource)?.[1];
    const source =
      input.sourceMessage === undefined ? input.request : `${channel}-${input.sourceMessage}`;
    return sealCreationPayload({
      ...common,
      tenant: input.boardId,
      idempotencyKey: `feature:${input.boardId}:${source}`,
      title: input.title,
      priority: 'normal',
      labels: ['type:feature'],
      notes: `Type: feature\nRequest: ${input.request}${input.sourceMessage === undefined ? '' : `\nSource message: ${input.sourceMessage}`}\nScope: ${input.scope}\nDelivery: ${input.delivery}\nDelivery source: ${input.deliverySource}`,
    });
  }
  if (type === 'review')
    return sealCreationPayload({
      ...common,
      tenant: input.featureId,
      idempotencyKey: `work-item:${input.featureId}:review-${input.reviewKey}`,
      title: input.title,
      priority: 'normal',
      labels: ['type:work-item', 'review'],
      notes: `Type: work-item\nFeature: ${input.featureId}\nRequires Work items: ${input.requires.length ? input.requires.join(', ') : 'none'}\nAssignment: independent-review\nCandidate: ${input.candidate}\nScope: ${input.scope}`,
    });
  if (type === 'work-item')
    return sealCreationPayload({
      ...common,
      tenant: input.featureId,
      idempotencyKey: `work-item:${input.featureId}:${input.assignment}`,
      title: input.title,
      priority: 'normal',
      labels: ['type:work-item'],
      notes: `Type: work-item\nFeature: ${input.featureId}\nRequires Work items: ${input.requires.length ? input.requires.join(', ') : 'none'}\nAssignment: ${input.assignment}\nScope: ${input.scope}`,
    });
  if (type === 'stop')
    return sealCreationPayload({
      ...common,
      tenant: input.featureId,
      idempotencyKey: `action:${input.featureId}:cancellation:stop`,
      title: input.title,
      priority: 'urgent',
      labels: ['type:action', 'cancellation', 'stop'],
      notes: `Type: action\nKind: cancellation\nFeature: ${input.featureId}\nReason: ${input.reason}`,
    });
  return sealCreationPayload({
    ...common,
    tenant: input.featureId,
    idempotencyKey: `action:${input.featureId}:intervention:${input.kind}`,
    title: input.title,
    priority: 'urgent',
    labels: ['type:action', 'exceptional-intervention', input.kind],
    notes: `Type: action\nKind: exceptional-intervention\nIntervention: ${input.kind}\nFeature: ${input.featureId}\nReason: ${input.reason}`,
  });
}

export async function createProductCard(operation, input, rpc) {
  const schemas = {
    'project-info': [
      'architectureDocs',
      'boardId',
      'checkout',
      'evidence',
      'integrationBranch',
      'name',
      'productDocs',
      'readiness',
      'repository',
      'requiredCI',
      'scope',
    ],
    feature: [
      'boardId',
      'delivery',
      'deliverySource',
      'request',
      'scope',
      'sourceMessage',
      'title',
    ],
    review: ['boardId', 'candidate', 'featureId', 'requires', 'reviewKey', 'scope', 'title'],
    'work-item': ['assignment', 'boardId', 'featureId', 'requires', 'scope', 'title'],
    stop: ['boardId', 'featureId', 'reason', 'title'],
    'exceptional-intervention': ['boardId', 'featureId', 'kind', 'reason', 'title'],
  };
  assert(Object.hasOwn(schemas, operation), 'Unsupported creation operation');
  exactKeys(input, schemas[operation]);
  assert(
    typeof input.boardId === 'string' && SCOPE.test(input.boardId) && input.boardId !== 'default',
    'Invalid board',
  );
  if (operation !== 'project-info') line(input.title, 180, 'title');
  if (operation === 'project-info') {
    line(input.name, 120, 'name');
    assert(
      `${input.name} project information`.length <= 180,
      'Generated title exceeds native limit',
    );
    line(input.repository, 500, 'repository');
    line(input.checkout, 1000, 'checkout');
    line(input.integrationBranch, 160, 'integration branch');
    assert(
      isAbsolute(input.checkout) &&
        posix.normalize(input.checkout) === input.checkout &&
        !/[\r\n\x00-\x1f\x7f]/.test(input.checkout),
      'Invalid checkout',
    );
    assert(githubRef(input.integrationBranch), 'Invalid integration branch');
    const github =
      /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\.git$/.test(
        input.repository,
      );
    let local = false;
    try {
      const url = new URL(input.repository);
      local =
        url.href === input.repository &&
        url.protocol === 'file:' &&
        !url.hostname &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname.startsWith('/') &&
        !/[\x00-\x1f\x7f]/.test(decodeURIComponent(url.pathname));
    } catch {
      /* Repository remains invalid. */
    }
    assert(github || local, 'Invalid repository');
    const paths = (value, minimum, name) => {
      assert(
        Array.isArray(value) &&
          value.length >= minimum &&
          value.length <= 20 &&
          new Set(value).size === value.length,
        `Invalid ${name}`,
      );
      assert(
        value.every(
          (path) =>
            typeof path === 'string' &&
            path.length > 0 &&
            path.length <= 240 &&
            !path.includes('\\') &&
            !path.includes(',') &&
            !isAbsolute(path) &&
            posix.normalize(path) === path &&
            path !== '.' &&
            !path.split('/').includes('..') &&
            !/[\x00-\x1f\x7f]/.test(path),
        ),
        `Invalid ${name}`,
      );
    };
    paths(input.productDocs, 1, 'product docs');
    paths(input.architectureDocs, 0, 'architecture docs');
    assert(['setup', 'ready', 'paused'].includes(input.readiness), 'Invalid readiness');
    assert(
      typeof input.evidence === 'string' &&
        input.evidence.trim() === input.evidence &&
        input.evidence.length <= 1000 &&
        !/[\r\n\x00-\x1f\x7f]/.test(input.evidence),
      'Invalid setup evidence',
    );
    line(input.scope, 1000, 'scope');
    assert(
      Array.isArray(input.requiredCI) &&
        input.requiredCI.length <= 4 &&
        (github ? input.requiredCI.length > 0 : input.requiredCI.length === 0),
      'Invalid required CI',
    );
    const workflowPaths = new Set();
    for (const workflow of input.requiredCI) {
      assert(
        workflow &&
          Object.keys(workflow).sort().join(',') === 'jobs,path' &&
          typeof workflow.path === 'string' &&
          /^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/.test(workflow.path) &&
          workflow.path.length <= 160 &&
          !workflowPaths.has(workflow.path),
        'Invalid required CI',
      );
      workflowPaths.add(workflow.path);
      assert(
        Array.isArray(workflow.jobs) &&
          workflow.jobs.length > 0 &&
          workflow.jobs.length <= 20 &&
          new Set(workflow.jobs).size === workflow.jobs.length &&
          workflow.jobs.every(
            (job) =>
              typeof job === 'string' && job.trim() === job && /^[\x20-\x7e]{1,120}$/.test(job),
          ),
        'Invalid required CI',
      );
    }
    assert(
      input.readiness !== 'ready' || input.evidence.length > 0,
      'Ready project requires setup evidence',
    );
  } else if (operation === 'feature') {
    assert(SLUG.test(input.request), 'Invalid request key');
    line(input.scope, 1400, 'scope');
    line(input.delivery, 500, 'delivery');
    line(input.deliverySource, 500, 'delivery source');
    const source = SOURCE.exec(input.deliverySource);
    assert(source, 'Invalid delivery source');
    line(input.sourceMessage, 100, 'source message');
    assert(
      ['telegram', 'discord'].includes(source[1])
        ? /^[1-9][0-9]{0,99}$/.test(input.sourceMessage)
        : SOURCE_MESSAGE.test(input.sourceMessage),
      'Invalid source message',
    );
    const telegram = /^Telegram default to ([A-Za-z0-9._:@%+-]+)$/.exec(input.delivery);
    assert(
      input.delivery === input.deliverySource ||
        (input.delivery === 'current-source internal-ui' &&
          input.deliverySource.startsWith('channel=internal-ui;')) ||
        (telegram &&
          input.deliverySource ===
            `channel=telegram;account=default;recipient=${telegram[1]};thread=none`),
      'Delivery source contradicts delivery',
    );
  } else {
    assert(UUID.test(input.featureId), 'Invalid Feature UUID');
    line(input.reason ?? input.scope, 1400, operation === 'work-item' ? 'scope' : 'reason');
  }
  if (['work-item', 'review'].includes(operation)) {
    assert(
      Array.isArray(input.requires) &&
        input.requires.length <= 40 &&
        new Set(input.requires).size === input.requires.length &&
        input.requires.every((id) => UUID.test(id)),
      'Invalid prerequisite list',
    );
  }
  if (operation === 'work-item') {
    assert(SLUG.test(input.assignment), 'Invalid assignment key');
    assert(
      !/^independent-review(?:-|$)/.test(input.assignment),
      'Independent review requires the review operation',
    );
  }
  if (operation === 'review')
    assert(SLUG.test(input.reviewKey) && SHA.test(input.candidate), 'Invalid review identity');
  if (operation === 'exceptional-intervention')
    assert(
      ['cancellation-uncertain', 'communication-urgent'].includes(input.kind),
      'Unsupported intervention kind',
    );
  return ensureCreatedCard(generated(operation, input), rpc);
}
