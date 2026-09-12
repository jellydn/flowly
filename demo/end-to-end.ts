/**
 * End-to-end repository analysis demo.
 *
 * Demonstrates the complete end-to-end flow:
 *   GitHub repository → indexing → chat question → RAG retrieval →
 *   tool execution → cited answer → evaluation report
 *
 * The demo runs against the bundled fixture repository using deterministic
 * decision functions (no LLM required). It shows:
 *   1. Repository index construction (TF-IDF)
 *   2. RAG retrieval with ranked results
 *   3. Tool execution (retrieve → read_file)
 *   4. Cited answer with confidence
 *   5. Evaluation report with pass/fail metrics
 *
 * Run with:
 *   npm run demo:end-to-end
 *   npm run demo:end-to-end -- --json
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDebugLogger,
  createRepositoryReader,
  createStepBudget,
} from '../tools/repository.ts';
import { createInspectionRegistry } from '../tools/inspection-registry.ts';
import { createReliabilityLogger } from '../reliability/observability.ts';
import { noFailureInjection } from '../reliability/failure-injection.ts';
import { DEFAULT_RETRY_CONFIG } from '../reliability/retry.ts';
import { buildToolMap, runInvestigation } from '../investigation/loop.ts';
import type { DecisionFn } from '../investigation/types.ts';
import { buildRepositoryIndex } from '../index/repository-indexer.ts';
import { runCapstoneEval } from '../eval/repository/scenarios.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(__dirname, '..', 'eval', 'fixtures', 'sample-repo');

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const log: typeof console.log = jsonMode ? console.error.bind(console) : console.log;

  log('╔══════════════════════════════════════════════════════════════════════╗');
  log('║     Flowly — End-to-End Repository Analysis                           ║');
  log('║     RAG + Tool-Augmented Repository Analysis                          ║');
  log('╚══════════════════════════════════════════════════════════════════════╝');
  log();

  // ── Step 1: Repository Selection ──────────────────────────────────────
  log('Step 1: Repository Selection');
  log(`  Repository: ${path.relative(path.resolve(__dirname, '..'), fixture)}`);
  log();

  // ── Step 2: Indexing ──────────────────────────────────────────────────
  log('Step 2: Indexing (TF-IDF)');
  const repository = await createRepositoryReader(fixture);
  const indexStart = Date.now();
  const index = await buildRepositoryIndex(repository);
  const indexTime = Date.now() - indexStart;
  log(`  Files indexed:   ${index.stats.filesIndexed}`);
  log(`  Chunks indexed:  ${index.stats.chunksIndexed}`);
  log(`  Unique terms:    ${index.stats.uniqueTerms}`);
  log(`  Build time:      ${indexTime}ms`);
  log();

  // ── Step 3: Chat Question ─────────────────────────────────────────────
  const question =
    'Review this repository, explain its architecture, identify the highest-risk issue, and suggest an implementation plan.';
  log('Step 3: Chat Question');
  log(`  "${question}"`);
  log();

  // ── Step 4: RAG Retrieval ─────────────────────────────────────────────
  log('Step 4: RAG Retrieval');
  const retrieveResults = index.retrieve(question, 5);
  for (const result of retrieveResults) {
    const firstLine = result.excerpt.split('\n')[0].slice(0, 70);
    log(
      `  [score: ${result.score}] ${result.path}:${result.startLine}-${result.endLine} (${result.sourceType})`,
    );
    log(`    "${firstLine}..."`);
  }
  log();

  // ── Step 5: Tool Execution ────────────────────────────────────────────
  log('Step 5: Tool Execution (retrieve → read_file)');

  const capstoneDecision: DecisionFn = async (state) => {
    if (state.iteration === 0)
      return {
        type: 'call',
        tool: 'retrieve',
        input: { query: 'architecture overview entry point authentication', topK: 5 },
      };
    if (state.iteration === 1) {
      const docEv = state.evidence.find((e) => e.filePath === 'docs/architecture.md');
      if (docEv)
        return {
          type: 'call',
          tool: 'read_file',
          input: { path: 'docs/architecture.md', startLine: 1 },
        };
    }
    if (state.iteration === 2) {
      const codeEv = state.evidence.find((e) => e.filePath === 'src/index.ts');
      if (codeEv)
        return {
          type: 'call',
          tool: 'read_file',
          input: { path: 'src/index.ts', startLine: 1 },
        };
    }
    if (state.iteration === 3) {
      const authEv = state.evidence.find((e) => e.filePath === 'src/auth.ts');
      if (authEv)
        return {
          type: 'call',
          tool: 'read_file',
          input: { path: 'src/auth.ts', startLine: 1 },
        };
    }
    return { type: 'stop', reason: 'sufficient evidence for architecture review' };
  };

  const budget = createStepBudget(8);
  const debug = createDebugLogger(false);
  // The registry is the single composition point: it wraps every raw tool
  // with the same reliability policy and budget, so the demo exercises the
  // same tool set the live agent and eval runners use.
  const registry = createInspectionRegistry({
    repository,
    budget,
    debug,
    retryConfig: DEFAULT_RETRY_CONFIG,
    reliabilityLog: createReliabilityLogger(false),
    injector: noFailureInjection,
  });
  const tools = buildToolMap(registry.tools);

  const investigationStart = Date.now();
  const result = await runInvestigation(question, tools, budget, capstoneDecision);
  const investigationTime = Date.now() - investigationStart;

  log(`  Tools used:     ${result.toolsUsed.join(' → ')}`);
  log(`  Iterations:     ${result.iterations}`);
  log(`  Stop reason:    ${result.stopReason}`);
  log(`  Evidence items: ${result.evidence.length}`);
  log(`  Latency:        ${investigationTime}ms`);
  log();

  // ── Step 6: Cited Answer ──────────────────────────────────────────────
  log('Step 6: Cited Answer');
  log(`  Confidence: ${result.answer.confidence}`);
  log(`  Sources:    ${result.answer.sources.join(', ') || '(none)'}`);
  log();
  log('  Key findings:');
  for (const finding of result.answer.keyFindings) {
    log(`    • ${finding.finding} (${finding.citation})`);
  }
  log();
  log('  Answer:');
  const answerLines = result.answer.answer.split('\n');
  for (const line of answerLines) {
    log(`    ${line}`);
  }
  log();

  // ── Step 7: Evaluation Report ─────────────────────────────────────────
  log('Step 7: Evaluation Report');
  log('  Running 7-scenario evaluation suite...');
  log();

  const report = await runCapstoneEval();

  if (jsonMode) {
    console.log(JSON.stringify({ investigation: { question, result }, report }, null, 2));
    return;
  }

  log(
    `  Scenarios: ${report.totalScenarios}  |  Passed: ${report.passed}  |  Failed: ${report.failed}`,
  );
  log();
  log('  Metric Summary:');
  log(`    Citation Accuracy:    ${report.summary.citationAccuracy}/${report.totalScenarios}`);
  log(`    Retrieval Relevance:  ${report.summary.retrievalRelevance}/${report.totalScenarios}`);
  log(`    Tool Success:         ${report.summary.toolSuccess}/${report.totalScenarios}`);
  log(`    Answer Completeness:  ${report.summary.answerCompleteness}/${report.totalScenarios}`);
  log(`    Avg Latency:          ${report.summary.avgLatencyMs}ms`);
  log();
  log('  Per-scenario results:');
  for (const r of report.results) {
    const status = r.passed ? '✅' : '❌';
    const questionShort = r.question.slice(0, 60);
    log(`    ${status} [${r.id}] ${questionShort}`);
    log(`       Tools: ${r.toolsUsed.join(' → ') || '(none)'}  |  Latency: ${r.latencyMs}ms`);
  }

  log();
  log('────────────────────────────────────────────────────────────────────────');
  log('Demo complete.');
  log();
  log('Flow demonstrated:');
  log('  GitHub repository → indexing → chat question → RAG retrieval →');
  log('  tool execution → cited answer → evaluation report');
  log('────────────────────────────────────────────────────────────────────────');
}

main().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
