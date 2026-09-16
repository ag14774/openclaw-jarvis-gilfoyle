import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {ensureCreatedCard,sealCreationPayload} from './create-card.js';
import {pageCards} from './workboard-page.js';
import {controllerKey,handoffHeld} from './record-contracts.js';
import {topology} from '../topology.js';

// Read-only report closure: native obligations and actual unchanged Git evidence,
// without manufacturing an implementation/review or pushing an unchanged commit.
export async function finishReport(p,rpc,git=(cwd,args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',timeout:10000}).trim()){
  const {productAgentId,engineeringAgentId,workerRuntime}=topology();
  assert(p&&Object.keys(p).sort().join(',')==='boardId,evidence,id,sha,summary');
  assert(/^[0-9a-f-]{36}$/.test(p.id)&&/^[0-9a-f]{40}$/.test(p.sha));
  assert([p.summary,p.evidence].every(s=>typeof s==='string'&&s.trim()&&s.length<=1000&&!/[\r\n]/.test(s)));
  const read=async()=>{const r=await rpc('workboard.cards.list',{boardId:p.boardId});pageCards(r,{boardId:p.boardId,includeArchived:true});return r.cards;};
  let cards=await read(),c=cards.find(c=>c.id===p.id);assert(c&&/^Type: feature$/m.test(c.notes)&&c.agentId===engineeringAgentId&&!handoffHeld(c));
  const info=cards.find(c=>c.metadata?.automation?.idempotencyKey===`project-info:${p.boardId}`);assert(info);
  const checkout=/^Checkout: (.+)$/m.exec(info.notes)?.[1];assert(checkout);
  assert(/read.only|report|test status|audit/i.test(c.notes),'Feature must authorize a read-only report');
  assert.equal(git(checkout,['rev-parse','HEAD']),p.sha);assert.equal(git(checkout,['status','--porcelain']),'','Report must preserve a clean checkout');
  const key=`action:${p.id}:owner-notification`,children=cards.filter(x=>x.metadata?.automation?.tenant===p.id&&x.metadata.automation.idempotencyKey!==key);assert(children.every(c=>c.status==='done'),'Report has unfinished children or stops');
  const active=await rpc('tasks.list',{sessionKey:controllerKey(cards,c),status:['queued','running'],limit:100});assert(!active.nextCursor&&!active.tasks.some(t=>[workerRuntime,'subagent'].includes(t.runtime)),'Report execution not settled');
  const delivery=/^Delivery: (.+)$/m.exec(c.notes)?.[1];assert(delivery);
  const notice=sealCreationPayload({boardId:p.boardId,tenant:c.id,idempotencyKey:key,title:'Owner notification',agentId:engineeringAgentId,status:'todo',priority:'normal',labels:['type:action','owner-notification'],workspace:{kind:'scratch'},maxRuntimeSeconds:1,maxRetries:1,notes:`Type: action\nKind: owner-notification\nFeature: ${c.id}\nDelivery: ${delivery}\nSummary: ${p.summary}`});
  const created=await ensureCreatedCard(notice,rpc);
  if(c.status!=='done'){
    assert(c.metadata?.claim?.ownerId===engineeringAgentId&&c.metadata.claim.expiresAt>Date.now(),'Claim report Feature before closure');
    cards=await read();const fresh=cards.find(x=>x.id===c.id);assert.equal(fresh.updatedAt,c.updatedAt,'Report changed before completion');
    assert(cards.filter(x=>x.metadata?.automation?.tenant===c.id&&x.id!==created.card.id).every(x=>x.status==='done'),'New report stop/obligation');
    await rpc('workboard.cards.complete',{id:c.id,summary:`Outcome: delivered. Read-only report: ${p.summary}\nCandidate: ${p.sha}`,proof:{status:'passed',label:'Verified read-only report',note:`Candidate: ${p.sha}. Clean unchanged repository. ${p.evidence}`}});
  }
  cards=await read();c=cards.find(x=>x.id===p.id);assert(c.status==='done'&&c.metadata.automation.summary.includes(p.sha));
  const n=cards.find(x=>x.id===created.card.id);if(n.agentId===engineeringAgentId)await rpc('workboard.cards.update',{id:n.id,expectedUpdatedAt:n.updatedAt,patch:{agentId:productAgentId}});else assert(n.agentId===productAgentId);
  return {id:c.id,status:'finished',notificationId:n.id};
}
