import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createEvaluationShareServer, EvaluationShareStore } from '../eval/framework/sharing.ts';

const file = process.env.FLOWLY_SHARE_DB ?? '.eval-shares/shares.sqlite';
const token = process.env.FLOWLY_SHARE_ADMIN_TOKEN ?? '';
const port = Number(process.env.PORT ?? 4311);
if (token.length < 32)
  throw new Error('Set FLOWLY_SHARE_ADMIN_TOKEN to a random secret of at least 32 characters');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
const store = new EvaluationShareStore(file);
const server = createEvaluationShareServer(store, token);
server.listen(port, process.env.FLOWLY_SHARE_BIND ?? '127.0.0.1', () =>
  console.log(`Evaluation sharing listening on port ${port}`),
);
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    server.close(() => {
      store.close();
    });
  });
