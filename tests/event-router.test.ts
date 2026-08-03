import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  createEventRouter,
  createFileDeliveryStore,
  createMemoryDeliveryStore,
  loadConfigFromFile,
  matchRoute,
  parseEventPayload,
  safeParseConfig,
} from '../github/events/index.ts';

function prPayload(action: string, overrides: Record<string, unknown> = {}) {
  return {
    action,
    number: 12,
    pull_request: {
      number: 12,
      head: { ref: 'feat/x', sha: 'abc123' },
      labels: [{ name: 'implement' }, { name: 'bug' }],
    },
    repository: { full_name: 'owner/repo' },
    sender: { login: 'alice' },
    ...overrides,
  };
}

function workflowRunPayload(action: string, overrides: Record<string, unknown> = {}) {
  return {
    action,
    workflow_run: {
      id: 55,
      name: 'CI',
      head_branch: 'main',
      conclusion: action === 'completed' ? 'failure' : null,
    },
    repository: { full_name: 'owner/repo' },
    sender: { login: 'alice' },
    ...overrides,
  };
}

describe('safeParseConfig', () => {
  test('accepts the shorthand map from the issue example', () => {
    const result = safeParseConfig({
      routes: {
        'pull_request.opened': 'review',
        'pull_request_review.submitted': 'address-review',
        'issues.opened': 'planner',
        'workflow_run.completed.failure': 'ci-fix',
      },
    });
    assert.ok(result.ok);
    assert.deepEqual(result.config.routes[0], {
      event: 'pull_request',
      agent: 'review',
      filter: { action: ['opened'] },
    });
  });

  test('accepts the three-part labeled shorthand from the issue example', () => {
    const result = safeParseConfig({ routes: { 'issues.labeled.implement': 'implementation' } });
    assert.ok(result.ok);
    assert.deepEqual(result.config.routes[0], {
      event: 'issues',
      agent: 'implementation',
      filter: { action: ['labeled'], label: ['implement'] },
    });
  });

  test('accepts the array form with filters', () => {
    const result = safeParseConfig({
      routes: [
        {
          event: 'issues',
          action: 'labeled',
          agent: 'implementation',
          filter: { label: ['implement'] },
        },
      ],
    });
    assert.ok(result.ok);
    assert.deepEqual(result.config.routes[0], {
      event: 'issues',
      agent: 'implementation',
      filter: { action: ['labeled'], label: ['implement'] },
    });
  });

  test('rejects unknown event families with actionable errors', () => {
    const result = safeParseConfig({ routes: { 'stars.created': 'celebrate' } });
    assert.ok(!result.ok);
    assert.match(result.issues.join(' '), /stars\.created/);
    assert.match(result.issues.join(' '), /pull_request/);
  });

  test('rejects routes with no agent', () => {
    const result = safeParseConfig({ routes: [{ event: 'issues' }] });
    assert.ok(!result.ok);
    assert.match(result.issues.join(' '), /agent/);
  });

  test('rejects empty routes and non-object configs', () => {
    assert.ok(!safeParseConfig({ routes: {} }).ok);
    assert.ok(!safeParseConfig({ routes: [] }).ok);
    assert.ok(!safeParseConfig('nope').ok);
  });
});

describe('parseEventPayload', () => {
  test('normalizes pull_request events with branch and labels', () => {
    const result = parseEventPayload('pull_request', prPayload('opened'));
    assert.ok(result.ok);
    assert.equal(result.event.type, 'pull_request');
    assert.equal(result.event.action, 'opened');
    assert.equal(result.event.branch, 'feat/x');
    assert.deepEqual(result.event.labels, ['implement', 'bug']);
    assert.equal(result.event.repository, 'owner/repo');
    assert.equal(result.event.actor, 'alice');
  });

  test('normalizes issues events', () => {
    const result = parseEventPayload('issues', {
      action: 'opened',
      issue: { number: 4, labels: [{ name: 'implement' }] },
      repository: { full_name: 'owner/repo' },
      sender: { login: 'bob' },
    });
    assert.ok(result.ok);
    assert.equal(result.event.type, 'issues');
    assert.deepEqual(result.event.labels, ['implement']);
  });

  test('produces unique dedupe fingerprints per issue number', () => {
    const first = parseEventPayload('issues', {
      action: 'opened',
      issue: { number: 4 },
      repository: { full_name: 'owner/repo' },
      sender: { login: 'bob' },
    });
    const second = parseEventPayload('issues', {
      action: 'opened',
      issue: { number: 5 },
      repository: { full_name: 'owner/repo' },
      sender: { login: 'bob' },
    });
    assert.ok(first.ok);
    assert.ok(second.ok);
    assert.notEqual(first.event.id, second.event.id);
  });

  test('normalizes issue_comment events', () => {
    const result = parseEventPayload('issue_comment', {
      action: 'created',
      issue: { number: 6, labels: [{ name: 'bug' }] },
      comment: { id: 77 },
      repository: { full_name: 'owner/repo' },
      sender: { login: 'dave' },
    });
    assert.ok(result.ok);
    assert.equal(result.event.type, 'issue_comment');
    assert.equal(result.event.action, 'created');
    assert.deepEqual(result.event.labels, ['bug']);
  });

  test('normalizes pull_request_review_comment events', () => {
    const result = parseEventPayload('pull_request_review_comment', {
      action: 'created',
      pull_request: { head: { ref: 'feat/z', sha: 'ghi789' } },
      comment: { id: 88 },
      repository: { full_name: 'owner/repo' },
      sender: { login: 'erin' },
    });
    assert.ok(result.ok);
    assert.equal(result.event.type, 'pull_request_review_comment');
    assert.equal(result.event.branch, 'feat/z');
  });

  test('normalizes pull_request_review events', () => {
    const result = parseEventPayload('pull_request_review', {
      action: 'submitted',
      pull_request: { head: { ref: 'feat/y', sha: 'def456' } },
      review: { id: 9 },
      repository: { full_name: 'owner/repo' },
      sender: { login: 'carol' },
    });
    assert.ok(result.ok);
    assert.equal(result.event.action, 'submitted');
    assert.equal(result.event.branch, 'feat/y');
  });

  test('normalizes workflow_run events with conclusion', () => {
    const result = parseEventPayload('workflow_run', workflowRunPayload('completed'));
    assert.ok(result.ok);
    assert.equal(result.event.type, 'workflow_run');
    assert.equal(result.event.conclusion, 'failure');
    assert.equal(result.event.workflow, 'CI');
    assert.equal(result.event.branch, 'main');
  });

  test('reports unsupported events safely', () => {
    const result = parseEventPayload('stars', { action: 'created' });
    assert.ok(!result.ok);
    assert.equal(result.reason, 'unsupported');
  });

  test('reports malformed payloads safely', () => {
    const result = parseEventPayload('issues', { action: 'opened' });
    assert.ok(!result.ok);
    assert.equal(result.reason, 'malformed');
  });
});

describe('matchRoute', () => {
  const config = safeParseConfig({
    routes: {
      'pull_request.opened': 'review',
      'workflow_run.completed.failure': 'ci-fix',
    },
  });
  assert.ok(config.ok);
  const routes = config.config.routes;

  test('matches the first route by event + action', () => {
    const event = parseEventPayload('pull_request', prPayload('opened'));
    assert.ok(event.ok);
    const match = matchRoute(routes, event.event);
    assert.ok(match);
    assert.equal(match.agent, 'review');
  });

  test('does not match a different action on the same family', () => {
    const event = parseEventPayload('pull_request', prPayload('closed'));
    assert.ok(event.ok);
    assert.equal(matchRoute(routes, event.event), null);
  });

  test('does not match a different conclusion on workflow_run', () => {
    const event = parseEventPayload('workflow_run', workflowRunPayload('completed', {
      workflow_run: { id: 55, name: 'CI', head_branch: 'main', conclusion: 'success' },
    }));
    assert.ok(event.ok);
    assert.equal(matchRoute(routes, event.event), null);
  });
});

describe('createEventRouter', () => {
  test('dispatches to the configured agent and remembers the delivery', async () => {
    const store = createMemoryDeliveryStore();
    const result = safeParseConfig({ routes: { 'issues.opened': 'planner' } });
    assert.ok(result.ok);
    const router = createEventRouter(result.config, { store });

    const event = parseEventPayload('issues', {
      action: 'opened',
      issue: { number: 4 },
      repository: { full_name: 'owner/repo' },
      sender: { login: 'bob' },
    });
    assert.ok(event.ok);

    const first = await router.route(event.event);
    assert.deepEqual(first, { outcome: 'dispatch', agent: 'planner', route: result.config.routes[0] });

    // A redelivered event is ignored as a duplicate.
    const second = await router.route(event.event);
    assert.equal(second.outcome, 'ignore');
    if (second.outcome === 'ignore') assert.equal(second.reason, 'duplicate');
  });

  test('routes on the three-part labeled shorthand', async () => {
    const result = safeParseConfig({ routes: { 'issues.labeled.implement': 'implementation' } });
    assert.ok(result.ok);
    const router = createEventRouter(result.config);

    const labeled = parseEventPayload('issues', {
      action: 'labeled',
      issue: { number: 7, labels: [{ name: 'implement' }] },
      repository: { full_name: 'owner/repo' },
      sender: { login: 'alice' },
    });
    assert.ok(labeled.ok);
    const hit = await router.route(labeled.event);
    assert.equal(hit.outcome, 'dispatch');

    const otherLabel = parseEventPayload('issues', {
      action: 'labeled',
      issue: { number: 8, labels: [{ name: 'docs' }] },
      repository: { full_name: 'owner/repo' },
      sender: { login: 'alice' },
    });
    assert.ok(otherLabel.ok);
    const miss = await router.route(otherLabel.event);
    assert.equal(miss.outcome, 'ignore');
  });

  test('ignores unconfigured events without throwing', async () => {
    const result = safeParseConfig({ routes: { 'issues.opened': 'planner' } });
    assert.ok(result.ok);
    const router = createEventRouter(result.config);

    const event = parseEventPayload('pull_request', prPayload('closed'));
    assert.ok(event.ok);
    const decision = await router.route(event.event);
    assert.equal(decision.outcome, 'ignore');
    if (decision.outcome === 'ignore') assert.equal(decision.reason, 'unconfigured');
  });

  test('filters by actor, branch, label, and repository', async () => {
    const result = safeParseConfig({
      routes: [
        {
          event: 'pull_request',
          agent: 'security',
          filter: { branch: ['main'], label: ['security'], actor: ['bot'], repository: ['trusted/repo'] },
        },
      ],
    });
    assert.ok(result.ok);
    const router = createEventRouter(result.config);

    const matching = parseEventPayload('pull_request', prPayload('opened', {
      pull_request: {
        number: 1,
        head: { ref: 'main', sha: 's1' },
        labels: [{ name: 'security' }],
      },
      repository: { full_name: 'trusted/repo' },
      sender: { login: 'bot' },
    }));
    assert.ok(matching.ok);
    const ok = await router.route(matching.event);
    assert.equal(ok.outcome, 'dispatch');

    const excluded = parseEventPayload('pull_request', prPayload('opened', {
      pull_request: { number: 1, head: { ref: 'main', sha: 's1' }, labels: [] },
      repository: { full_name: 'trusted/repo' },
      sender: { login: 'bot' },
    }));
    assert.ok(excluded.ok);
    const no = await router.route(excluded.event);
    assert.equal(no.outcome, 'ignore');
  });
});

describe('delivery stores', () => {
  test('file store persists across instances', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'flue-events-'));
    const file = path.join(dir, 'deliveries.json');
    try {
      const first = createFileDeliveryStore(file);
      await first.remember('workflow_run:completed:owner/repo:55');
      assert.equal(await first.has('workflow_run:completed:owner/repo:55'), true);

      const second = createFileDeliveryStore(file);
      assert.equal(await second.has('workflow_run:completed:owner/repo:55'), true);
      assert.equal(await second.has('nope'), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('file store tolerates a missing or corrupt file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'flue-events-'));
    const file = path.join(dir, 'missing.json');
    try {
      const store = createFileDeliveryStore(file);
      assert.equal(await store.has('x'), false);
      await store.remember('x');
      assert.equal(await store.has('x'), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('loadConfigFromFile integration', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'flue-events-'));
    await writeFile(
      path.join(dir, 'routes.json'),
      JSON.stringify({ routes: { 'pull_request.opened': 'review' } }),
    );
    await writeFile(path.join(dir, 'bad.json'), '{ not json');
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('loads and validates a valid config file', async () => {
    const result = await loadConfigFromFile(path.join(dir, 'routes.json'));
    assert.ok(result.ok);
    assert.equal(result.config.routes[0].agent, 'review');
  });

  test('reports missing files and invalid JSON with actionable issues', async () => {
    const missing = await loadConfigFromFile(path.join(dir, 'nope.json'));
    assert.ok(!missing.ok);
    assert.match(missing.issues.join(' '), /Cannot read config file/);

    const bad = await loadConfigFromFile(path.join(dir, 'bad.json'));
    assert.ok(!bad.ok);
    assert.match(bad.issues.join(' '), /not valid JSON/);
  });
});
