import {topology} from '../topology.js';

export function advisoryArgs() {
  const {advisorModel,advisorThinking,advisorTimeoutSeconds}=topology();
  return {spawnArgs:{runtime:'subagent',mode:'run',visible:false,context:'isolated',model:advisorModel,thinking:advisorThinking,runTimeoutSeconds:advisorTimeoutSeconds,cleanup:'keep',expectsCompletionMessage:true}};
}
