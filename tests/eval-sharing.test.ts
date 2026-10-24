import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createSharedSnapshot,
  createEvaluationShareServer,
  EvaluationShareStore,
} from '../eval/framework/sharing.ts';
import { runBenchmark } from '../eval/framework/runner.ts';
import { capstoneScenarios } from '../eval/repository/scenarios.ts';

test('sharing strips sensitive content, persists immutable snapshots, and enforces access, expiry, and revocation', async (t) => {
  const scenario = capstoneScenarios[0];
  const report = await runBenchmark(
    {
      id: 'private-suite',
      name: 'Private',
      repositoryPath: 'eval/fixtures/sample-repo',
      scenarios: [{ ...scenario, prompt: scenario.question }],
    },
    { id: 'private/model', provider: 'test' },
    { mode: 'deterministic', deciders: { [scenario.id]: scenario.decide } },
  );
  report.results[0].answer = 'opaque-password /home/private/project sk-sensitive';
  report.results[0].citedSources = ['/home/private/project'];
  report.results[0].id = 'opaque-password';
  report.results[0].metrics.costUsd = Number.NaN;
  report.model.label = 'opaque-password';
  const snapshot = createSharedSnapshot(report);
  const serialized = JSON.stringify(snapshot);
  for (const secret of [
    'opaque-password',
    '/home/private',
    'sk-sensitive',
    'private-suite',
    'private/model',
  ])
    assert.ok(!serialized.includes(secret));
  assert.equal(snapshot.summary.costUsd, null);
  assert.equal(snapshot.scenarios[0].costUsd, null);
  assert.deepEqual(snapshot.lineage, report.lineage);
  assert.throws(() => createSharedSnapshot({ ...report, lineage: undefined }));

  const dir = await mkdtemp(path.join(tmpdir(), 'flowly-shares-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const file = path.join(dir, 'shares.sqlite');
  let store = new EvaluationShareStore(file);
  const published = store.publish(snapshot, 60, 1000);
  snapshot.summary.qualityScore = 0;
  assert.notEqual(
    store.read(published.id, published.token, 1001)?.snapshot.summary.qualityScore,
    0,
  );
  assert.equal(store.read(published.id, 'wrong', 1001), null);
  assert.equal(
    store.read(published.id, published.token, 60999)?.snapshotDigest,
    published.snapshotDigest,
  );
  assert.equal(store.read(published.id, published.token, 61000), null);
  assert.throws(() => store.publish(snapshot, 59));
  assert.throws(() => store.publish(snapshot, 2592001));
  assert.throws(() => store.publish({ ...snapshot, answer: 'secret' } as typeof snapshot, 60));
  store.close();
  store = new EvaluationShareStore(file);
  assert.ok(store.read(published.id, published.token, 1001));
  store.revoke(published.id);
  assert.equal(store.read(published.id, published.token, 1001), null);

  const admin = 'test-admin-'.repeat(4);
  const server = createEvaluationShareServer(store, admin);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          store.close();
          resolve();
        });
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const body = JSON.stringify({ snapshot, ttlSeconds: 60 });
  assert.equal((await fetch(`${base}/api/shares`, { method: 'POST', body })).status, 401);
  const headers = { Authorization: `Bearer ${admin}` };
  const created = await fetch(`${base}/api/shares`, { method: 'POST', headers, body });
  assert.equal(created.status, 201);
  const shared = await created.json();
  const endpoint = `${base}/api/shares/${shared.id}`;
  assert.equal((await fetch(endpoint)).status, 404);
  assert.equal(
    (await fetch(endpoint, { headers })).status,
    404,
    'admin is not a reader capability',
  );
  const reader = { Authorization: `Bearer ${shared.token}` };
  const received = await fetch(endpoint, { headers: reader });
  assert.equal(received.status, 200);
  assert.equal((await received.json()).snapshotDigest, shared.snapshotDigest);
  assert.equal(received.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(endpoint, { method: 'PUT', headers, body })).status, 405);
  assert.equal((await fetch(endpoint, { method: 'DELETE', headers: reader })).status, 401);
  assert.equal((await fetch(endpoint, { method: 'DELETE', headers })).status, 204);
  assert.equal((await fetch(endpoint, { headers: reader })).status, 404);
  assert.equal((await fetch(`${base}/api/reports`)).status, 404);
  assert.equal(
    (
      await fetch(`${base}/api/shares`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ snapshot: { ...snapshot, prompt: 'secret' }, ttlSeconds: 60 }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${base}/api/shares`, {
        method: 'POST',
        headers,
        body: 'x'.repeat(256 * 1024 + 1),
      })
    ).status,
    413,
  );
});
