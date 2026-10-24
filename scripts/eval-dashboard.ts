import { createEvaluationDashboard } from '../eval/framework/dashboard.ts';
import { createFileBenchmarkStore } from '../eval/framework/store.ts';

const port = Number(process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const secrets = Object.entries(process.env)
  .filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD|AUTH_CONFIG/.test(key))
  .map(([, value]) => value ?? '');
const store = createFileBenchmarkStore(
  process.env.FLOWLY_EVAL_RESULTS_DIR ?? process.env.FLUE_EVAL_RESULTS_DIR ?? 'eval/results',
);
createEvaluationDashboard(store, {
  secrets,
  allowedHost: process.env.FLOWLY_DASHBOARD_HOST,
}).listen(port, '127.0.0.1', () => {
  console.log(`Read-only evaluation dashboard listening on port ${port}`);
});
