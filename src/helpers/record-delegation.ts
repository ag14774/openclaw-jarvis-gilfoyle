const ERRORS = {
  'invalid-input': 'The delegation request is invalid.',
  'state-conflict': 'Delegation conflicts with durable native or repository state.',
  'incomplete-read': 'Delegation evidence could not be completely read.',
  'validation-failed': 'Delegation validation failed; native state was not safely reconciled.',
};

export function delegationError(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  let code = 'validation-failed';
  if (
    error instanceof SyntaxError ||
    /Unknown operation input|Invalid scope|Use prepare\|record/.test(message)
  )
    code = 'invalid-input';
  else if (
    /Incomplete native response|enumeration changed|truncated|scope mismatch|Missing board total|Unknown board|window incomplete|enumeration incomplete/.test(
      message,
    )
  )
    code = 'incomplete-read';
  else if (
    /mismatch|changed|dirty|belongs to another|must be|required|conflict|held|pending|already|duplicate|uncertain|archived|owner|HEAD|worktree|branch/i.test(
      message,
    )
  )
    code = 'state-conflict';
  const first = message.split('\n')[0];
  const conditions = new Set([
    'Prepared current attempt required',
    'Invalid parent',
    'Card missing',
    'Execution binding conflicts with card ownership',
    'Native execution task identity required',
    'Native worker prompt does not bind this Work item/task name',
    'Execution already belongs to another card',
    'Prepared assignment changed before binding',
    'Release a conflicting claim before recording execution',
    'Task discovery window incomplete; use exact IDs',
    'Immutable reference mismatch',
    'Explicit task ID mismatch',
    'Explicit wrapper ID mismatch',
    'Ambiguous accepted delegation comments',
    'Live engineering manager claim required',
  ]);
  return {
    complete: false,
    code,
    error: ERRORS[code],
    ...(conditions.has(first) ? { condition: first } : {}),
  };
}
