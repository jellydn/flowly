import { readFile } from 'node:fs/promises';
import { recommendModelRouting } from '../eval/framework/routing.ts';
import { createFileBenchmarkStore } from '../eval/framework/store.ts';

async function main() {
  const [file, ...rest] = process.argv.slice(2);
  if (!file || rest.length) throw new Error('Usage: npm run eval:recommend -- <policy.json>');
  const policy = JSON.parse(await readFile(file, 'utf8'));
  const store = createFileBenchmarkStore(
    process.env.FLOWLY_EVAL_RESULTS_DIR ?? process.env.FLUE_EVAL_RESULTS_DIR ?? 'eval/results',
  );
  const advice = recommendModelRouting(await store.list(), policy);
  process.stdout.write(`${JSON.stringify(advice, null, 2)}\n`);
  if (advice.decisions.some((decision) => !decision.recommendedModel)) process.exitCode = 1;
}
main().catch(() => {
  console.error('Cannot recommend routing. Check the policy file and saved reports.');
  process.exitCode = 2;
});
