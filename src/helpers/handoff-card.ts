import assert from 'node:assert/strict';
import { pageCards } from './workboard-page.js';
import { assertNoNativeCardLinks, controllerKey, projectIdentity, isManagerActor, currentAttempt, deliverySource, handoffComment, handoffEvidencePending, handoffHeld, handoffMarker, reconciledAttempts } from './record-contracts.js';
import { topology } from '../topology.js';
export { deliverySource, handoffComment, handoffEvidencePending, handoffHeld, handoffMarker } from './record-contracts.js';

const uuid = x => typeof x === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(x);
const bounded = x => typeof x === 'string' && x.trim() && x.length <= 1400;
const kind = c => /^Type: (feature|work[ -]item)$/mi.exec(c.notes ?? '')?.[1]?.toLowerCase();
const sourcePattern = /^channel=([a-z][a-z0-9_-]*);account=([A-Za-z0-9._:@%+-]+);recipient=([A-Za-z0-9._:@%+-]+);thread=([A-Za-z0-9._:@%+-]+)$/;

export function assertCommentCapacity(card, additions = [], future = []) {
  // Native metadata is limited to 24576 UTF-8 JSON bytes. Trimming would evict
  // proof/artifacts before comments, so never rely on the mutation's readback.
  const entry = body => ({id:'00000000-0000-4000-8000-000000000000',body,createdAt:Number.MAX_SAFE_INTEGER});
  const metadata = {...card.metadata};
  if (metadata.claim && !metadata.claim.token) metadata.claim = {...metadata.claim,token:'\u0000'.repeat(160)}; // Gateway redacts the native bounded token.
  if (additions.length || future.length) metadata.comments = [...metadata.comments ?? [],...additions.map(entry),...future.map(f => entry(f.body))];
  assert((metadata.comments ?? []).length <= 50, 'Native comment capacity must preserve retained evidence and remaining phases');
  let bytes = Buffer.byteLength(JSON.stringify(metadata));
  for (const f of future) {
    assert(f.body.length <= 2000 && Number.isInteger(f.textLimit) && f.textLimit >= 0);
    // f.body is the fixed JSON envelope with unknown bounded text fields empty.
    // After both JSON encodings, variable text uses at most 3 bytes per encoded
    // code unit, and at most encoded units + 2 * original UTF-16 units.
    const room = Math.min(2000 - f.body.length, 6 * f.textLimit);
    bytes += Math.min(3 * room, room + 2 * f.textLimit);
  }
  assert(bytes <= 24576, 'Native metadata byte capacity would evict retained evidence; reconcile before mutation');
  return bytes;
}

export async function settledWorkers(cards, affected, rpc, maxLookups = 48) {
  const { engineeringAgentId, workerAgentId, workerRuntime } = topology();
  assert(Number.isInteger(maxLookups) && maxLookups > 0 && maxLookups <= 48);
  assert(affected.length <= 21 && affected.every(c => Number.isFinite(c.createdAt)), 'Bounded card lifetime required');
  if (!affected.length) return;
  const cutoff = Math.min(...affected.map(c => c.createdAt));
  const controller = controllerKey(cards, affected[0]);
  assert(affected.every(c=>controllerKey(cards,c)===controller),'Settlement must be Feature scoped');
  // Installed tasks.list orders by updatedAt descending (taskId ascending ties).
  // A strict older-than-creation boundary proves the entire relevant lifetime.
  const snapshot = await rpc('tasks.list', {sessionKey:controller,sortBy:'updatedAt',limit:500});
  assert(Array.isArray(snapshot.tasks) && snapshot.tasks.length <= 500 && new Set(snapshot.tasks.map(t => t.taskId)).size === snapshot.tasks.length, 'Invalid task window');
  assert(snapshot.tasks.every((t,i,a) => uuid(t.taskId) && Number.isFinite(t.createdAt) && Number.isFinite(t.updatedAt) && t.createdAt <= t.updatedAt && (!i || a[i-1].updatedAt > t.updatedAt || (a[i-1].updatedAt === t.updatedAt && a[i-1].taskId < t.taskId))), 'Task window ordering uncertain');
  assert(!snapshot.nextCursor || snapshot.tasks.at(-1)?.updatedAt < cutoff, 'Relevant task window incomplete; reconcile externally');
  const bindings = affected.flatMap(item => {
    assert(item.agentId === engineeringAgentId && !item.metadata?.claim && !item.execution && !item.sessionKey && !item.runId && !item.taskId, 'Affected worker must be released');
    assert(kind(item) !== 'feature' || !item.notes.includes('<!-- current-attempt -->'), 'Feature cannot own a worker attempt');
    const a = kind(item) === 'feature' ? null : currentAttempt(item);
    if (!a) { assert(kind(item) === 'feature' || !['running','review'].includes(item.status), 'Ambiguous worker'); return []; }
    assert(!a.uncertain && a.taskId && a.wrapperTaskId && a.commentId, 'Unresolved spawn must reconcile');
    assert(!cards.some(x => x.id !== item.id && currentAttempt(x)?.runId === a.runId), 'Ambiguous worker identity');
    return [a,...reconciledAttempts(item).map(x => x.prior)];
  });
  const unique = [...new Map(bindings.map(a => [a.taskId,a])).values()];
  assert(unique.length <= 20, 'Settlement history bound exceeded');
  const known = new Set(unique.flatMap(a => [a.taskId,a.wrapperTaskId]));
  const elsewhere = cards.filter(c => !affected.some(item => item.id === c.id) && /^Type: work[ -]item$/mi.test(c.notes ?? '') && (c.notes.match(/^Type:/gmi) ?? []).length === 1 && uuid(c.metadata?.automation?.tenant) && c.notes.split('\n').filter(l => l === `Feature: ${c.metadata.automation.tenant}`).length === 1).map(currentAttempt).filter(a => a && !a.uncertain && a.taskId && a.wrapperTaskId && a.runId && a.childSessionKey);
  assert(!unique.some(a => elsewhere.some(other => other.runId === a.runId)), 'Ambiguous archived worker identity');
  const unknown = snapshot.tasks.filter(t => t.updatedAt >= cutoff && [workerRuntime,'subagent'].includes(t.runtime) && !known.has(t.taskId) && !elsewhere.some(a => ((a.taskId === t.taskId && t.runtime === workerRuntime) || (a.wrapperTaskId === t.taskId && t.runtime === 'subagent')) && t.agentId === workerAgentId && t.runId === a.runId && t.childSessionKey === a.childSessionKey && t.ownerKey === controller && t.sessionKey === t.ownerKey));
  assert(unknown.length + known.size <= maxLookups, 'Relevant task inspection bound exceeded');
  // tasks.get exposes sanitized text, not complete provenance: it can truncate
  // at 4000 characters or silently strip internal sections containing card IDs.
  assert.equal(unknown.length, 0, 'Unbound worker scope must reconcile; sanitized prompts cannot prove unrelated scope');
  if (!unique.length) return;
  const sessions = await rpc('sessions.list', {agentId:workerAgentId,limit:100,archived:'all'});
  assert(Array.isArray(sessions.sessions) && !sessions.hasMore, 'Worker session enumeration incomplete');
  for (const a of unique) {
    const s = sessions.sessions.filter(x => x.key === a.childSessionKey);
    // Native omits the descendant flag when no display run or descendant exists.
    // The live aggregate must still explicitly report inactive.
    assert(s.length === 1 && s[0].hasActiveRun === false && [false,undefined].includes(s[0].hasActiveSubagentRun) && (!s[0].lastRunId || s[0].lastRunId === a.runId), 'Worker session not settled');
    for (const [taskId,runtime] of [[a.taskId,workerRuntime],[a.wrapperTaskId,'subagent']]) {
      const t = (await rpc('tasks.get', {taskId})).task;
      assert(t?.taskId === taskId && t.runtime === runtime && t.agentId === workerAgentId && t.ownerKey === controller && t.sessionKey === t.ownerKey && t.runId === a.runId && t.childSessionKey === a.childSessionKey && ['completed','succeeded','failed','lost','timed_out','cancelled'].includes(t.status) && Number.isFinite(t.createdAt) && Number.isFinite(t.endedAt) && t.endedAt >= t.createdAt, 'Worker task not reconciled terminal');
    }
  }
}

// Caller is the canonical manager, not an authentication boundary. Evidence records
// actual native/channel observations; this helper never sends or executes work.
export async function handoffCard(operation, p, rpc) {
  const { productAgentId, engineeringAgentId, sessionNamespace } = topology();
  assert(['handoff','handoff-receipt','handoff-answer','handoff-correlated-answer','handoff-confirm','handoff-product-decision','handoff-apply','handoff-resolve-internal'].includes(operation));
  const allowed = ['boardId','id','checkpoint','actor', ...(operation === 'handoff' ? ['reason','question','resolution'] : operation === 'handoff-receipt' ? ['delivery','channel','message'] : operation === 'handoff-answer' ? ['channel','replyTo','message','answer'] : operation === 'handoff-correlated-answer' ? ['channel','questionMessage','message','answer'] : operation === 'handoff-confirm' ? ['channel','previousMessage','message','answer','decision'] : operation === 'handoff-product-decision' ? ['decision','evidence'] : ['application','replacementRequired'])];
  assert(p && Object.keys(p).every(k => allowed.includes(k)) && uuid(p.id) && uuid(p.checkpoint));
  if (operation === 'handoff-confirm') {
    assert.equal(Object.keys(p).sort().join(','), allowed.sort().join(','), 'Exact adjacent confirmation input required');
    assert.equal(p.decision, 'affirm', 'Adjacent confirmation must be affirmative');
  }
  assert(typeof p.boardId === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(p.boardId) && p.boardId !== 'default', 'Explicit product board required');
  const read = async () => {
    const s = await rpc('workboard.cards.list', { boardId: p.boardId });
    pageCards(s, { boardId: p.boardId, includeArchived: true });
    const c = s.cards.find(x => x.id === p.id);
    assert(c && kind(c) && (c.notes.match(/^Type:/gmi) ?? []).length === 1 && !c.metadata?.archivedAt, 'Existing Feature or Work item required');
    assertNoNativeCardLinks(c);
    assert(!c.execution && !c.sessionKey && !c.runId && !c.taskId && !c.metadata?.claim, 'Release manager claim before human wait');
    return { cards: s.cards, c };
  };
  let { cards, c } = await read();
  const engineering = ['handoff','handoff-apply','handoff-resolve-internal'].includes(operation);
  assert(engineering ? p.actor === controllerKey(cards,c) : isManagerActor(p.actor,productAgentId), 'Correct manager context required');
  let h = handoffMarker(c);
  assert(!h?.uncertain, 'Malformed handoff checkpoint');
  const original = JSON.stringify(c);
  const parentId = kind(c) === 'feature' ? c.id : c.metadata?.automation?.tenant;
  const scope = () => JSON.stringify(cards.filter(x => x.id !== c.id && (x.id === parentId || (kind(c) === 'feature' && x.metadata?.automation?.tenant === c.id))).sort((a,b) => a.id.localeCompare(b.id)));
  const originalScope = scope();
  const guard = () => {
    const parent = cards.find(x => x.id === parentId);
    assert(parent && /^Type: feature$/mi.test(parent.notes ?? '') && parent.status !== 'done' && !parent.metadata?.archivedAt, 'Terminal or missing parent');
    assertNoNativeCardLinks(parent);
    if (operation === 'handoff-apply' && parent.id !== c.id) assert(parent.agentId === engineeringAgentId && !handoffHeld(parent) && !parent.labels?.includes('user-held') && ['todo','ready','running','review'].includes(parent.status) && !/^Wait:/m.test(parent.notes), 'Parent held');
    if (parent.id !== c.id) assert(c.notes.split('\n').filter(x => x === `Feature: ${parent.id}`).length === 1);
    assert(!cards.some(x => [parentId, c.id].includes(x.metadata?.automation?.tenant) && x.status !== 'done' && /^Type: action$/mi.test(x.notes ?? '')), 'Pending decision/stop/intervention');
    assert(c.status !== 'done', 'Terminal cancellation preserves handoff; never resume');
    if (h && h.phase !== 'applied') assert.equal(deliverySource(cards,c),JSON.parse(c.metadata.comments.find(x => x.id === h.question).body).data.source, 'Retained delivery source changed');
  };
  guard();
  let data, next;
  if (operation === 'handoff') {
    assert(['product-question','product-suggestion','engineering-question','retained-user-decision','operational-blocker'].includes(p.reason) && bounded(p.question) && bounded(p.resolution));
    data = { reason: p.reason, question: p.question, resolution: p.resolution, source:deliverySource(cards,c), ...(projectIdentity(cards,c)?{routing:'project'}:{}) };
    if (h?.checkpoint === p.checkpoint) {
      const e = JSON.parse(c.metadata.comments.find(x => x.id === h.question).body);
      assert.deepEqual(e.data, data, 'Checkpoint payload mismatch');
      const pending = handoffEvidencePending(c,h);
      return { id: c.id, ...h, reused: true, reconciliationRequired: pending, sendRequired: h.phase === 'needs-message' && !pending };
    }
     assert(!h || ['applied','resolved-internally'].includes(h.phase), 'Unresolved previous handoff');
    assert(c.agentId === engineeringAgentId, 'Engineering owner required');
    const recoveredQuestions = (c.metadata.comments ?? []).filter(x => {
      const e = handoffComment(c,x);
      return e?.checkpoint === p.checkpoint && e.kind === 'question' && JSON.stringify(e.data) === JSON.stringify(data);
    }).length;
    assert(recoveredQuestions <= 1 && (c.metadata.comments ?? []).length - recoveredQuestions <= 45, 'Native comment capacity must preserve existing evidence and all handoff phases');
    assert(!c.metadata.comments?.some(x => { try { return JSON.parse(x.body).checkpoint === p.checkpoint && JSON.parse(x.body).kind !== 'question'; } catch { return false; } }), 'Stale checkpoint');
    const affected = kind(c) === 'feature' ? [c,...cards.filter(x => x.metadata?.automation?.tenant === c.id && /^Type: work[ -]item$/mi.test(x.notes ?? ''))] : [c];
    await settledWorkers(cards,affected,rpc);
    next = { checkpoint: p.checkpoint, phase: 'needs-message' };
  } else {
    assert(h?.checkpoint === p.checkpoint, 'Stale or missing checkpoint');
    if ((operation === 'handoff-apply' && h.phase === 'applied') || (operation==='handoff-resolve-internal'&&h.phase==='resolved-internally')) {
      assert(c.agentId === engineeringAgentId);
      assert.deepEqual(JSON.parse(c.metadata.comments.find(x => x.id === h.application).body).data, { application:p.application,replacementRequired:p.replacementRequired });
      return { id:c.id,...h,reused:true,sendRequired:false,replacementPreparationRequired:p.replacementRequired,executionAuthorized:false };
    }
    if(operation==='handoff-product-decision'&&h.phase==='answer-ready') {
      assert(c.agentId===engineeringAgentId&&!h.receipt);
      assert.deepEqual(JSON.parse(c.metadata.comments.find(x=>x.id===h.answer).body).data,{correlation:'product-agent-decision',decision:p.decision,evidence:p.evidence});
      return {id:c.id,...h,reused:true,sendRequired:false,replacementPreparationRequired:false,executionAuthorized:false};
    }
    assert(c.status === 'blocked', 'Handoff must remain blocked');
    if(operation==='handoff-resolve-internal') {
      const question=JSON.parse(c.metadata.comments.find(x=>x.id===h.question).body).data;
      assert(question.reason==='operational-blocker'&&!h.answer&&['needs-message','uncertain','sent'].includes(h.phase)&&c.agentId===productAgentId,'Only an operational blocker can resolve without a product answer');
      assert(bounded(p.application)&&typeof p.replacementRequired==='boolean','Concrete internal resolution evidence required');
      const affected=kind(c)==='feature'?[c,...cards.filter(x=>x.metadata?.automation?.tenant===c.id&&/^Type: work[ -]item$/mi.test(x.notes??''))]:[c];
      await settledWorkers(cards,affected.map(x=>({...x,agentId:engineeringAgentId})),rpc);
      if(p.replacementRequired){const a=currentAttempt(c);assert(kind(c)!=='feature'&&a&&!a.uncertain&&a.taskId&&a.wrapperTaskId,'Replacement requires exact accepted execution');}
      data={application:p.application,replacementRequired:p.replacementRequired};next={...h,phase:'resolved-internally'};
    } else if(operation==='handoff-product-decision') {
      const question=JSON.parse(c.metadata.comments.find(x=>x.id===h.question).body).data;
      assert(['product-question','product-suggestion'].includes(question.reason)&&h.phase==='needs-message'&&c.agentId===productAgentId&&!h.receipt&&!h.answer,'Only an undelivered product question or suggestion can use a product-agent decision');
      assert(bounded(p.decision)&&bounded(p.evidence),'Jarvis decision and durable evidence required');
      data={correlation:'product-agent-decision',decision:p.decision,evidence:p.evidence};next={...h,phase:'answer-ready'};
    } else if (operation === 'handoff-receipt') {
      assert(c.agentId === productAgentId && ['needs-message','uncertain','sent'].includes(h.phase));
      assert(['sent','uncertain'].includes(p.delivery) && bounded(p.channel) && (bounded(p.message) || (p.delivery === 'uncertain' && p.message === undefined)), 'Actual source receipt required');
      const question=JSON.parse(c.metadata.comments.find(x => x.id === h.question).body).data;
      assert(question.routing==='project'?sourcePattern.test(p.channel):p.channel===question.source, 'Receipt source mismatch');
      data = { delivery: p.delivery, channel: p.channel, ...(p.message !== undefined ? {message:p.message} : {}) };
      next = { ...h, phase: p.delivery };
    } else if (['handoff-answer','handoff-correlated-answer','handoff-confirm'].includes(operation)) {
      assert(['sent','answer-ready'].includes(h.phase) && c.agentId === (h.phase === 'sent' ? productAgentId : engineeringAgentId));
      const receipt = JSON.parse(c.metadata.comments.find(x => x.id === h.receipt).body).data;
      if(operation === 'handoff-correlated-answer') {
        assert(receipt.delivery==='sent' && p.questionMessage===receipt.message && sourcePattern.test(p.channel) && bounded(p.message) && bounded(p.answer),'Explicit checkpoint and actual answer source required');
        data={correlation:'explicit-project-answer',channel:p.channel,questionMessage:p.questionMessage,message:p.message,answer:p.answer};
      } else if (operation === 'handoff-answer') {
        assert(receipt.delivery === 'sent' && p.channel === receipt.channel && p.replyTo === receipt.message && bounded(p.message) && p.message !== p.replyTo && bounded(p.answer), 'Exact source reply correlation required');
        data = { channel: p.channel, replyTo: p.replyTo, message: p.message, answer: p.answer };
      } else {
        assert(receipt.delivery === 'sent' && p.channel === receipt.channel && p.previousMessage === receipt.message && bounded(p.message) && p.message !== p.previousMessage && bounded(p.answer), 'Exact adjacent confirmation correlation required');
        if (h.phase === 'sent') {
          const outstanding = cards.filter(candidate => {
            const marker = handoffMarker(candidate);
            if (marker?.phase !== 'sent' || candidate.agentId !== productAgentId || candidate.status !== 'blocked') return false;
            try { return deliverySource(cards,candidate) === p.channel; } catch { return false; }
          });
          assert(outstanding.length === 1 && outstanding[0].id === c.id, 'Exactly one outstanding sent handoff on source required');
        }
        data = { correlation:'adjacent-confirmation', channel:p.channel, previousMessage:p.previousMessage, message:p.message, answer:p.answer, decision:p.decision };
      }
      next = { ...h, phase: 'answer-ready' };
    } else {
      assert(c.agentId === engineeringAgentId && h.phase === 'answer-ready' && bounded(p.application) && typeof p.replacementRequired === 'boolean');
      if (p.replacementRequired) {
        const a = currentAttempt(c);
        assert(kind(c) !== 'feature' && a && !a.uncertain && a.taskId && a.wrapperTaskId && a.commentId, 'Replacement requires an accepted Work item attempt');
      }
      assert(!c.labels?.includes('user-held') && !/^Wait:/m.test(c.notes), 'Resolve independent holds first');
      data = { application: p.application, replacementRequired: p.replacementRequired };
      next = { ...h, phase: 'applied' };
    }
  }
  const evidenceKind = operation === 'handoff' ? 'question' : ['handoff-apply','handoff-resolve-internal'].includes(operation) ? 'application' : ['handoff-answer','handoff-correlated-answer','handoff-confirm','handoff-product-decision'].includes(operation) ? 'answer' : 'receipt';
  const body = JSON.stringify({ card: c.id, checkpoint: p.checkpoint, kind: evidenceKind, actor: p.actor, data });
  assert(body.length <= 2000, 'Handoff evidence exceeds native 2000-character comment limit');
  const prior = (c.metadata.comments ?? []).filter(x => { try { const e = JSON.parse(x.body); return e.checkpoint === p.checkpoint && e.kind === evidenceKind && !(evidenceKind === 'receipt' && p.delivery === 'sent' && e.data.delivery === 'uncertain' && e.data.channel === p.channel && (e.data.message === undefined || e.data.message === p.message)); } catch { return false; } });
  assert(prior.length <= 1 && (!prior.length || prior[0].body === body), 'Conflicting or duplicate handoff evidence');
  // Reserve the final marker before adding evidence. Detailed text stays in comments.
  const preserved = c.notes.replace(/^Handoff:.*\n?/gm, '').trimEnd();
  const maximumMarker = `\nHandoff: ${JSON.stringify({checkpoint:p.checkpoint,phase:'applied',question:p.checkpoint,receipt:p.checkpoint,answer:p.checkpoint,application:p.checkpoint})}`;
  assert(preserved.length + maximumMarker.length <= 4000, 'Handoff exceeds native notes capacity');
  ({ cards, c } = await read()); guard();
  assert.equal(JSON.stringify(c), original, 'Card changed during validation');
  assert.equal(scope(), originalScope, 'Affected scope changed during validation');
  const evidence = [...(c.metadata.comments ?? []).map(x => handoffComment(c,x)).filter(e => e?.checkpoint === p.checkpoint),{kind:evidenceKind,data}];
  const sent = evidence.find(e => e.kind === 'receipt' && e.data.delivery === 'sent');
  const uncertain = evidence.find(e => e.kind === 'receipt' && e.data.delivery === 'uncertain');
  const future = [];
  const actor = agentId => projectIdentity(cards,c) ? `agent:${agentId}:${sessionNamespace}:${parentId}` : `agent:${agentId}:main`;
  const reserve = (kind,data,textLimit,evidenceActor=actor(productAgentId)) => future.push({body:JSON.stringify({card:c.id,checkpoint:p.checkpoint,kind,actor:evidenceActor,data}),textLimit});
  const source = deliverySource(cards,c);
  if (!sent && !['handoff-resolve-internal','handoff-product-decision'].includes(operation)) {
    // An uncertainty receipt needs no invented message ID. Reserve that valid
    // minimal branch; a supplied optional ID is checked at its own write.
    if (!uncertain) reserve('receipt',{delivery:'uncertain',channel:source},0);
    reserve('receipt',{delivery:'sent',channel:source,message:uncertain?.data.message ?? ''},uncertain?.data.message === undefined ? 1400 : 0);
  }
  if (!['handoff-resolve-internal','handoff-product-decision'].includes(operation)&&!evidence.some(e => e.kind === 'answer')) reserve('answer',{correlation:'adjacent-confirmation',channel:source,previousMessage:sent?.data.message ?? uncertain?.data.message ?? '',message:'',answer:'',decision:'affirm'},2800 + (sent?.data.message === undefined && uncertain?.data.message === undefined ? 1400 : 0));
  if (!evidence.some(e => e.kind === 'application')) reserve('application',{application:'',replacementRequired:false},1400,actor(engineeringAgentId));
  assertCommentCapacity(c,prior.length ? [] : [body],future);
  if (!prior.length) {
    assert((c.metadata.comments ?? []).length < 50, 'Native comment capacity exhausted; preserve evidence');
    await rpc('workboard.cards.comment', { id: c.id, body });
  }
  const beforeComment = c;
  ({ cards, c } = await read()); guard();
  assert.equal(scope(), originalScope, 'Affected scope changed during comment');
  assert.equal(c.notes, beforeComment.notes); assert.equal(c.agentId, beforeComment.agentId); assert.equal(c.status, beforeComment.status);
  for (const [key,value] of Object.entries(beforeComment.metadata)) if (key !== 'comments') assert.deepEqual(c.metadata[key],value,'Retained metadata changed during comment');
  assert((beforeComment.metadata.comments ?? []).every(old => c.metadata.comments?.some(x => JSON.stringify(x) === JSON.stringify(old))), 'Native comment history changed or was evicted');
  assert.deepEqual(c.metadata.proof,beforeComment.metadata.proof, 'Proof changed during comment');
  assert.equal(c.metadata.failureCount,beforeComment.metadata.failureCount, 'Failure history changed during comment');
  const receipts = (c.metadata.comments ?? []).filter(x => x.body === body);
  assert(receipts.length === 1 && uuid(receipts[0].id), 'Ambiguous native comment');
  next[evidenceKind] = receipts[0].id;
  const notes = `${preserved}\nHandoff: ${JSON.stringify(next)}`;
  const patch = { notes, status: ['applied','resolved-internally'].includes(next.phase) ? 'todo' : 'blocked', agentId: ['answer-ready','applied','resolved-internally'].includes(next.phase) ? engineeringAgentId : productAgentId };
  if (notes !== c.notes || patch.agentId !== c.agentId || patch.status !== c.status) await rpc('workboard.cards.update', { id: c.id, expectedUpdatedAt: c.updatedAt, patch });
  ({ cards, c } = await read()); guard();
  assert.equal(scope(), originalScope, 'Affected scope changed during mutation');
  assert.equal(c.notes, notes); assert.equal(c.status, patch.status); assert.equal(c.agentId, patch.agentId);
  assert.deepEqual(handoffMarker(c),next, 'Retained handoff evidence invalid');
  for (const [key,value] of Object.entries(beforeComment.metadata)) if (!['comments','lifecycleStatusSourceUpdatedAt'].includes(key)) assert.deepEqual(c.metadata[key],value,'Retained metadata evidence changed');
  assert.deepEqual(c.metadata.automation,beforeComment.metadata.automation, 'Native identity changed');
  assert.deepEqual(c.metadata.proof,beforeComment.metadata.proof, 'Retained proof changed');
  assert.equal(c.metadata.failureCount,beforeComment.metadata.failureCount, 'Retained failures changed');
  if (kind(c) !== 'feature') assert.deepEqual(currentAttempt(c),currentAttempt(beforeComment), 'Retained attempt changed');
  return { id: c.id, ...next, sendRequired: next.phase === 'needs-message', replacementPreparationRequired:['handoff-apply','handoff-resolve-internal'].includes(operation) && p.replacementRequired, executionAuthorized:false };
}

const HANDOFF_ERRORS = {
  'invalid-input':'The handoff request is invalid.',
  'native-link':'A relevant card has unsupported native linkage.',
  'incomplete-read':'The complete board could not be safely read.',
  'state-conflict':'The handoff conflicts with durable state.',
  'capacity':'The handoff cannot preserve all required evidence.',
  operation:'The handoff operation is unsupported.',
  'validation-failed':'Handoff validation failed; native state was not safely reconciled.',
};

export function handoffError(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  let code = 'validation-failed';
  if (error instanceof SyntaxError) code = 'invalid-input';
  else if (/Use a handoff operation|Unsupported handoff operation/.test(message)) code = 'operation';
  else if (/Native (?:createdByCardId|dependency links).*forbidden|Unexpected native execution linkage/.test(message)) code = 'native-link';
  else if (/Incomplete native response|enumeration changed|truncated|board scope mismatch|Missing board total|Unknown board|Invalid native board totals/.test(message)) code = 'incomplete-read';
  else if (/capacity|exceeds native|preserve retained evidence/i.test(message)) code = 'capacity';
  else if (/mismatch|changed|Stale|missing checkpoint|Unresolved|Conflicting|Duplicate|Terminal|owner|required|correlation|source|Handoff must remain blocked|Exactly one outstanding/.test(message)) code = 'state-conflict';
  else if (error?.code === 'ERR_ASSERTION' && /Invalid|Exact adjacent|must be affirmative|Canonical manager|Explicit product board|Existing Feature or Work item/.test(message)) code = 'invalid-input';
  return {complete:false,code,error:HANDOFF_ERRORS[code]};
}
