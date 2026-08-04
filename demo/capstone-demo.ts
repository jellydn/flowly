/**
 * Day 30 Capstone Demo.
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
 *   npx tsx demo/capstone-demo.ts
 *   npx tsx demo/capstone-demo.ts --json
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDebugLogger,
  createRepositoryReader,
  createStepBudget,
} from '../tools/repository.ts';
import { createReadFileTool } from '../tools/read-file.ts';
import { createRetrieveTool } from '../tools/retrieve.ts';
import { withInspectionBudget } from '../reliability/resilient-tool.ts';
import { buildToolMap, runInvestigation } from '../investigation/loop.ts';
import type { DecisionFn } from '../investigation/types.ts';
import { buildRepositoryIndex } from '../index/repository-indexer.ts';
import { runCapstoneEval } from '../eval/capstone-eval.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(__dirname, '..', 'eval', 'fixtures', 'sample-repo');

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');

  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║     Flue Repo Assistant — Day 30 Capstone Demo                        ║');
  console.log('║     RAG + Tool-Augmented Repository Analysis                          ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log();

  // ── Step 1: Repository Selection ──────────────────────────────────────
  console.log('Step 1: Repository Selection');
  console.log(`  Repository: ${path.relative(path.resolve(__dirname, '..'), fixture)}`);
  console.log();

  // ── Step 2: Indexing ──────────────────────────────────────────────────
  console.log('Step 2: Indexing (TF-IDF)');
  const repository = await createRepositoryReader(fixture);
  const indexStart = Date.now();
  const index = await buildRepositoryIndex(repository);
  const indexTime = Date.now() - indexStart;
  console.log(`  Files indexed:   ${index.stats.filesIndexed}`);
  console.log(`  Chunks indexed:  ${index.stats.chunksIndexed}`);
  console.log(`  Unique terms:    ${index.stats.uniqueTerms}`);
  console.log(`  Build time:      ${indexTime}ms`);
  console.log();

  // ── Step 3: Chat Question ─────────────────────────────────────────────
  const question =
    'Review this repository, explain its architecture, identify the highest-risk issue, and suggest an implementation plan.';
  console.log('Step 3: Chat Question');
  console.log(`  "${question}"`);
  console.log();

  // ── Step 4: RAG Retrieval ─────────────────────────────────────────────
  console.log('Step 4: RAG Retrieval');
  const retrieveResults = index.retrieve(question, 5);
  for (const result of retrieveResults) {
    const firstLine = result.excerpt.split('\n')[0].slice(0, 70);
    console.log(
      `  [score: ${result.score}] ${result.path}:${result.startLine}-${result.endLine} (${result.sourceType})`,
    );
    console.log(`    "${firstLine}..."`);
  }
  console.log();

  // ── Step 5: Tool Execution ────────────────────────────────────────────
  console.log('Step 5: Tool Execution (retrieve → read_file)');

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
  const tools = buildToolMap({
    read_file: withInspectionBudget(createReadFileTool(repository), budget, debug),
    retrieve: withInspectionBudget(createRetrieveTool(repository), budget, debug),
  });

  const investigationStart = Date.now();
  const result = await runInvestigation(question, tools, budget, capstoneDecision);
  const investigationTime = Date.now() - investigationStart;

  console.log(`  Tools used:     ${result.toolsUsed.join(' → ')}`);
  console.log(`  Iterations:     ${result.iterations}`);
  console.log(`  Stop reason:    ${result.stopReason}`);
  console.log(`  Evidence items: ${result.evidence.length}`);
  console.log(`  Latency:        ${investigationTime}ms`);
  console.log();

  // ── Step 6: Cited Answer ──────────────────────────────────────────────
  console.log('Step 6: Cited Answer');
  console.log(`  Confidence: ${result.answer.confidence}`);
  console.log(`  Sources:    ${result.answer.sources.join(', ') || '(none)'}`);
  console.log();
  console.log('  Key findings:');
  for (const finding of result.answer.keyFindings) {
    console.log(`    • ${finding.finding} (${finding.citation})`);
  }
  console.log();
  console.log('  Answer:');
  const answerLines = result.answer.answer.split('\n');
  for (const line of answerLines) {
    console.log(`    ${line}`);
  }
  console.log();

  // ── Step 7: Evaluation Report ─────────────────────────────────────────
  console.log('Step 7: Evaluation Report');
  console.log('  Running 7-scenario evaluation suite...');
  console.log();

  const report = await runCapstoneEval();

  if (jsonMode) {
    console.log(JSON.stringify({ investigation: { question, result }, report }, null, 2));
  } else {
    console.log(`  Scenarios: ${report.totalScenarios}  |  Passed: ${report.passed}  |  Failed: ${report.failed}`);
    console.log();
    console.log('  Metric Summary:');
    console.log(`    Citation Accuracy:    ${report.summary.citationAccuracy}/${report.totalScenarios}`);
    console.log(`    Retrieval Relevance:  ${report.summary.retrievalRelevance}/${report.totalScenarios}`);
    console.log(`    Tool Success:         ${report.summary.toolSuccess}/${report.totalScenarios}`);
    console.log(`    Answer Completeness:  ${report.summary.answerCompleteness}/${report.totalScenarios}`);
    console.log(`    Avg Latency:          ${report.summary.avgLatencyMs}ms`);
    console.log();
    console.log('  Per-scenario results:');
    for (const r of report.results) {
      const status = r.passed ? '✅' : '❌';
      const questionShort = r.question.slice(0, 60);
      console.log(`    ${status} [${r.id}] ${questionShort}`);
      console.log(`       Tools: ${r.toolsUsed.join(' → ') || '(none)'}  |  Latency: ${r.latencyMs}ms`);
    }
  }

  console.log();
  console.log('────────────────────────────────────────────────────────────────────────');
  console.log('Demo complete.');
  console.log();
  console.log('Flow demonstrated:');
  console.log('  GitHub repository → indexing → chat question → RAG retrieval →');
  console.log('  tool execution → cited answer → evaluation report');
  console.log('────────────────────────────────────────────────────────────────────────');
}

main().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
