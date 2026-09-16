import assert from 'node:assert/strict';

const AGENT_ID=/^[a-z0-9][a-z0-9_-]{0,63}$/;
const NAMESPACE=/^[a-z][a-z0-9_-]{0,31}$/;
const THINKING=new Set(['off','minimal','low','medium','high','xhigh','max','ultra']);

let current=Object.freeze({
  productAgentId:'product',
  engineeringAgentId:'engineering',
  workerAgentId:'worker',
  workerRuntime:'acp',
  sessionNamespace:'jarvis-gilfoyle',
  workerModel:'configured/worker',
  workerThinking:'high',
  advisorModel:'configured/advisor',
  advisorThinking:'low',
  advisorTimeoutSeconds:600,
});

export function configureTopology(input={}){
  const next={...current,...Object.fromEntries(Object.entries(input).filter(([,value])=>value!==undefined))};
  for(const key of ['productAgentId','engineeringAgentId','workerAgentId'])assert(AGENT_ID.test(next[key]),`Invalid ${key}`);
  assert(new Set([next.productAgentId,next.engineeringAgentId,next.workerAgentId]).size===3,'Topology agent IDs must be distinct');
  assert(NAMESPACE.test(next.sessionNamespace),'Invalid sessionNamespace');
  assert(['acp','subagent'].includes(next.workerRuntime),'Invalid workerRuntime');
  for(const key of ['workerModel','advisorModel'])assert(typeof next[key]==='string'&&next[key].trim()===next[key]&&next[key].length>0&&next[key].length<=160,`Invalid ${key}`);
  for(const key of ['workerThinking','advisorThinking'])assert(THINKING.has(next[key]),`Invalid ${key}`);
  assert(Number.isSafeInteger(next.advisorTimeoutSeconds)&&next.advisorTimeoutSeconds>=1&&next.advisorTimeoutSeconds<=1800,'Invalid advisorTimeoutSeconds');
  current=Object.freeze(next);return current;
}

export const topology=()=>current;
export const managerAgentIds=()=>[current.productAgentId,current.engineeringAgentId];
export const isManagerAgent=id=>managerAgentIds().includes(id);
export const roleForAgent=id=>id===current.productAgentId?'product':id===current.engineeringAgentId?'engineering':null;
export const agentForRole=role=>role==='product'?current.productAgentId:role==='engineering'?current.engineeringAgentId:null;
export const projectSessionKey=(role,scope)=>`agent:${agentForRole(role)}:${current.sessionNamespace}:${scope}`;
export const isProjectSessionKey=key=>managerAgentIds().some(id=>String(key??'').startsWith(`agent:${id}:${current.sessionNamespace}:`));
