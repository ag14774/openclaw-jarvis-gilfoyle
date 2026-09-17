import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { topology } from '../topology.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = (value) => typeof value === 'string' && UUID.test(value);
const bounded = (value) => typeof value === 'string' && value.trim() && value.length <= 1400;
const kind = (card) =>
  /^Type: (feature|work[ -]item)$/im.exec(card.notes ?? '')?.[1]?.toLowerCase();
const sourcePattern =
  /^channel=([a-z][a-z0-9_-]*);account=([A-Za-z0-9._:@%+-]+);recipient=([A-Za-z0-9._:@%+-]+);thread=([A-Za-z0-9._:@%+-]+)$/;
export const isManagerActor = (actor, role) =>
  typeof actor === 'string' &&
  actor.length <= 300 &&
  actor.startsWith(`agent:${role}:`) &&
  actor.length > `agent:${role}:`.length &&
  !/[\s\x00-\x1f\x7f]/.test(actor);

export function featureOf(cards, card) {
  return kind(card) === 'feature'
    ? card
    : cards.find((c) => c.id === card.metadata?.automation?.tenant);
}
export function projectIdentity(cards, card) {
  const feature = featureOf(cards, card);
  return /^Project identity: ([0-9a-f-]{36})$/m.exec(feature?.notes ?? '')?.[1] ?? null;
}
export function controllerKey(cards, card, agentId = topology().engineeringAgentId) {
  const feature = featureOf(cards, card);
  return projectIdentity(cards, card)
    ? `agent:${agentId}:${topology().sessionNamespace}:${feature.id}`
    : `agent:${agentId}:main`;
}

export function assertNoNativeCardLinks(card) {
  if (
    !card ||
    card.createdByCardId ||
    card.metadata?.createdByCardId ||
    card.metadata?.automation?.createdByCardId
  )
    throw new Error('Native createdByCardId is forbidden');
  if (
    (card.metadata?.links ?? []).some((link) => link?.type === 'parent' || link?.type === 'child')
  )
    throw new Error('Native dependency links are forbidden');
}

export function deliverySource(cards, card) {
  const parent =
    kind(card) === 'feature'
      ? card
      : cards.find((value) => value.id === card.metadata?.automation?.tenant);
  const resolve = (value) => {
    const lines = (name) =>
      (value.notes ?? '')
        .split('\n')
        .filter((line) => line.startsWith(`${name}: `))
        .map((line) => line.slice(name.length + 2));
    const delivery = lines('Delivery'),
      sources = lines('Delivery source');
    assert(delivery.length === 1 && sources.length <= 1, 'Retained delivery context required');
    const telegram = /^Telegram default to ([A-Za-z0-9._:@%+-]+)$/.exec(delivery[0]);
    const source =
      sources[0] ??
      (telegram
        ? `channel=telegram;account=default;recipient=${telegram[1]};thread=none`
        : delivery[0]);
    assert(
      source.length <= 500 && sourcePattern.test(source),
      'Explicit channel/account/recipient/thread delivery source required',
    );
    assert(
      source === delivery[0] ||
        (telegram &&
          source === `channel=telegram;account=default;recipient=${telegram[1]};thread=none`) ||
        (delivery[0] === 'current-source internal-ui' && source.startsWith('channel=internal-ui;')),
      'Delivery source contradicts retained context',
    );
    return source;
  };
  const source = resolve(parent);
  if (card.id !== parent.id && /^Delivery(?: source)?:/m.test(card.notes))
    assert.equal(resolve(card), source, 'Child delivery source mismatch');
  return source;
}

export function handoffComment(card, comment) {
  try {
    const evidence = JSON.parse(comment.body);
    assert(
      comment.body.length <= 2000 &&
        evidence.card === card.id &&
        uuid(evidence.checkpoint) &&
        ['question', 'receipt', 'answer', 'application'].includes(evidence.kind),
    );
    assert(Object.keys(evidence).sort().join(',') === 'actor,card,checkpoint,data,kind');
    assert(
      isManagerActor(
        evidence.actor,
        ['question', 'application'].includes(evidence.kind)
          ? topology().engineeringAgentId
          : topology().productAgentId,
      ),
    );
    assert(evidence.data && typeof evidence.data === 'object' && !Array.isArray(evidence.data));
    const keys = {
      question: 'question,reason,resolution,source',
      receipt: 'channel,delivery,message',
      answer: 'answer,channel,message,replyTo',
      application: 'application,replacementRequired',
    };
    const adjacent =
      evidence.kind === 'answer' &&
      Object.keys(evidence.data).sort().join(',') ===
        'answer,channel,correlation,decision,message,previousMessage';
    const correlated =
      evidence.kind === 'answer' &&
      Object.keys(evidence.data).sort().join(',') ===
        'answer,channel,correlation,message,questionMessage' &&
      evidence.data.correlation === 'explicit-project-answer';
    const productDecision =
      evidence.kind === 'answer' &&
      Object.keys(evidence.data).sort().join(',') === 'correlation,decision,evidence' &&
      evidence.data.correlation === 'product-agent-decision';
    assert(
      Object.keys(evidence.data).sort().join(',') === keys[evidence.kind] ||
        adjacent ||
        correlated ||
        productDecision ||
        (evidence.kind === 'question' &&
          ['question,reason,resolution', 'question,reason,resolution,routing,source'].includes(
            Object.keys(evidence.data).sort().join(','),
          )) ||
        (evidence.kind === 'receipt' &&
          evidence.data.delivery === 'uncertain' &&
          Object.keys(evidence.data).sort().join(',') === 'channel,delivery'),
    );
    if (evidence.data.routing !== undefined)
      assert(evidence.kind === 'question' && evidence.data.routing === 'project');
    if (evidence.kind === 'question')
      assert(
        [
          'product-question',
          'product-suggestion',
          'engineering-question',
          'retained-user-decision',
          'operational-blocker',
        ].includes(evidence.data.reason) &&
          bounded(evidence.data.question) &&
          bounded(evidence.data.resolution) &&
          (evidence.data.source === undefined ||
            (typeof evidence.data.source === 'string' &&
              evidence.data.source.length <= 500 &&
              sourcePattern.test(evidence.data.source))),
      );
    if (evidence.kind === 'receipt')
      assert(
        ['sent', 'uncertain'].includes(evidence.data.delivery) &&
          bounded(evidence.data.channel) &&
          (bounded(evidence.data.message) ||
            (evidence.data.delivery === 'uncertain' && evidence.data.message === undefined)),
      );
    if (evidence.kind === 'answer') {
      if (productDecision)
        assert(bounded(evidence.data.decision) && bounded(evidence.data.evidence));
      else if (correlated)
        assert(
          ['answer', 'channel', 'message', 'questionMessage'].every((key) =>
            bounded(evidence.data[key]),
          ) && sourcePattern.test(evidence.data.channel),
        );
      else if (adjacent)
        assert(
          evidence.data.correlation === 'adjacent-confirmation' &&
            evidence.data.decision === 'affirm' &&
            ['answer', 'channel', 'previousMessage', 'message'].every((key) =>
              bounded(evidence.data[key]),
            ) &&
            evidence.data.message !== evidence.data.previousMessage,
        );
      else
        assert(
          ['answer', 'channel', 'message', 'replyTo'].every((key) => bounded(evidence.data[key])) &&
            evidence.data.message !== evidence.data.replyTo,
        );
    }
    if (evidence.kind === 'application')
      assert(
        bounded(evidence.data.application) &&
          typeof evidence.data.replacementRequired === 'boolean',
      );
    return evidence;
  } catch {
    return null;
  }
}

export function handoffMarker(card) {
  const lines = (card.notes ?? '').split('\n').filter((line) => line.startsWith('Handoff:'));
  if (!lines.length) return null;
  try {
    assert(lines.length === 1 && lines[0].length <= 700);
    const marker = JSON.parse(lines[0].slice(9));
    assert(
      Object.keys(marker).every((key) =>
        ['checkpoint', 'phase', 'question', 'receipt', 'answer', 'application'].includes(key),
      ),
    );
    assert(
      uuid(marker.checkpoint) &&
        uuid(marker.question) &&
        [
          'needs-message',
          'uncertain',
          'sent',
          'answer-ready',
          'applied',
          'resolved-internally',
        ].includes(marker.phase),
    );
    for (const key of ['receipt', 'answer', 'application'])
      if (marker[key] !== undefined) assert(uuid(marker[key]));
    assert(marker.phase !== 'sent' || marker.receipt);
    assert(marker.phase !== 'uncertain' || marker.receipt);
    assert(!['answer-ready', 'applied'].includes(marker.phase) || marker.answer);
    assert(!['applied', 'resolved-internally'].includes(marker.phase) || marker.application);
    if (marker.phase === 'resolved-internally')
      assert(!marker.answer, 'Internal resolution must not fabricate a user answer');
    assert(
      marker.phase !== 'needs-message' ||
        (!marker.receipt && !marker.answer && !marker.application),
    );
    assert(
      !['sent', 'uncertain'].includes(marker.phase) || (!marker.answer && !marker.application),
    );
    assert(marker.phase !== 'answer-ready' || !marker.application);
    const evidence = (card.metadata?.comments ?? []).flatMap((comment) => {
      try {
        const value = JSON.parse(comment.body);
        return value.checkpoint === marker.checkpoint ? [value] : [];
      } catch {
        return [];
      }
    });
    for (const key of ['question', 'answer', 'application'])
      assert(
        evidence.filter((value) => value.kind === key).length <= 1,
        'Duplicate checkpoint evidence',
      );
    const receipts = evidence.filter((value) => value.kind === 'receipt');
    assert(receipts.length <= 2);
    if (receipts.length === 2) {
      assert(
        receipts
          .map((value) => value.data.delivery)
          .sort()
          .join(',') === 'sent,uncertain' && receipts[0].data.channel === receipts[1].data.channel,
      );
      const uncertain = receipts.find((value) => value.data.delivery === 'uncertain').data;
      assert(
        uncertain.message === undefined || receipts[0].data.message === receipts[1].data.message,
      );
    }
    for (const key of ['question', 'receipt', 'answer', 'application'])
      if (marker[key]) {
        const matches = (card.metadata?.comments ?? []).filter(
          (comment) => comment.id === marker[key],
        );
        assert(matches.length === 1);
        const value = handoffComment(card, matches[0]);
        assert(
          value &&
            value.checkpoint === marker.checkpoint &&
            value.card === card.id &&
            value.kind === key,
        );
        if (key === 'question')
          assert(value.data.source, 'Handoff requires explicit retained source');
        if (key === 'receipt') {
          assert(
            ['uncertain', 'resolved-internally'].includes(marker.phase) ||
              value.data.delivery === 'sent',
          );
          const question = JSON.parse(
            card.metadata.comments.find((comment) => comment.id === marker.question).body,
          ).data;
          assert(
            (question.routing === 'project' && sourcePattern.test(value.data.channel)) ||
              (marker.phase === 'applied' && question.source === undefined) ||
              value.data.channel === question.source,
            'Receipt source mismatch',
          );
        }
        if (key === 'answer') {
          if (value.data.correlation === 'product-agent-decision')
            assert(
              !marker.receipt &&
                ['decision', 'evidence'].every((name) => bounded(value.data[name])),
            );
          else {
            assert(marker.receipt, 'User answer requires a delivery receipt');
            const receipt = JSON.parse(
              card.metadata.comments.find((comment) => comment.id === marker.receipt).body,
            ).data;
            assert(
              (value.data.correlation === 'explicit-project-answer' &&
                value.data.questionMessage === receipt.message) ||
                (value.data.channel === receipt.channel &&
                  (value.data.replyTo === receipt.message ||
                    (value.data.correlation === 'adjacent-confirmation' &&
                      value.data.previousMessage === receipt.message))),
            );
          }
        }
      }
    return marker;
  } catch {
    return { uncertain: true };
  }
}

export function handoffHeld(card) {
  const marker = handoffMarker(card);
  return Boolean(marker && !['applied', 'resolved-internally'].includes(marker.phase));
}

export function handoffEvidencePending(card, marker = handoffMarker(card)) {
  return Boolean(
    marker &&
    (card.metadata?.comments ?? []).some((comment) => {
      try {
        const evidence = JSON.parse(comment.body);
        return (
          evidence.checkpoint === marker.checkpoint &&
          ['receipt', 'answer', 'application'].includes(evidence.kind) &&
          !marker[evidence.kind]
        );
      } catch {
        return false;
      }
    }),
  );
}

export function reconciledAttempts(card) {
  const archives = (card.metadata?.comments ?? [])
    .filter((comment) => comment.body?.startsWith('Reconciled attempt: '))
    .map((comment) => {
      const archive = JSON.parse(comment.body.slice(20));
      if (
        !UUID.test(comment.id) ||
        comment.body.length > 2000 ||
        Object.keys(archive).sort().join(',') !== 'next,prior'
      )
        throw Error('Invalid attempt archive');
      const prior = archive.prior,
        next = archive.next;
      if (
        !prior ||
        !next ||
        !Number.isInteger(next.attempt) ||
        next.attempt < 2 ||
        next.attempt > 999999 ||
        prior.attempt !== `${card.id}-a${next.attempt - 1}` ||
        Object.keys(next).sort().join(',') !==
          'attempt,baseSha,branch,inspectedHead,model,profileId,reconciliation,remaining,replaces,taskName,thinking,timeoutSeconds,worktree' ||
        Object.keys(prior).some(
          (key) =>
            ![
              'attempt',
              'taskName',
              'profileId',
              'model',
              'thinking',
              'timeoutSeconds',
              'backend',
              'taskId',
              'runId',
              'childSessionKey',
              'wrapperTaskId',
              'commentId',
              'reconciliationId',
              'baseSha',
              'worktree',
              'branch',
              'remaining',
            ].includes(key),
        )
      )
        throw Error('Invalid attempt archive identity');
      if (
        !next.replaces ||
        Object.keys(next.replaces).sort().join(',') !==
          'attempt,childSessionKey,commentId,runId,taskId,wrapperTaskId' ||
        next.taskName !== `wi-${card.id}-a${next.attempt}` ||
        !Number.isInteger(next.timeoutSeconds) ||
        next.timeoutSeconds < 1 ||
        next.timeoutSeconds > 1800 ||
        ![prior.baseSha, next.baseSha, next.inspectedHead].every(
          (value) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value),
        ) ||
        ![prior, next].every(
          (value) =>
            typeof value.worktree === 'string' &&
            isAbsolute(value.worktree) &&
            typeof value.branch === 'string' &&
            value.branch.trim() &&
            value.branch.length <= 160 &&
            !/[\r\n]/.test(value.worktree + value.branch) &&
            /^[a-z][a-z0-9_-]{0,31}$/.test(value.profileId) &&
            typeof value.model === 'string' &&
            value.model.trim() === value.model &&
            value.model.length > 0 &&
            value.model.length <= 160 &&
            ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(
              value.thinking,
            ),
        ) ||
        typeof next.remaining !== 'string' ||
        !next.remaining.trim() ||
        next.remaining.length > 240 ||
        typeof next.reconciliation !== 'string' ||
        next.reconciliation.length > 500 ||
        /[\r\n]/.test(next.remaining + next.reconciliation) ||
        !next.reconciliation.includes(next.inspectedHead) ||
        !next.reconciliation.includes(next.remaining) ||
        next.reconciliation.length <= next.inspectedHead.length + next.remaining.length + 12 ||
        (prior.reconciliationId !== undefined && !UUID.test(prior.reconciliationId))
      )
        throw Error('Invalid reconciled assignment');
      for (const key of [
        'attempt',
        'taskId',
        'wrapperTaskId',
        'runId',
        'childSessionKey',
        'commentId',
      ])
        if (next.replaces?.[key] !== prior[key]) throw Error('Archive replacement mismatch');
      for (const key of ['baseSha', 'worktree', 'branch'])
        if (typeof prior[key] !== 'string' || !prior[key]) throw Error('Missing prior assignment');
      const notes = `<!-- current-attempt -->\nDelegated attempt: ${prior.attempt}\nTask name: ${prior.taskName}\nProfile ID: ${prior.profileId}\nModel: ${prior.model}\nThinking: ${prior.thinking}\nTask ID: ${prior.taskId}\nRun ID: ${prior.runId}\nChild session: ${prior.childSessionKey}\nWrapper task ID: ${prior.wrapperTaskId}\nTimeout seconds: ${prior.timeoutSeconds}\nBackend: ${prior.backend}\nAcceptance comment ID: ${prior.commentId}\n<!-- /current-attempt -->`;
      const receipts = (card.metadata?.comments ?? []).filter(
        (value) => value.id === prior.commentId,
      );
      if (receipts.length !== 1) throw Error('Ambiguous prior acceptance');
      const accepted = currentAttempt({
        ...card,
        notes,
        events: [],
        metadata: { comments: receipts },
      });
      if (
        !accepted ||
        accepted.uncertain ||
        !accepted.taskId ||
        !accepted.wrapperTaskId ||
        !accepted.commentId
      )
        throw Error('Prior acceptance archive uncertain');
      return { ...archive, commentId: comment.id };
    });
  if (new Set(archives.map((archive) => archive.next.attempt)).size !== archives.length)
    throw Error('Duplicate attempt archive');
  for (const archive of archives) {
    if (archive.prior.reconciliationId) {
      if (
        !archives.some(
          (previous) =>
            previous.commentId === archive.prior.reconciliationId &&
            previous.next.attempt === archive.next.attempt - 1 &&
            [
              'baseSha',
              'worktree',
              'branch',
              'remaining',
              'taskName',
              'profileId',
              'model',
              'thinking',
              'timeoutSeconds',
            ].every((key) => previous.next[key] === archive.prior[key]),
        )
      )
        throw Error('Missing archive lineage');
    } else if (archives.some((previous) => previous.next.attempt < archive.next.attempt))
      throw Error('Missing archive lineage');
  }
  return archives;
}

export function currentAttempt(card) {
  const notes = typeof card.notes === 'string' ? card.notes : '';
  const begin = '<!-- current-attempt -->',
    end = '<!-- /current-attempt -->',
    parts = notes.split(begin);
  if (parts.length === 1) {
    const history = JSON.stringify(
      (card.metadata?.comments ?? []).filter((comment) => !handoffComment(card, comment)),
    );
    return /attempt|task[ -]?id|run[ -]?id|child[ -]?session|task name/i.test(notes + history)
      ? { uncertain: true }
      : null;
  }
  if (parts.length !== 2 || parts[1].split(end).length !== 2 || parts[0].includes(end))
    return { uncertain: true };
  const fields = {},
    allowed = [
      'Delegated attempt',
      'Task name',
      'Profile ID',
      'Model',
      'Thinking',
      'Task ID',
      'Run ID',
      'Child session',
      'Wrapper task ID',
      'Timeout seconds',
      'Backend',
      'Acceptance comment ID',
    ];
  for (const line of parts[1].split(end)[0].trim().split('\n')) {
    const split = line.indexOf(': '),
      key = line.slice(0, split),
      value = line.slice(split + 2);
    if (split < 0 || !allowed.includes(key) || Object.hasOwn(fields, key))
      return { uncertain: true };
    fields[key] = value;
  }
  if (
    !allowed.slice(0, 11).every((key) => Object.hasOwn(fields, key)) ||
    !new RegExp(`^${card.id}-a[1-9][0-9]{0,5}$`).test(fields['Delegated attempt']) ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(fields['Task name']) ||
    !/^[a-z][a-z0-9_-]{0,31}$/.test(fields['Profile ID']) ||
    !fields.Model?.trim() ||
    fields.Model.length > 160 ||
    !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(
      fields.Thinking,
    ) ||
    fields.Backend !== 'acpx' ||
    !/^[1-9][0-9]{0,3}$/.test(fields['Timeout seconds']) ||
    Number(fields['Timeout seconds']) > 1800
  )
    return { uncertain: true };
  const result = {
    attempt: fields['Delegated attempt'],
    taskName: fields['Task name'],
    profileId: fields['Profile ID'],
    model: fields.Model,
    thinking: fields.Thinking,
    timeoutSeconds: Number(fields['Timeout seconds']),
    backend: 'acpx',
  };
  for (const [key, name] of [
    ['Task ID', 'taskId'],
    ['Run ID', 'runId'],
    ['Wrapper task ID', 'wrapperTaskId'],
  ]) {
    if (fields[key] === 'unresolved acceptance') continue;
    if (!UUID.test(fields[key])) return { uncertain: true };
    result[name] = fields[key];
  }
  if (fields['Child session'] !== 'unresolved acceptance') {
    const id = fields['Child session'].split(':').at(-1),
      { workerAgentId, workerRuntime } = topology();
    if (
      fields['Child session'] !== `agent:${workerAgentId}:${workerRuntime}:${id}` ||
      !UUID.test(id)
    )
      return { uncertain: true };
    result.childSessionKey = fields['Child session'];
  }
  if (result.taskId === result.wrapperTaskId && result.taskId) return { uncertain: true };
  let archives = [];
  const reconciliation = notes
    .split('\n')
    .filter((line) => line.startsWith('Attempt reconciliation:'));
  if (reconciliation.length) {
    try {
      if (reconciliation.length !== 1) throw Error('Duplicate reconciliation');
      archives = reconciledAttempts(card);
      const archive = archives.find(
        (value) => `Attempt reconciliation: ${value.commentId}` === reconciliation[0],
      );
      if (
        !archive ||
        result.attempt !== `${card.id}-a${archive.next.attempt}` ||
        result.taskName !== archive.next.taskName ||
        result.profileId !== archive.next.profileId ||
        result.model !== archive.next.model ||
        result.thinking !== archive.next.thinking ||
        result.timeoutSeconds !== archive.next.timeoutSeconds
      )
        throw Error('Current reconciliation mismatch');
      for (const [key, name] of [
        ['Immutable base', 'baseSha'],
        ['Worktree', 'worktree'],
        ['Branch', 'branch'],
        ['Remaining assignment', 'remaining'],
      ]) {
        const lines = notes.split('\n').filter((line) => line.startsWith(`${key}: `));
        if (lines.length !== 1 || lines[0] !== `${key}: ${archive.next[name]}`)
          throw Error('Current assignment mismatch');
      }
      result.reconciliationId = archive.commentId;
    } catch {
      return { uncertain: true };
    }
  } else if (
    Number(result.attempt.split('-a').at(-1)) > 1 &&
    (!result.taskId ||
      !result.wrapperTaskId ||
      !result.runId ||
      !result.childSessionKey ||
      !UUID.test(fields['Acceptance comment ID'] ?? ''))
  )
    return { uncertain: true };
  if (
    fields['Acceptance comment ID'] &&
    fields['Acceptance comment ID'] !== 'unresolved acceptance'
  ) {
    if (!UUID.test(fields['Acceptance comment ID'])) return { uncertain: true };
    const receipts =
        card.metadata?.comments?.filter(
          (comment) => comment.id === fields['Acceptance comment ID'],
        ) ?? [],
      receipt = receipts[0];
    const expected = `Accepted delegation ${result.attempt}: ${JSON.stringify({ taskId: result.taskId, wrapperTaskId: result.wrapperTaskId, runId: result.runId, childSessionKey: result.childSessionKey })}`;
    if (
      receipts.length !== 1 ||
      receipt?.body !== expected ||
      card.metadata.comments.filter((comment) =>
        comment.body?.startsWith(`Accepted delegation ${result.attempt}: `),
      ).length !== 1 ||
      card.metadata.comments.some(
        (comment) =>
          comment.createdAt > receipt.createdAt &&
          comment.body?.startsWith('Accepted delegation ') &&
          comment.body !== expected,
      )
    )
      return { uncertain: true };
    result.commentId = receipt.id;
    return result;
  }
  const specifiedAt = Math.max(
    0,
    ...(card.events ?? []).filter((event) => event.kind === 'specified').map((event) => event.at),
  );
  if (
    specifiedAt &&
    card.metadata?.comments?.some(
      (comment) =>
        comment.createdAt > specifiedAt &&
        !handoffComment(card, comment) &&
        !archives.some(
          (archive) => archive.commentId === comment.id || archive.prior.commentId === comment.id,
        ) &&
        /attempt|task[ -]?id|run[ -]?id|child[ -]?session/i.test(comment.body ?? ''),
    )
  )
    return { uncertain: true };
  return result;
}
