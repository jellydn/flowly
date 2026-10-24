import { createSharedSnapshot } from '../eval/framework/sharing.ts';
import { createFileBenchmarkStore } from '../eval/framework/store.ts';

async function main() {
  const [command, id, ttl, ...rest] = process.argv.slice(2);
  if (
    !id ||
    rest.length ||
    !['preview', 'publish', 'revoke'].includes(command) ||
    (command !== 'publish' && ttl !== undefined)
  )
    throw new Error(
      'Usage: eval:share preview <runId> | publish <runId> <expirySeconds> | revoke <shareId>',
    );
  const store = createFileBenchmarkStore(
    process.env.FLOWLY_EVAL_RESULTS_DIR ?? process.env.FLUE_EVAL_RESULTS_DIR ?? 'eval/results',
  );
  const report = command === 'revoke' ? null : await store.load(id);
  if (command !== 'revoke' && !report) throw new Error('Report not found');
  const snapshot = report ? createSharedSnapshot(report) : null;
  if (command === 'preview') {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  const origin = new URL(process.env.FLOWLY_SHARE_ORIGIN ?? '');
  if (
    (origin.protocol !== 'https:' &&
      !(
        origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
      )) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/'
  )
    throw new Error(
      'FLOWLY_SHARE_ORIGIN must be an HTTPS origin (HTTP is permitted only on loopback for development)',
    );
  const token = process.env.FLOWLY_SHARE_ADMIN_TOKEN ?? '';
  if (token.length < 32) throw new Error('Sharing requires FLOWLY_SHARE_ADMIN_TOKEN');
  if (command === 'revoke' && !/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid share ID');
  const ttlSeconds = Number(ttl);
  if (
    command === 'publish' &&
    (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 2592000)
  )
    throw new Error('Expiry must be 60–2592000 seconds');
  const response = await fetch(
    new URL(command === 'publish' ? '/api/shares' : `/api/shares/${id}`, origin),
    {
      method: command === 'publish' ? 'POST' : 'DELETE',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: command === 'publish' ? JSON.stringify({ snapshot, ttlSeconds }) : undefined,
    },
  );
  if (!response.ok) throw new Error(`Sharing failed (HTTP ${response.status})`);
  if (command === 'revoke') {
    console.log('Share revoked');
    return;
  }
  const published = (await response.json()) as {
    id: string;
    token: string;
    expiresAt: string;
    snapshotDigest: string;
  };
  console.log(
    JSON.stringify(
      {
        ...published,
        token: undefined,
        url: `${origin.origin}/s/${published.id}#${published.token}`,
      },
      null,
      2,
    ),
  );
}
main().catch(() => {
  console.error(
    'Sharing failed. Check command arguments, report lineage, expiry, origin, and admin credentials. No report content was logged.',
  );
  process.exitCode = 1;
});
