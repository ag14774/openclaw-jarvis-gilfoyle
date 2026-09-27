import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pageCards } from './workboard-page.js';
import { topology } from '../topology.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const line = (value, max, name) => {
  assert(
    typeof value === 'string' &&
      value.trim() === value &&
      value.length > 0 &&
      value.length <= max &&
      !/[\r\n\0]/.test(value),
    `Invalid ${name}`,
  );
  return value;
};

const naturalNotes = (scope, context) => {
  const values = [line(scope, 1400, 'scope')];
  if (context !== undefined) values.push(line(context, 1400, 'context'));
  const notes = values.join('\n\n');
  assert(notes.length <= 4000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(notes));
  return notes;
};

async function readBoard(boardId, rpc) {
  const response = await rpc('workboard.cards.list', { boardId });
  pageCards(response, { boardId, includeArchived: true });
  return response.cards;
}

export async function ensureNativeCard(payload, rpc) {
  let cards = await readBoard(payload.boardId, rpc);
  const matches = cards.filter(
    (card) => card.metadata?.automation?.idempotencyKey === payload.idempotencyKey,
  );
  assert(matches.length <= 1, 'Duplicate native card identity');
  if (matches.length) return { card: matches[0], reused: true };
  let response;
  let failure;
  try {
    response = await rpc('workboard.cards.create', payload);
  } catch (error) {
    failure = error;
  }
  const card = response?.card ?? response;
  if (card) assert(UUID.test(card.id), 'Invalid creation response');
  cards = await readBoard(payload.boardId, rpc);
  const readback = cards.filter(
    (candidate) => candidate.metadata?.automation?.idempotencyKey === payload.idempotencyKey,
  );
  if (!readback.length && failure) throw failure;
  assert.equal(readback.length, 1, 'Creation readback is missing or ambiguous');
  if (card) assert.equal(readback[0].id, card.id, 'Creation response identity changed');
  return { card: readback[0], reused: Boolean(failure) };
}

export async function createFeatureCard(input, rpc, registry) {
  assert(
    registry?.store && registry.project && registry.request,
    'Registry request context required',
  );
  const board = registry.store
    .project(registry.project)
    .boards.find((candidate) => candidate.id === input.boardId);
  assert(board, 'Board belongs to another project');
  const existing = registry.store.get(
    'SELECT * FROM features WHERE request=? AND board=?',
    registry.request,
    input.boardId,
  );
  const featureId = existing?.id ?? randomUUID();
  const nativeKey = existing?.native_key ?? `feature:${featureId}`;
  const payload = {
    boardId: input.boardId,
    tenant: input.boardId,
    idempotencyKey: nativeKey,
    title: line(input.title, 180, 'title'),
    agentId: topology().engineeringAgentId,
    status: 'todo',
    priority: input.priority ?? 'normal',
    labels: ['feature'],
    workspace: { kind: 'scratch' },
    maxRuntimeSeconds: 1,
    maxRetries: 1,
    notes: naturalNotes(input.scope, input.context),
  };
  const feature = registry.store.reserveFeature({
    id: featureId,
    request: registry.request,
    project: registry.project,
    board: input.boardId,
    scope: input.scope,
    creationPayload: payload,
  });
  const result = await ensureNativeCard(payload, rpc);
  const bound = registry.store.bindFeatureCard(feature.id, result.card.id);
  registry.store.markFeatureRevisionProjected(bound.id, 1);
  return { ...result, featureId: bound.id, durable: true, acknowledgementReady: true };
}

export async function createProductCard(operation, input, rpc, registry) {
  assert(
    ['work-item', 'review', 'exceptional-intervention'].includes(operation),
    'Unsupported creation operation',
  );
  assert(registry?.store && registry.project, 'Registry context required');
  const feature = registry.store.feature(input.featureId);
  assert.equal(feature.project, registry.project, 'Feature belongs to another project');
  assert.equal(feature.board, input.boardId, 'Feature belongs to another board');
  line(input.title, 180, 'title');
  line(input.scope ?? input.reason, 1400, 'scope');
  const kind =
    operation === 'work-item' ? 'work' : operation === 'review' ? 'review' : 'intervention';
  const key =
    operation === 'work-item'
      ? line(input.assignment, 64, 'assignment key')
      : operation === 'review'
        ? `review-${line(input.reviewKey, 64, 'review key')}`
        : `intervention-${line(input.kind, 64, 'intervention key')}`;
  assert(KEY.test(key), 'Invalid obligation key');
  if (operation === 'review') assert(SHA.test(input.candidate), 'Invalid review candidate');
  const requires = input.requires ?? [];
  assert(
    Array.isArray(requires) && requires.length <= 40 && new Set(requires).size === requires.length,
  );
  for (const dependency of requires)
    assert.equal(registry.store.obligation(dependency).feature, feature.id);
  const existing = registry.store.get(
    'SELECT * FROM obligations WHERE feature=? AND key=?',
    feature.id,
    key,
  );
  const obligationId = existing?.id ?? randomUUID();
  const nativeKey = existing?.native_key ?? `obligation:${obligationId}`;
  const payload = {
    boardId: input.boardId,
    tenant: input.boardId,
    idempotencyKey: nativeKey,
    title: input.title,
    agentId: topology().engineeringAgentId,
    status: 'todo',
    priority: operation === 'exceptional-intervention' ? 'urgent' : 'normal',
    labels:
      operation === 'review'
        ? ['work-item', 'review']
        : operation === 'exceptional-intervention'
          ? ['work-item', 'exceptional-intervention']
          : ['work-item'],
    workspace: { kind: 'scratch' },
    maxRuntimeSeconds: 1,
    maxRetries: 1,
    notes: naturalNotes(input.scope ?? input.reason, input.context),
  };
  const obligation = registry.store.reserveObligation({
    id: obligationId,
    feature: feature.id,
    board: input.boardId,
    kind,
    key,
    required: input.required ?? true,
    requires,
    candidate: operation === 'review' ? input.candidate : null,
    creationPayload: payload,
  });
  const result = await ensureNativeCard(payload, rpc);
  const bound = registry.store.bindObligationCard(obligation.id, result.card.id);
  return {
    ...result,
    obligationId: bound.id,
    ...(operation === 'review' ? { reviewKey: input.reviewKey } : {}),
  };
}

export function assertCanonicalReviewCard(card, featureId, candidate, records) {
  const obligation = records.obligations.find((row) => row.card === card.id);
  const feature = records.features.find((row) => row.id === featureId || row.card === featureId);
  assert(feature && obligation?.feature === feature.id && obligation.kind === 'review');
  assert.equal(obligation.candidate, candidate, 'Review candidate changed');
  const checkpoint = records.publications?.find((row) => row.review_obligation === obligation.id);
  if (checkpoint) assert.equal(checkpoint.candidate, candidate);
  assert(card.labels?.includes('review'), 'Registered review card required');
  return true;
}

export function creationError(error) {
  const message = String(error?.message ?? '');
  return {
    complete: false,
    code: /Registry|registered|belongs/.test(message) ? 'registry-conflict' : 'validation-failed',
    error: message.split('\n')[0].slice(0, 500) || 'Card creation failed',
  };
}
