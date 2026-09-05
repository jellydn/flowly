import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  capstoneScenarios,
  runCapstoneEval,
  type EvalReport,
  type ScenarioResult,
} from '../eval/capstone-eval.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(__dirname, '..', 'eval', 'fixtures', 'sample-repo');

describe('capstone evaluation scenarios', () => {
  test('defines at least 5 evaluation scenarios', () => {
    assert.ok(
      capstoneScenarios.length >= 5,
      `expected ≥5 scenarios, got ${capstoneScenarios.length}`,
    );
  });

  test('every scenario has required fields', () => {
    for (const scenario of capstoneScenarios) {
      assert.ok(scenario.id, 'scenario must have an id');
      assert.ok(scenario.question, 'scenario must have a question');
      assert.ok(typeof scenario.requiresCitation === 'boolean');
      assert.ok(typeof scenario.requiresToolCall === 'boolean');
      assert.ok(typeof scenario.decide === 'function');
    }
  });

  test('at least one scenario requires citation', () => {
    assert.ok(
      capstoneScenarios.some((s) => s.requiresCitation),
      'at least one scenario should require citation',
    );
  });

  test('at least one scenario requires a tool call', () => {
    assert.ok(
      capstoneScenarios.some((s) => s.requiresToolCall),
      'at least one scenario should require a tool call',
    );
  });

  test('at least one scenario is conceptual (no tool call)', () => {
    assert.ok(
      capstoneScenarios.some((s) => !s.requiresToolCall),
      'at least one scenario should be conceptual',
    );
  });
});

describe('capstone evaluation run', () => {
  test('produces a complete report with all metrics', async () => {
    const report: EvalReport = await runCapstoneEval(capstoneScenarios, fixture);

    assert.equal(report.totalScenarios, capstoneScenarios.length);
    assert.equal(report.passed + report.failed, report.totalScenarios);
    assert.equal(report.results.length, capstoneScenarios.length);

    // Every result has all four metrics
    for (const result of report.results as ScenarioResult[]) {
      assert.ok(result.metrics.citationAccuracy, 'missing citationAccuracy metric');
      assert.ok(result.metrics.retrievalRelevance, 'missing retrievalRelevance metric');
      assert.ok(result.metrics.toolSuccess, 'missing toolSuccess metric');
      assert.ok(result.metrics.answerCompleteness, 'missing answerCompleteness metric');
      assert.ok(typeof result.latencyMs === 'number');
      assert.ok(result.latencyMs >= 0);
      assert.ok(Array.isArray(result.toolsUsed));
      assert.ok(Array.isArray(result.citedSources));
      assert.ok(Array.isArray(result.errors));
    }

    // Summary has all metrics
    assert.ok(typeof report.summary.citationAccuracy === 'number');
    assert.ok(typeof report.summary.retrievalRelevance === 'number');
    assert.ok(typeof report.summary.toolSuccess === 'number');
    assert.ok(typeof report.summary.answerCompleteness === 'number');
    assert.ok(typeof report.summary.avgLatencyMs === 'number');
  });

  test('the capstone demo question (cap-6) runs and produces a result', async () => {
    const capstoneQuestion = capstoneScenarios.find((s) => s.id === 'cap-6');
    assert.ok(capstoneQuestion, 'cap-6 scenario must exist');
    const report = await runCapstoneEval([capstoneQuestion], fixture);
    assert.equal(report.results.length, 1);
    const result = report.results[0];
    assert.ok(result.toolsUsed.includes('retrieve'), 'capstone question should use retrieve');
    assert.ok(result.toolsUsed.includes('read_file'), 'capstone question should use read_file');
  });

  test('conceptual question (cap-7) requires no tool calls', async () => {
    const conceptual = capstoneScenarios.find((s) => s.id === 'cap-7');
    assert.ok(conceptual, 'cap-7 scenario must exist');
    assert.ok(!conceptual.requiresToolCall);
    const report = await runCapstoneEval([conceptual], fixture);
    const result = report.results[0];
    assert.equal(result.toolsUsed.length, 0, 'conceptual question should not call tools');
    assert.ok(
      result.metrics.toolSuccess.passed,
      'tool success should pass for conceptual question',
    );
  });

  test('failures are visible (not silently ignored)', async () => {
    const report = await runCapstoneEval(capstoneScenarios, fixture);
    // At least some scenarios should pass — the test suite is designed to pass
    // but if any fail, the failure detail must be non-empty
    for (const result of report.results) {
      if (!result.passed) {
        const allDetails = [
          result.metrics.citationAccuracy.detail,
          result.metrics.retrievalRelevance.detail,
          result.metrics.toolSuccess.detail,
          result.metrics.answerCompleteness.detail,
        ];
        const hasDetail = allDetails.some((d) => d.length > 0);
        assert.ok(hasDetail, `failed scenario ${result.id} must have failure detail`);
      }
    }
  });
});
