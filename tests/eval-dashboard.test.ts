import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createEvaluationDashboard } from '../eval/framework/dashboard.ts';
import { createFileBenchmarkStore, createMemoryBenchmarkStore } from '../eval/framework/store.ts';
import { buildReport } from '../eval/framework/metrics.ts';
import { runBenchmark } from '../eval/framework/runner.ts';
import { capstoneScenarios } from '../eval/repository/scenarios.ts';

test('dashboard serves persisted evidence, compares runs, and rejects writes and foreign hosts', async (t) => {
  const scenario = capstoneScenarios[0];
  const secrets = ['private-secret', 'private"password', 'private\\password', 'private\npassword'];
  const report = await runBenchmark(
    {
      id: 'coding-task',
      name: 'Test',
      repositoryPath: 'eval/fixtures/sample-repo',
      scenarios: [{ ...scenario, prompt: scenario.question }],
    },
    { id: 'test/model', provider: 'test' },
    { mode: 'deterministic', deciders: { [scenario.id]: scenario.decide } },
  );
  const store = createMemoryBenchmarkStore();
  report.runId = 'sk-baseline-123';
  await store.save(report);
  const changed = buildReport({
    ...report,
    runId: 'sk-candidate-456',
    results: report.results.map((result) => ({
      ...result,
      passed: false,
      answer: `<script>sk-test-secret</script> ${secrets.join(' ')}`,
      errors: secrets,
      metrics: { ...result.metrics, qualityScore: 0 },
    })),
  });
  await store.save(changed);
  const server = createEvaluationDashboard(store, { secrets });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${base}/api/reports`);
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!text.includes('sk-test-secret'));
  assert.ok(!text.includes('private-secret'));
  assert.match(text, /redacted/);
  const projected = JSON.parse(text);
  assert.equal(projected.length, 2);
  const baseline = projected.find((item: { failed: number }) => item.failed === 0);
  const candidate = projected.find((item: { failed: number }) => item.failed === 1);
  assert.equal(baseline.suiteId, 'coding-task', 'task is not a secret token prefix');
  assert.equal(baseline.runId, candidate.runId, 'exercise colliding redacted display labels');

  // Run the served client with a minimal DOM; assert displayed cells, not formatter internals.
  class Element {
    textContent = '';
    value = '';
    className = '';
    children: Element[] = [];
    get lastChild() {
      return this.children.at(-1)!;
    }
    replaceChildren(...children: Element[]) {
      this.children = children;
    }
    append(...children: Element[]) {
      this.children.push(...children);
    }
    add(child: Element) {
      this.append(child);
    }
    addEventListener() {}
  }
  const elements = new Map<string, Element>();
  const costs = [0, 0.000001, 0.000049, 0.0001, null];
  runInNewContext(await (await fetch(`${base}/dashboard.js`)).text(), {
    document: {
      createElement: () => new Element(),
      getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
      },
    },
    Option: Element,
    fetch: async () => ({
      ok: true,
      json: async () =>
        costs.map((costUsd) => ({ ...baseline, summary: { ...baseline.summary, costUsd } })),
    }),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    elements.get('runs')!.children.map((row) => row.children[4].textContent),
    ['$0.0000', '<$0.0001', '<$0.0001', '$0.0001', 'Unknown'],
  );

  const evidence = JSON.parse(candidate.results[0].evidence);
  for (const secret of secrets) {
    assert.ok(!evidence.answer.includes(secret));
    assert.ok(!evidence.errors.includes(secret));
  }
  assert.deepEqual(evidence.citationAccuracy, changed.results[0].metrics.citationAccuracy);
  assert.deepEqual(evidence.retrievalRelevance, changed.results[0].metrics.retrievalRelevance);
  assert.deepEqual(evidence.answerCompleteness, changed.results[0].metrics.answerCompleteness);
  assert.match(baseline.key, /^[a-f0-9]{64}$/);
  assert.notEqual(baseline.key, candidate.key, 'redacted labels must not collapse selection keys');
  const comparison = new URLSearchParams({ baseline: baseline.key, candidate: candidate.key });
  const regression = await fetch(`${base}/api/regression?${comparison}`);
  assert.equal(regression.status, 200);
  assert.equal((await regression.json()).passed, false);
  assert.equal(
    (await fetch(`${base}/api/regression?baseline=missing&candidate=candidate`)).status,
    404,
  );
  assert.equal((await fetch(`${base}/api/reports`, { method: 'POST' })).status, 405);
  assert.equal(
    await new Promise((resolve, reject) => {
      get(`${base}/api/reports`, { headers: { Host: 'attacker.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    }),
    403,
  );
  assert.match(
    (await fetch(base)).headers.get('content-security-policy') ?? '',
    /frame-ancestors 'none'/,
  );
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  await store.save({ ...changed, lineage: undefined });
  assert.equal((await fetch(`${base}/api/regression?${comparison}`)).status, 409);

  // Exercise the CLI's environment selection, not just explicitly supplied needles.
  const dir = await mkdtemp(path.join(tmpdir(), 'flowly-dashboard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const authConfig = JSON.stringify({ auths: { registry: { auth: 'synthetic-registry-auth' } } });
  changed.results[0].answer = authConfig;
  await createFileBenchmarkStore(dir).save(changed);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/eval-dashboard.ts'], {
    env: {
      ...process.env,
      PORT: String(address.port),
      FLOWLY_EVAL_RESULTS_DIR: dir,
      DOCKER_AUTH_CONFIG: authConfig,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  });
  await once(child.stdout, 'data', { signal: AbortSignal.timeout(10_000) });
  const cliReports = await (await fetch(`${base}/api/reports`)).json();
  assert.equal(JSON.parse(cliReports[0].results[0].evidence).answer, '[redacted]');
});
