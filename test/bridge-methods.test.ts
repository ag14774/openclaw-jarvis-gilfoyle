import assert from 'node:assert/strict';
import test from 'node:test';
import { companionMethodAllowed } from '../src/bridge-methods.ts';

test('companion permits the project guard required by real delegation preparation', () => {
  assert.equal(companionMethodAllowed('jarvis-gilfoyle.projects.guard'), true);
  assert.equal(companionMethodAllowed('workboard.cards.list'), true);
  assert.equal(companionMethodAllowed('openclaw.install.modify'), false);
});
