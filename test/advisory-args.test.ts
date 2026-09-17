import assert from 'node:assert/strict';
import test from 'node:test';
import './support/setup.ts';
import { advisoryArgs } from '../src/helpers/advisory-args.ts';

test('advisory helper returns the fixed validated spawn arguments without effects', () => {
  const expected = {
    runtime: 'subagent', mode: 'run', visible: false, context: 'isolated',
    model: 'openai/gpt-6-astra', thinking: 'low', runTimeoutSeconds: 600,
    cleanup: 'keep', expectsCompletionMessage: true,
  };
  assert.deepEqual(advisoryArgs(), { spawnArgs: expected });
});
