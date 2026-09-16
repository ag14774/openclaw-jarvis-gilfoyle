import {configureTopology} from './src/topology.ts';

configureTopology({
  productAgentId:'main',
  engineeringAgentId:'gilfoyle',
  workerAgentId:'opencode',
  workerRuntime:'acp',
  sessionNamespace:'jarvis-gilfoyle',
  workerModel:'openai/gpt-5.6-sol',
  workerThinking:'high',
  advisorModel:'openai/gpt-6-astra',
  advisorThinking:'low',
  advisorTimeoutSeconds:600,
});
