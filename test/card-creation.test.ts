import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import './support/setup.ts';
import { createProductCard, creationError, ensureCreatedCard, sealCreationPayload } from '../src/helpers/create-card.ts';
import { classifyCards } from '../src/helpers/workboard-page.ts';
import {loadWorkboardTestInternals} from './support/openclaw-internals.ts';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const source = 'channel=internal-ui;account=local;recipient=owner;thread=none';
const featureInput = { boardId:'project', request:'request-1', sourceMessage:'request-message', title:'Requested feature', scope:'Deliver the requested behavior.', delivery:'current-source internal-ui', deliverySource:source };
const projectInput = {boardId:'project',name:'Quote desk',repository:'file:///tmp/quote.git',checkout:'/tmp/quote',integrationBranch:'main',productDocs:['README.md','docs/product.md'],architectureDocs:['docs/architecture.md'],readiness:'ready',evidence:'Repository and checkout verified.',requiredCI:[],scope:'Quote desk product delivery.'};
const bindingDigest=(boardId,cardId,binding)=>createHash('sha256').update(JSON.stringify([boardId,cardId,binding])).digest('hex');

function fixture(boardId='project',withInfo=true) {
  let tick=100, next=10, ambiguous=false;
  const cards=[{id:id(1),title:'Project information',status:'todo',labels:['type:project-info'],updatedAt:tick,notes:'TypeOnly',metadata:{automation:{boardId,tenant:`project:${boardId}`,idempotencyKey:`project-info:${boardId}`}}}];
  cards[0].notes='Type: project-info\nReadiness: ready';
  if(!withInfo)cards.length=0;
  const calls=[];
  const materialize=p=>({id:id(next++),title:p.title,status:p.status,priority:p.priority,labels:structuredClone(p.labels),agentId:p.agentId,notes:p.notes,createdAt:++tick,updatedAt:tick,metadata:{automation:{boardId:p.boardId,tenant:p.tenant,idempotencyKey:p.idempotencyKey,workspace:structuredClone(p.workspace),maxRuntimeSeconds:p.maxRuntimeSeconds,maxRetries:p.maxRetries}}});
  const rpc=async(method,p)=>{
    calls.push({method,p:structuredClone(p)});
    if(method==='workboard.cards.list')return structuredClone({cards,boards:[{id:boardId,total:cards.length}]});
    if(method==='workboard.cards.create'){
      assert(!['parents','createdByCardId','dependencies','metadata','execution','sessionKey','runId','taskId'].some(key=>Object.hasOwn(p,key)));
      const card=materialize(p);cards.push(card);
      if(ambiguous){ambiguous=false;throw Error('Ambiguous accepted create');}
      return {card:structuredClone(card)};
    }
    throw Error(`Unexpected RPC ${method}`);
  };
  return {cards,calls,rpc,failCreate:()=>{ambiguous=true;}};
}

async function feature(f) { return (await createProductCard('feature',featureInput,f.rpc)).card; }
const itemInput=(featureId,assignment='implementation',requires=[])=>({boardId:'project',featureId,assignment,title:'Implementation',scope:'Implement and test the requested behavior.',requires});
const reviewInput=(featureId,reviewKey='candidate-a',candidate='a'.repeat(40),requires=[])=>({boardId:'project',featureId,reviewKey,candidate,title:'Independent review',scope:'Review the exact candidate and report findings.',requires});

test('project-info creates exact unassigned local project payload',async()=>{
  const f=fixture('project',false),result=await createProductCard('project-info',projectInput,f.rpc),card=result.card,create=f.calls.find(call=>call.method==='workboard.cards.create').p;
  assert.equal(result.reused,false);assert.equal(card.title,'Quote desk project information');assert.equal(card.agentId,undefined);assert.equal(card.status,'todo');assert.deepEqual(card.labels,['type:project-info']);
  assert(!Object.hasOwn(result,'acknowledgementReady')&&!Object.hasOwn(result,'durable'));
  assert.equal(card.metadata.automation.tenant,'project:project');assert.equal(card.metadata.automation.idempotencyKey,'project-info:project');
  assert.deepEqual(Object.keys(create).sort(),['boardId','idempotencyKey','labels','maxRetries','maxRuntimeSeconds','notes','priority','status','tenant','title','workspace']);
  assert.match(card.notes,/^Required CI: \[\]$/m);assert.match(card.notes,/^Creation: sha256:[0-9a-f]{64}$/m);
});

test('project-info supports canonical GitHub CI and exact sealed reuse',async()=>{
  const f=fixture('project',false),input={...projectInput,repository:'https://github.com/owner/repo.git',requiredCI:[{path:'.github/workflows/test.yml',jobs:['test','lint']}]};
  await createProductCard('project-info',input,f.rpc);
  assert.equal((await createProductCard('project-info',input,f.rpc)).reused,true);assert.equal(f.calls.filter(call=>call.method==='workboard.cards.create').length,1);
  await assert.rejects(createProductCard('project-info',{...input,repository:'https://github.com/owner/other.git'},f.rpc),/payload mismatch/);
});

test('project-info rejects unsafe repositories, paths, readiness and CI before RPC',async()=>{
  const invalid=[
    {...projectInput,repository:'https://user:secret@github.com/owner/repo.git'},
    {...projectInput,repository:'file:/tmp/quote.git'},
    {...projectInput,checkout:'/tmp/../quote'},
    {...projectInput,productDocs:[]},
    {...projectInput,productDocs:['../README.md']},
    {...projectInput,architectureDocs:['/etc/passwd']},
    {...projectInput,readiness:'ready',evidence:''},
    {...projectInput,requiredCI:[{path:'.github/workflows/test.yml',jobs:['test']}]},
    {...projectInput,repository:'https://github.com/owner/repo.git',requiredCI:[]},
    {...projectInput,repository:'https://github.com/owner/repo',requiredCI:[{path:'.github/workflows/test.yml',jobs:['test']}]},
    {...projectInput,repository:'https://github.com/owner/repo.git',requiredCI:[{path:'../test.yml',jobs:['test']}]},
  ];
  for(const input of invalid){const f=fixture('project',false);await assert.rejects(createProductCard('project-info',input,f.rpc));assert.equal(f.calls.length,0);}
  const setup=fixture('project',false);assert.equal((await createProductCard('project-info',{...projectInput,readiness:'setup',evidence:'',productDocs:['README.md'],architectureDocs:[]},setup.rpc)).card.agentId,undefined);
});

test('Feature creation sends exact safe native arguments and persists board tenancy and delivery fields',async()=>{
  const f=fixture(),result=await createProductCard('feature',featureInput,f.rpc),card=result.card;
  assert.equal(result.reused,false);assert.equal(card.metadata.automation.tenant,'project');
  assert.equal(card.metadata.automation.idempotencyKey,'feature:project:internal-ui-request-message');
  assert.equal(card.agentId,'gilfoyle');assert.equal(card.status,'todo');assert.deepEqual(card.labels,['type:feature']);
  assert.match(card.notes,/^Source message: request-message$/m);assert.match(card.notes,new RegExp(`Delivery source: ${source}`));
  const create=f.calls.find(call=>call.method==='workboard.cards.create').p;
  assert.deepEqual(Object.keys(create).sort(),['agentId','boardId','idempotencyKey','labels','maxRetries','maxRuntimeSeconds','notes','priority','status','tenant','title','workspace']);
  assert.deepEqual(create.workspace,{kind:'scratch'});assert.equal(create.maxRuntimeSeconds,1);assert.equal(create.maxRetries,1);
  assert.equal(f.calls.filter(call=>call.method==='workboard.cards.list').length,2);
  assert.deepEqual({durable:result.durable,disposition:result.disposition,acknowledgementReady:result.acknowledgementReady,wakeMessage:result.wakeMessage},{durable:true,disposition:'created',acknowledgementReady:true,wakeMessage:`PROJECT WAKE\ncard: ${card.id}\nreason: new-feature`});
  assert.equal(result.wakeMessage.split('\n').length,3);
  assert(f.calls.findLastIndex(call=>call.method==='workboard.cards.list')>f.calls.findIndex(call=>call.method==='workboard.cards.create'));
  const reused=await createProductCard('feature',featureInput,f.rpc);
  assert.equal(reused.durable,true);assert.equal(reused.disposition,'reused');assert.equal(reused.acknowledgementReady,true);assert.equal(reused.wakeMessage,`PROJECT WAKE\ncard: ${card.id}\nreason: new-feature`);
});

test('Feature identity is deterministic and unique to the source channel message',async()=>{
  const f=fixture(),telegram={...featureInput,delivery:'Telegram default to 123456789',deliverySource:'channel=telegram;account=default;recipient=123456789;thread=none',sourceMessage:'1579'};
  const first=await createProductCard('feature',telegram,f.rpc),retry=await createProductCard('feature',telegram,f.rpc),second=await createProductCard('feature',{...telegram,sourceMessage:'1580'},f.rpc);
  assert.equal(first.card.metadata.automation.idempotencyKey,'feature:project:telegram-1579');
  assert.match(first.card.notes,/^Source message: 1579$/m);assert.equal(retry.card.id,first.card.id);assert.equal(retry.disposition,'reused');
  assert.equal(second.card.metadata.automation.idempotencyKey,'feature:project:telegram-1580');assert.notEqual(second.card.id,first.card.id);
  assert.equal(f.calls.filter(call=>call.method==='workboard.cards.create').length,2);
});

test('Feature creation always requires sourceMessage',async()=>{
  const input={...featureInput,request:'reset-quote',title:'Reset quote'};delete input.sourceMessage;
  const f=fixture();await assert.rejects(createProductCard('feature',input,f.rpc),/Invalid input schema/);assert.equal(f.calls.length,0);
});

test('Feature source-message validation is channel-specific and bounded',async()=>{
  for(const [deliverySource,sourceMessage,key] of [
    ['channel=discord;account=bot;recipient=owner;thread=none','123456789012345678','feature:project:discord-123456789012345678'],
    [source,id(70),`feature:project:internal-ui-${id(70)}`],
  ]){
    const f=fixture(),delivery=deliverySource.startsWith('channel=internal-ui;')?'current-source internal-ui':deliverySource,result=await createProductCard('feature',{...featureInput,delivery,deliverySource,sourceMessage},f.rpc);
    assert.equal(result.card.metadata.automation.idempotencyKey,key);
  }
  const invalid=[
    {...featureInput,delivery:'Telegram default to owner',deliverySource:'channel=telegram;account=default;recipient=owner;thread=none',sourceMessage:'0'},
    {...featureInput,delivery:'Telegram default to owner',deliverySource:'channel=telegram;account=default;recipient=owner;thread=none',sourceMessage:'01'},
    {...featureInput,delivery:'channel=discord;account=bot;recipient=owner;thread=none',deliverySource:'channel=discord;account=bot;recipient=owner;thread=none',sourceMessage:'not-decimal'},
    {...featureInput,sourceMessage:'bad:value'},
    {...featureInput,sourceMessage:'x'.repeat(101)},
  ];
  for(const input of invalid){const f=fixture();await assert.rejects(createProductCard('feature',input,f.rpc),/source message/);assert.equal(f.calls.length,0);}
});

test('Work item prerequisites are accepted same-Feature cards and remain textual only',async()=>{
  const f=fixture(),parent=await feature(f);
  const first=(await createProductCard('work-item',itemInput(parent.id,'parser'),f.rpc)).card;
  const second=(await createProductCard('work-item',itemInput(parent.id,'ui',[first.id]),f.rpc)).card;
  assert.equal(second.metadata.automation.tenant,parent.id);assert.match(second.notes,new RegExp(`Requires Work items: ${first.id}`));
  const create=f.calls.filter(call=>call.method==='workboard.cards.create').at(-1).p;
  assert(!Object.hasOwn(create,'parents'));assert(!Object.hasOwn(create,'metadata'));assert(!second.metadata.links);assert(!second.metadata.automation.createdByCardId);
  assert(!Object.hasOwn(await createProductCard('work-item',itemInput(parent.id,'ui',[first.id]),f.rpc),'acknowledgementReady'));
});

test('review creates an exact canonical reviewer and supports deterministic renewal',async()=>{
  const f=fixture(),parent=await feature(f),implementation=(await createProductCard('work-item',itemInput(parent.id),f.rpc)).card;
  const first=await createProductCard('review',reviewInput(parent.id,'candidate-a','a'.repeat(40),[implementation.id]),f.rpc),retry=await createProductCard('review',reviewInput(parent.id,'candidate-a','a'.repeat(40),[implementation.id]),f.rpc),renewed=await createProductCard('review',reviewInput(parent.id,'candidate-b','b'.repeat(40),[implementation.id]),f.rpc);
  assert.equal(first.card.metadata.automation.idempotencyKey,`work-item:${parent.id}:review-candidate-a`);assert.deepEqual(first.card.labels,['type:work-item','review']);
  assert.match(first.card.notes,/^Assignment: independent-review$/m);assert.match(first.card.notes,new RegExp(`^Candidate: ${'a'.repeat(40)}$`,'m'));assert.match(first.card.notes,new RegExp(`^Requires Work items: ${implementation.id}$`,'m'));
  assert.equal(retry.reused,true);assert.equal(retry.card.id,first.card.id);assert.notEqual(renewed.card.id,first.card.id);assert.equal(renewed.card.metadata.automation.idempotencyKey,`work-item:${parent.id}:review-candidate-b`);
  await assert.rejects(createProductCard('review',reviewInput(parent.id,'candidate-a','b'.repeat(40),[implementation.id]),f.rpc),/payload mismatch/);
  const stored=f.cards.find(card=>card.id===first.card.id);stored.notes=stored.notes.replace(/\nCreation: sha256:[0-9a-f]{64}$/,'');await assert.rejects(createProductCard('review',reviewInput(parent.id,'candidate-a','a'.repeat(40),[implementation.id]),f.rpc),error=>creationError(error).code==='identity-conflict');
  assert(!Object.hasOwn(first,'acknowledgementReady'));
});

test('generic Work-item creation cannot impersonate independent review',async()=>{
  for(const assignment of ['independent-review','independent-review-coverage']){
    const f=fixture(),parent=await feature(f),before=f.calls.length;
    await assert.rejects(createProductCard('work-item',itemInput(parent.id,assignment),f.rpc),/review operation/);assert.equal(f.calls.length,before);
  }
});

test('review rejects invalid identity and cannot adopt a malformed reviewer',async()=>{
  for(const input of [reviewInput(id(2),'Bad','a'.repeat(40)),reviewInput(id(2),'candidate-a','A'.repeat(40)),reviewInput(id(2),'candidate-a','a'.repeat(39))]){
    const f=fixture();await assert.rejects(createProductCard('review',input,f.rpc),/review identity/);assert.equal(f.calls.length,0);
  }
  const f=fixture(),parent=await feature(f),input=reviewInput(parent.id),expectedKey=`work-item:${parent.id}:review-candidate-a`;
  f.cards.push({id:id(88),title:input.title,agentId:'gilfoyle',status:'todo',priority:'normal',labels:['type:work-item'],updatedAt:1,notes:`Type: work-item\nFeature: ${parent.id}\nRequires Work items: none\nAssignment: independent-review\nCandidate: ${input.candidate}\nScope: ${input.scope}`,metadata:{automation:{boardId:'project',tenant:parent.id,idempotencyKey:expectedKey,workspace:{kind:'scratch'},maxRuntimeSeconds:1,maxRetries:1}}});
  const creates=f.calls.filter(call=>call.method==='workboard.cards.create').length;
  await assert.rejects(createProductCard('review',input,f.rpc),/payload mismatch|labels mismatch/);assert.equal(f.calls.filter(call=>call.method==='workboard.cards.create').length,creates);
});

test('invalid prerequisite membership and native dependency cycles fail without mutation',async()=>{
  const f=fixture(),parent=await feature(f),other={...structuredClone(parent),id:id(88),metadata:{automation:{...parent.metadata.automation,idempotencyKey:'feature:project:other'}}};f.cards.push(other);
  const foreign={id:id(89),title:'Foreign',agentId:'gilfoyle',status:'todo',updatedAt:200,notes:`Type: work-item\nFeature: ${other.id}\nRequires Work items: none`,metadata:{automation:{boardId:'project',tenant:other.id,idempotencyKey:`work-item:${other.id}:foreign`,workspace:{kind:'scratch'},maxRuntimeSeconds:1,maxRetries:1}}};f.cards.push(foreign);
  const before=f.cards.length,writes=()=>f.calls.filter(call=>call.method==='workboard.cards.create').length;
  const prior=writes();await assert.rejects(createProductCard('work-item',itemInput(parent.id,'bad',[foreign.id]),f.rpc),/prerequisites/);assert.equal(writes(),prior);assert.equal(f.cards.length,before);
  const cyclic=[90,91].map((n,index)=>({id:id(n),title:'Cyclic',agentId:'gilfoyle',status:'todo',updatedAt:200,notes:`Type: work-item\nFeature: ${parent.id}\nRequires Work items: ${id(index?90:91)}`,metadata:{automation:{boardId:'project',tenant:parent.id,idempotencyKey:`work-item:${parent.id}:cycle-${index}`}}}));
  f.cards.push(...cyclic);await assert.rejects(createProductCard('work-item',itemInput(parent.id,'safe',[id(90)]),f.rpc),/cycle/);f.cards.splice(-2);
  foreign.metadata.links=[{type:'parent',targetCardId:parent.id}];foreign.metadata.automation.createdByCardId=parent.id;
  assert.equal((await createProductCard('work-item',itemInput(parent.id,'safe'),f.rpc)).reused,false);
});

test('unrelated completed malformed native links do not block a new Feature and remain unchanged',async()=>{
  const f=fixture(),unrelated=[
    {id:'7b512000-0000-4000-8000-000000000001',title:'Legacy feature',agentId:'gilfoyle',status:'done',completedAt:2,updatedAt:2,notes:'Type: feature',metadata:{automation:{boardId:'project',tenant:'project',idempotencyKey:'feature:project:legacy',createdByCardId:id(77)}}},
    {id:'01649000-0000-4000-8000-000000000002',title:'Legacy action',agentId:'gilfoyle',status:'done',completedAt:3,updatedAt:3,notes:`Type: action\nKind: cancellation\nFeature: ${id(77)}`,metadata:{automation:{boardId:'project',tenant:id(77),idempotencyKey:`action:${id(77)}:cancellation`},links:[{type:'parent',targetCardId:id(77)}]}},
  ];
  f.cards.push(...unrelated);const before=structuredClone(unrelated),result=await createProductCard('feature',featureInput,f.rpc);
  assert.equal(result.disposition,'created');assert.deepEqual(unrelated,before);
  assert.equal(f.calls.filter(call=>call.method==='workboard.cards.create').length,1);
});

test('relevant linked parent, prerequisite and same canonical key still reject without mutation',async()=>{
  for(const target of ['parent','prerequisite','same-key']){
    const f=fixture(),parent=await feature(f),writes=()=>f.calls.filter(call=>call.method==='workboard.cards.create').length;
    let input=itemInput(parent.id,'next'),selected=f.cards.find(card=>card.id===parent.id);
    if(target==='prerequisite'){const created=(await createProductCard('work-item',itemInput(parent.id,'first'),f.rpc)).card;selected=f.cards.find(card=>card.id===created.id);input=itemInput(parent.id,'next',[selected.id]);}
    if(target==='same-key'){input=featureInput;}
    selected.metadata.automation.createdByCardId=id(77);const before=structuredClone(f.cards),count=writes();
    await assert.rejects(createProductCard(target==='same-key'?'feature':'work-item',input,f.rpc),/forbidden/);
    assert.equal(writes(),count);assert.deepEqual(f.cards,before);
  }
});

test('same key rejects changed payload while valid claimed or transferred progress is reused unchanged',async()=>{
  const f=fixture();await feature(f);const card=f.cards.find(card=>card.metadata?.automation?.idempotencyKey==='feature:project:internal-ui-request-message'),writes=f.calls.filter(call=>call.method==='workboard.cards.create').length;
  await assert.rejects(createProductCard('feature',{...featureInput,scope:'Different scope.'},f.rpc),/payload mismatch/);
  card.status='blocked';card.agentId='main';card.metadata.claim={ownerId:'main',expiresAt:Date.now()+10000};
  await assert.rejects(createProductCard('feature',featureInput,f.rpc),/product-owned/);
  delete card.metadata.claim;const checkpoint=id(70),question=id(71);
  card.metadata.comments=[{id:question,createdAt:Date.now(),body:JSON.stringify({card:card.id,checkpoint,kind:'question',actor:'agent:gilfoyle:main',data:{reason:'retained-user-decision',question:'Which scope?',resolution:'Owner confirms.',source}})}];
  card.notes+=`\nHandoff: ${JSON.stringify({checkpoint,phase:'needs-message',question})}`;const before=structuredClone(card);
  const result=await createProductCard('feature',featureInput,f.rpc);assert.equal(result.reused,true);assert.deepEqual(result.card,before);assert.equal(f.calls.filter(call=>call.method==='workboard.cards.create').length,writes);
  await assert.rejects(createProductCard('feature',{...featureInput,delivery:'channel=internal-ui;account=local;recipient=owner;thread=none'},f.rpc),/payload mismatch/);
});

test('recognized prepared Work item and hosted Feature suffixes preserve immutable creation identity',async()=>{
  const f=fixture(),parent=await feature(f),created=(await createProductCard('work-item',itemInput(parent.id),f.rpc)).card,item=f.cards.find(card=>card.id===created.id),sha='a'.repeat(40);
  item.notes+=`\nImmutable base: ${sha}\nWorktree: /tmp/work\nBranch: work-a1\n<!-- current-attempt -->\nDelegated attempt: ${item.id}-a1\nTask name: item-a1\nProfile ID: deep\nModel: openai/gpt-5.6-sol\nThinking: high\nTask ID: unresolved acceptance\nRun ID: unresolved acceptance\nChild session: unresolved acceptance\nWrapper task ID: unresolved acceptance\nTimeout seconds: 1800\nBackend: acpx\nAcceptance comment ID: unresolved acceptance\n<!-- /current-attempt -->`;
  assert.equal((await createProductCard('work-item',itemInput(parent.id),f.rpc)).reused,true);
  const original=item.notes;item.notes=item.notes.replace('Assignment: implementation','Assignment: changed');
  await assert.rejects(createProductCard('work-item',itemInput(parent.id),f.rpc),/payload mismatch/);item.notes=original;
  const featureCard=f.cards.find(card=>card.id===parent.id),binding={repo:'owner/repo',branch:'main',headRef:'feature/test',baseSha:sha,sha,reviewId:id(80),summary:'Reviewed.',prNumber:7,workflows:[{path:'.github/workflows/test.yml',jobs:['test']}]};
  featureCard.notes+=`\nHosted candidate: ${JSON.stringify(binding)}\nHosted gate: ${JSON.stringify({binding:bindingDigest('project',featureCard.id,binding),runs:[[10,1]]})}`;
  assert.equal((await createProductCard('feature',featureInput,f.rpc)).reused,true);
});

test('existing unsealed records are rejected in every lifecycle phase',async()=>{
  const f=fixture(),parent=await feature(f),featureCard=f.cards.find(card=>card.id===parent.id);
  featureCard.notes=featureCard.notes.replace(/\nCreation: sha256:[0-9a-f]{64}$/,'');
  await assert.rejects(createProductCard('feature',featureInput,f.rpc),/payload mismatch|marker/);
  const clean=fixture(),cleanParent=await feature(clean),itemResult=await createProductCard('work-item',itemInput(cleanParent.id),clean.rpc),item=clean.cards.find(card=>card.id===itemResult.card.id);
  item.notes=item.notes.replace(/\nCreation: sha256:[0-9a-f]{64}$/,'');
  await assert.rejects(createProductCard('work-item',itemInput(cleanParent.id),clean.rpc),/payload mismatch|marker/);
});

test('a newly returned unsealed card is rejected',async()=>{
  const f=fixture(),rpc=async(method,p)=>{const result=await f.rpc(method,p);if(method==='workboard.cards.create'){result.card.notes=result.card.notes.replace(/\nCreation: sha256:[0-9a-f]{64}$/,'');f.cards.find(card=>card.id===result.card.id).notes=result.card.notes;}return result;};
  await assert.rejects(createProductCard('feature',featureInput,rpc),/payload mismatch|marker/);
});

test('hosted gate suffix requires exact bounded positive unique workflow receipts and binding',async()=>{
  const f=fixture(),parent=await feature(f),card=f.cards.find(value=>value.id===parent.id),sha='a'.repeat(40),candidate={repo:'owner/repo',branch:'main',headRef:'feature/test',baseSha:sha,sha,reviewId:id(80),summary:'Reviewed.',prNumber:7,workflows:[{path:'.github/workflows/test.yml',jobs:['test']},{path:'.github/workflows/lint.yml',jobs:['lint']}]};
  const prefix=card.notes+`\nHosted candidate: ${JSON.stringify(candidate)}`,valid={binding:bindingDigest('project',card.id,candidate),runs:[[10,1],[11,2]]};card.notes=`${prefix}\nHosted gate: ${JSON.stringify(valid)}`;
  assert.equal((await createProductCard('feature',featureInput,f.rpc)).reused,true);
  for(const gate of [{...valid,extra:true},{binding:valid.binding,runs:[]},{binding:valid.binding,runs:[[10,0],[11,2]]},{binding:valid.binding,runs:[[10,-1],[11,2]]},{binding:valid.binding,runs:[[10,1],[10,2]]},{binding:valid.binding,runs:[[10,1]]},{binding:'c'.repeat(64),runs:valid.runs}]){
    card.notes=`${prefix}\nHosted gate: ${JSON.stringify(gate)}`;await assert.rejects(createProductCard('feature',featureInput,f.rpc),/hosted gate|binding/i);
  }
});

test('hosted lifecycle cleanup rejects field-name lookalikes',async()=>{
  const f=fixture(),parent=await feature(f),card=f.cards.find(value=>value.id===parent.id),sha='a'.repeat(40),candidate={repo:'owner/repo',branch:'main',headRef:'feature/test',baseSha:sha,sha,reviewId:id(80),summary:'Reviewed.',prNumber:7,workflows:[{path:'.github/workflows/test.yml',jobs:['test']}]};
  const prefix=card.notes+`\nHosted candidate: ${JSON.stringify(candidate)}`;
  for(const lookalike of ['Hosted gateevil: {}','Wait hosted-civil','Wait: hosted-civil','CI observed attacker: 2026-09-13T00:00:00.000Z','CI recheck attacker: 2026-09-13T00:30:00.000Z']){
    card.notes=`${prefix}\n${lookalike}`;await assert.rejects(createProductCard('feature',featureInput,f.rpc),/Unrecognized creation lifecycle suffix/);
  }
});

test('Gilfoyle progressed claims require coherent owner, status and unexpired lease',async()=>{
  const f=fixture(),created=await feature(f),card=f.cards.find(value=>value.id===created.id);card.status='running';card.metadata.claim={ownerId:'gilfoyle',expiresAt:Date.now()+60000};
  assert.equal((await createProductCard('feature',featureInput,f.rpc)).reused,true);
  for(const mutation of [()=>card.metadata.claim.ownerId='main',()=>card.status='todo',()=>{card.status='running';card.metadata.claim={ownerId:'gilfoyle',expiresAt:Date.now()-1};}]){
    card.status='running';card.metadata.claim={ownerId:'gilfoyle',expiresAt:Date.now()+60000};mutation();await assert.rejects(createProductCard('feature',featureInput,f.rpc),/claim/);
  }
});

test('archived, duplicate, malformed and truncated board state fail before mutation',async()=>{
  for(const mode of ['archived','duplicate','project','truncated']){
    const f=fixture();await feature(f);const card=f.cards.find(card=>card.metadata?.automation?.idempotencyKey==='feature:project:internal-ui-request-message'),writes=f.calls.filter(call=>call.method==='workboard.cards.create').length;
    if(mode==='archived')card.metadata.archivedAt=1;
    if(mode==='duplicate')f.cards.push({...structuredClone(card),id:id(91)});
    if(mode==='project')f.cards.push({...structuredClone(f.cards[0]),id:id(92)});
    if(mode==='truncated')f.rpcBase=f.rpc;
    const rpc=mode==='truncated'?async(method,p)=>{const value=await f.rpc(method,p);if(method==='workboard.cards.list')value.boards[0].total++;return value;}:f.rpc;
    await assert.rejects(createProductCard('feature',featureInput,rpc));
    assert.equal(f.calls.filter(call=>call.method==='workboard.cards.create').length,writes);
  }
});

test('ambiguous accepted create retries to exactly one card',async()=>{
  const f=fixture();f.failCreate();await assert.rejects(createProductCard('feature',featureInput,f.rpc),/Ambiguous/);
  const result=await createProductCard('feature',featureInput,f.rpc);assert.equal(result.reused,true);
  assert.equal(f.cards.filter(card=>card.metadata?.automation?.idempotencyKey==='feature:project:internal-ui-request-message').length,1);
  assert.equal(f.calls.filter(call=>call.method==='workboard.cards.create').length,1);
});

test('stop remains urgent and admissible for paused project and held nonterminal Feature',async()=>{
  const f=fixture(),created=await feature(f),parent=f.cards.find(card=>card.id===created.id);f.cards[0].notes='Type: project-info\nReadiness: paused';parent.status='blocked';parent.labels=['type:feature','user-held'];
  await assert.rejects(createProductCard('work-item',itemInput(parent.id),f.rpc),/paused/);
  const result=await createProductCard('stop',{boardId:'project',featureId:parent.id,title:'Stop requested',reason:'Owner requested cancellation.'},f.rpc);
  assert.equal(result.card.priority,'urgent');assert.equal(result.card.metadata.automation.idempotencyKey,`action:${parent.id}:cancellation:stop`);assert.deepEqual(result.card.labels,['type:action','cancellation','stop']);
  parent.status='done';parent.metadata.archivedAt=1;const stop=f.cards.find(card=>card.id===result.card.id);const retry=await createProductCard('stop',{boardId:'project',featureId:parent.id,title:'Stop requested',reason:'Owner requested cancellation.'},f.rpc);assert.equal(retry.reused,true);
  stop.status='done';stop.completedAt=Date.now();stop.metadata.archivedAt=Date.now();stop.metadata.automation.summary='Outcome: cancelled';stop.notes+='\nResolution: cancellation confirmed';
  assert.equal((await createProductCard('stop',{boardId:'project',featureId:parent.id,title:'Stop requested',reason:'Owner requested cancellation.'},f.rpc)).reused,true);
  stop.notes+='\nmalformed suffix';await assert.rejects(createProductCard('stop',{boardId:'project',featureId:parent.id,title:'Stop requested',reason:'Owner requested cancellation.'},f.rpc),/Action lifecycle/);stop.notes=stop.notes.replace('\nmalformed suffix','');
  const fresh=fixture(),freshParent=await feature(fresh);fresh.cards.find(card=>card.id===freshParent.id).status='done';
  await assert.rejects(createProductCard('stop',{boardId:'project',featureId:freshParent.id,title:'Stop requested',reason:'Owner requested cancellation.'},fresh.rpc),/completed/);
});

test('stop ignores missing, malformed, duplicate, setup, paused and archived project information',async()=>{
  for(const mode of ['missing','malformed','duplicate','setup','paused','archived']){
    const f=fixture(),created=await feature(f),parent=f.cards.find(card=>card.id===created.id),info=f.cards[0];
    parent.status='blocked';parent.labels=['type:feature','user-held'];
    if(mode==='missing')f.cards.splice(f.cards.indexOf(info),1);
    if(mode==='malformed')info.notes='not project information';
    if(mode==='duplicate')f.cards.push({...structuredClone(info),id:id(92)});
    if(['setup','paused'].includes(mode))info.notes=`Type: project-info\nReadiness: ${mode}`;
    if(mode==='archived')info.metadata.archivedAt=1;
    const result=await createProductCard('stop',{boardId:'project',featureId:parent.id,title:'Stop requested',reason:'Owner requested cancellation.'},f.rpc);
    assert.equal(result.card.metadata.automation.idempotencyKey,`action:${parent.id}:cancellation:stop`,mode);
  }
});

test('stop rejects completed or malformed canonical Feature targets without mutation',async()=>{
  for(const mode of ['completed','type','tenant','key','board','linked']){
    const f=fixture(),created=await feature(f),parent=f.cards.find(card=>card.id===created.id),writes=f.calls.filter(call=>call.method==='workboard.cards.create').length;
    if(mode==='completed')parent.status='done';
    if(mode==='type')parent.notes=parent.notes.replace('Type: feature','Type: action');
    if(mode==='tenant')parent.metadata.automation.tenant='other';
    if(mode==='key')parent.metadata.automation.idempotencyKey='feature:other:value';
    if(mode==='board')parent.metadata.automation.boardId='other';
    if(mode==='linked')parent.metadata.links=[{type:'parent',targetCardId:id(99)}];
    await assert.rejects(createProductCard('stop',{boardId:'project',featureId:parent.id,title:'Stop requested',reason:'Owner requested cancellation.'},f.rpc));
    assert.equal(f.calls.filter(call=>call.method==='workboard.cards.create').length,writes,mode);
  }
});

test('exceptional intervention permits only the two enumerated urgent kinds',async()=>{
  for(const kind of ['cancellation-uncertain','communication-urgent']){
    const f=fixture(),parent=await feature(f);const result=await createProductCard('exceptional-intervention',{boardId:'project',featureId:parent.id,kind,title:'Intervention',reason:'Independent urgent reconciliation is required.'},f.rpc);
    assert.equal(result.card.priority,'urgent');assert(result.card.labels.includes(kind));assert.equal(result.card.metadata.automation.idempotencyKey,`action:${parent.id}:intervention:${kind}`);
  }
  const f=fixture(),parent=await feature(f),writes=f.calls.length;
  await assert.rejects(createProductCard('exceptional-intervention',{boardId:'project',featureId:parent.id,kind:'ordinary-blocker',title:'No',reason:'No.'},f.rpc),/Unsupported/);assert.equal(f.calls.length,writes);
});

test('strict public schemas reject dangerous or unknown fields before RPC',async()=>{
  const f=fixture();
  for(const extra of [{parents:[id(1)]},{createdByCardId:id(1)},{metadata:{}},{dependencies:[id(1)]}]) await assert.rejects(createProductCard('feature',{...featureInput,...extra},f.rpc),/schema/);
  assert.equal(f.calls.length,0);
});

test('Feature rejects contradictory delivery routing before RPC',async()=>{
  const f=fixture();
  await assert.rejects(createProductCard('feature',{...featureInput,sourceMessage:'1579',deliverySource:'channel=telegram;account=default;recipient=other;thread=none'},f.rpc),/contradicts/);
  assert.equal(f.calls.length,0);
});

test('installed create bounds enforce lowercase board, title 180 and idempotency 160',async()=>{
  for(const input of [{...featureInput,boardId:'Uppercase'},{...featureInput,boardId:'a'.repeat(81)},{...featureInput,title:'x'.repeat(181)}]){
    const f=fixture();await assert.rejects(createProductCard('feature',input,f.rpc));assert.equal(f.calls.length,0);
  }
  const boardId='a'.repeat(80),f=fixture(boardId),accepted=(await createProductCard('feature',{...featureInput,boardId,request:'r'.repeat(64),title:'x'.repeat(180)},f.rpc)).card;
  assert.equal(accepted.title.length,180);assert.equal(accepted.metadata.automation.boardId.length,80);assert(accepted.metadata.automation.idempotencyKey.length<=160);
  const unsafe=sealCreationPayload({boardId:'project',tenant:'project',idempotencyKey:'x'.repeat(161),title:'Title',agentId:'gilfoyle',status:'todo',priority:'normal',labels:['type:feature'],workspace:{kind:'scratch'},maxRuntimeSeconds:1,maxRetries:1,notes:'Type: feature\nRequest: request\nScope: scope\nDelivery: current-source internal-ui\nDelivery source: '+source});
  const untouched=fixture();await assert.rejects(ensureCreatedCard(unsafe,untouched.rpc),/idempotency/);assert.equal(untouched.calls.length,0);
});

test('project information requires its canonical label and no execution linkage',async()=>{
  for(const mutation of [card=>delete card.labels,card=>card.labels.push('extra'),card=>card.execution={status:'running'},card=>card.sessionKey='agent:test',card=>card.runId=id(90),card=>card.taskId=id(91)]){
    const f=fixture();mutation(f.cards[0]);await assert.rejects(createProductCard('feature',featureInput,f.rpc));assert(!f.calls.some(call=>call.method==='workboard.cards.create'));
  }
});

test('classifier marks linked Feature, Work item and required notification identities uncertain',()=>{
  const parent={id:id(2),title:'Feature',agentId:'gilfoyle',status:'todo',updatedAt:1,notes:'Type: feature',metadata:{automation:{boardId:'project'},links:[{type:'child',targetCardId:id(3)}]}};
  const item={id:id(3),title:'Item',agentId:'gilfoyle',status:'todo',updatedAt:1,notes:`Type: work-item\nFeature: ${parent.id}\nRequires Work items: none`,metadata:{automation:{boardId:'project',tenant:parent.id,createdByCardId:parent.id}}};
  const notice={id:id(4),title:'Notice',agentId:'gilfoyle',status:'todo',updatedAt:1,notes:`Type: action\nFeature: ${parent.id}`,metadata:{automation:{boardId:'project',tenant:parent.id,idempotencyKey:`action:${parent.id}:owner-notification`},links:[{type:'parent',targetCardId:parent.id}]}};
  const rows=classifyCards([parent,item,notice]);for(const card of [parent,item,notice])assert.equal(rows.get(card.id).stage,'identity-uncertain');
});

test('all linked protocol Actions fail creation-board validation and classify uncertain',async()=>{
  for(const kind of ['cancellation','exceptional-intervention','owner-notification']){
    const f=fixture(),parent=await feature(f),action={id:id(90),title:'Action',agentId:'gilfoyle',status:'done',completedAt:2,updatedAt:2,notes:`Type: action\nKind: ${kind}\nFeature: ${parent.id}`,metadata:{automation:{boardId:'project',tenant:parent.id,idempotencyKey:`action:${parent.id}:${kind}`},links:[{type:'parent',targetCardId:parent.id}]}};f.cards.push(action);
    assert.equal((await createProductCard('feature',{...featureInput,request:`unrelated-${kind}`,sourceMessage:`unrelated-${kind}`},f.rpc)).disposition,'created');assert.equal(classifyCards(f.cards).get(action.id).stage,'identity-uncertain');
    action.status='todo';await assert.rejects(createProductCard('work-item',itemInput(parent.id),f.rpc),/forbidden/);
  }
});

test('bounded creation diagnostics classify known failures and never expose raw details',()=>{
  const cases=[
    [new assert.AssertionError({message:'Invalid project information /secret/path token=abc'}),'project-info-invalid'],
    [Error('Native createdByCardId is forbidden for 7b512-secret'),'native-link'],
    [new assert.AssertionError({message:'Duplicate canonical card identity private-id'}),'identity-conflict'],
    [new assert.AssertionError({message:'Project is paused private-note'}),'project-paused'],
    [new assert.AssertionError({message:'Invalid title credential=secret'}),'invalid-input'],
    [Error('Native enumeration changed or was truncated; restart scan /private'),'incomplete-read'],
    [new assert.AssertionError({message:'Unsupported creation operation hidden'}),'operation'],
    [Error('database exploded at /private credential=secret'),'validation-failed'],
    [new SyntaxError('Unexpected token credential=secret'),'invalid-input'],
  ];
  for(const [error,code] of cases){const result=creationError(error),json=JSON.stringify(result);assert.equal(result.complete,false);assert.equal(result.code,code);assert(!Object.hasOwn(result,'durable')&&!Object.hasOwn(result,'acknowledgementReady')&&!Object.hasOwn(result,'wakeMessage'));assert(!json.includes('private')&&!json.includes('secret')&&!json.includes('7b512'));}
});

test('Feature reuse mismatch returns neither acknowledgement nor wake',async()=>{
  const f=fixture();await createProductCard('feature',featureInput,f.rpc);
  try { await createProductCard('feature',{...featureInput,scope:'Different scope.'},f.rpc);assert.fail('Expected mismatch'); }
  catch(error){const result=creationError(error);assert(!Object.hasOwn(result,'acknowledgementReady'));assert(!Object.hasOwn(result,'wakeMessage'));}
});

test('isolated native store persists validated Feature and Work item without dependency links', {skip:process.env.JG_NATIVE_TEST!=='1'},async t=>{
  const {WorkboardStore,sqliteStores}=await loadWorkboardTestInternals();
  const root=mkdtempSync(join(tmpdir(),'project-create-')),stores=sqliteStores({dbPath:`${root}/native.sqlite`}),store=new WorkboardStore(stores.cards,stores);
  try{
    const boardId='isolated-create';
    const rpc=async(method,p)=>{
      if(method==='workboard.cards.list'){const cards=await store.list(p);return {cards,boards:[{id:boardId,total:cards.length}]};}
      if(method==='workboard.cards.create')return {card:await store.create(p)};
      throw Error('Unexpected isolated RPC');
    };
    const info=(await createProductCard('project-info',{...projectInput,boardId,name:'Isolated',repository:'file:///tmp/isolated.git',checkout:'/tmp/isolated',productDocs:['README.md'],architectureDocs:[]},rpc)).card;
    assert(!info.agentId);assert.deepEqual(info.labels,['type:project-info']);
    const feature=(await createProductCard('feature',{...featureInput,boardId,request:'native'},rpc)).card;
    const item=(await createProductCard('work-item',{...itemInput(feature.id),boardId},rpc)).card;
    const review=(await createProductCard('review',{...reviewInput(feature.id,'native-review','a'.repeat(40),[item.id]),boardId},rpc)).card;
    for(const card of [feature,item,review]){const stored=await store.get(card.id);assert(!stored.metadata.links);assert(!stored.metadata.automation.createdByCardId);}
    t.diagnostic(`Only isolated SQLite store mutated: ${root}`);
  }finally{await store.close();}
});
