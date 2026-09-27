import assert from 'node:assert/strict';
import { isAbsolute, posix } from 'node:path';
import { githubRef } from './helpers/github-evidence.js';

const line = (value, max, name) => {
  assert(
    typeof value === 'string' &&
      value.trim() === value &&
      value.length > 0 &&
      value.length <= max &&
      !/[\r\n\x00-\x1f\x7f]/.test(value),
    `Invalid ${name}`,
  );
  return value;
};

export function repositoryInfo(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input));
  assert.equal(
    Object.keys(input).sort().join(','),
    [
      'architectureDocs',
      'checkout',
      'evidence',
      'integrationBranch',
      'name',
      'productDocs',
      'readiness',
      'repository',
      'requiredCI',
      'scope',
    ]
      .sort()
      .join(','),
    'Invalid repository metadata schema',
  );
  const normalized = structuredClone(input);
  line(normalized.name, 120, 'name');
  line(normalized.repository, 500, 'repository');
  line(normalized.checkout, 1000, 'checkout');
  line(normalized.integrationBranch, 160, 'integration branch');
  assert(
    isAbsolute(normalized.checkout) &&
      posix.normalize(normalized.checkout) === normalized.checkout &&
      !/[\r\n\x00-\x1f\x7f]/.test(normalized.checkout),
    'Invalid checkout',
  );
  assert(githubRef(normalized.integrationBranch), 'Invalid integration branch');
  const github =
    /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\.git$/.test(
      normalized.repository,
    );
  let local = false;
  try {
    const url = new URL(normalized.repository);
    local =
      url.href === normalized.repository &&
      url.protocol === 'file:' &&
      !url.hostname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.startsWith('/') &&
      !/[\x00-\x1f\x7f]/.test(decodeURIComponent(url.pathname));
  } catch {
    // Repository remains invalid.
  }
  assert(github || local, 'Invalid repository');
  const paths = (value, minimum, name) => {
    assert(
      Array.isArray(value) &&
        value.length >= minimum &&
        value.length <= 20 &&
        new Set(value).size === value.length,
      `Invalid ${name}`,
    );
    assert(
      value.every(
        (path) =>
          typeof path === 'string' &&
          path.length > 0 &&
          path.length <= 240 &&
          !path.includes('\\') &&
          !path.includes(',') &&
          !isAbsolute(path) &&
          posix.normalize(path) === path &&
          path !== '.' &&
          !path.split('/').includes('..') &&
          !/[\x00-\x1f\x7f]/.test(path),
      ),
      `Invalid ${name}`,
    );
  };
  paths(normalized.productDocs, 1, 'product docs');
  paths(normalized.architectureDocs, 0, 'architecture docs');
  assert(['setup', 'ready', 'paused'].includes(normalized.readiness), 'Invalid readiness');
  assert(
    typeof normalized.evidence === 'string' &&
      normalized.evidence.trim() === normalized.evidence &&
      normalized.evidence.length <= 1000 &&
      !/[\r\n\x00-\x1f\x7f]/.test(normalized.evidence),
    'Invalid setup evidence',
  );
  line(normalized.scope, 1000, 'scope');
  assert(
    Array.isArray(normalized.requiredCI) &&
      normalized.requiredCI.length <= 4 &&
      (github ? normalized.requiredCI.length > 0 : normalized.requiredCI.length === 0),
    'Invalid required CI',
  );
  const workflowPaths = new Set();
  for (const workflow of normalized.requiredCI) {
    assert(
      workflow &&
        Object.keys(workflow).sort().join(',') === 'jobs,path' &&
        typeof workflow.path === 'string' &&
        /^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/.test(workflow.path) &&
        workflow.path.length <= 160 &&
        !workflowPaths.has(workflow.path),
      'Invalid required CI',
    );
    workflowPaths.add(workflow.path);
    assert(
      Array.isArray(workflow.jobs) &&
        workflow.jobs.length > 0 &&
        workflow.jobs.length <= 20 &&
        new Set(workflow.jobs).size === workflow.jobs.length &&
        workflow.jobs.every(
          (job) =>
            typeof job === 'string' && job.trim() === job && /^[\x20-\x7e]{1,120}$/.test(job),
        ),
      'Invalid required CI',
    );
  }
  assert(
    normalized.readiness !== 'ready' || normalized.evidence.length > 0,
    'Ready repository requires setup evidence',
  );
  return normalized;
}
