import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import test from 'node:test';
import { createEvaluationDashboard } from '../eval/framework/dashboard.ts';
import { createMemoryBenchmarkStore } from '../eval/framework/store.ts';
import { buildReport } from '../eval/framework/metrics.ts';
import { runBenchmark } from '../eval/framework/runner.ts';
import { capstoneScenarios } from '../eval/repository/scenarios.ts';

test('dashboard serves persisted evidence, compares runs, and rejects writes and foreign hosts', async (t) => {
  const scenario = capstoneScenarios[0];
  const report = await runBenchmark(
    {
      id: 'test',
      name: 'Test',
      repositoryPath: 'eval/fixtures/sample-repo',
      scenarios: [{ ...scenario, prompt: scenario.question }],
    },
    { id: 'test/model', provider: 'test' },
    { mode: 'deterministic', deciders: { [scenario.id]: scenario.decide } },
  );
  const store = createMemoryBenchmarkStore();
  await store.save(report);
  const changed = buildReport({
    ...report,
    runId: 'candidate',
    results: report.results.map((result) => ({
      ...result,
      passed: false,
      answer: '<script>sk-test-secret</script> private-secret',
      metrics: { ...result.metrics, qualityScore: 0 },
    })),
  });
  await store.save(changed);
  const server = createEvaluationDashboard(store, { secrets: ['private-secret'] });
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
  assert.equal(JSON.parse(text).length, 2);
  const regression = await fetch(
    `${base}/api/regression?baseline=${report.runId}&candidate=candidate`,
  );
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
  assert.equal(
    (await fetch(`${base}/api/regression?baseline=${report.runId}&candidate=candidate`)).status,
    409,
  );
});
