import { configureTopology } from '../../src/topology.ts';

configureTopology({
  productAgentId: 'main',
  engineeringAgentId: 'gilfoyle',
  workerAgentId: 'opencode',
  workerRuntime: 'acp',
  sessionNamespace: 'jarvis-gilfoyle',
  workerProfiles: [
    {
      id: 'routine',
      model: 'openai/gpt-5.6-sol',
      thinking: 'medium',
      description: 'Routine bounded implementation and inspection.',
    },
    {
      id: 'deep',
      model: 'openai/gpt-5.6-sol',
      thinking: 'high',
      description: 'Complex implementation, debugging, and independent review.',
    },
    {
      id: 'expert',
      model: 'openai/gpt-6-astra',
      thinking: 'low',
      description: 'Unusually difficult architecture, security, or diagnosis.',
    },
  ],
});
