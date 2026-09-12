/**
 * Judges turn scenario + investigation results into a 0..1 quality score.
 *
 * The keyword judge is deterministic — it derives the score from the four
 * measured dimensions (tool success, citation accuracy, retrieval relevance,
 * answer completeness), so CI runs are reproducible without an LLM.
 *
 * An LLM judge is supported by wrapping a model call function: it receives a
 * structured rubric prompt and must reply with a JSON score. This enables
 * LLM-as-a-judge evaluation while keeping the deterministic path as the
 * default (issue #38).
 */

import type { InvestigationResult } from '../../investigation/types.ts';
import { checkScenario, type ScenarioChecks } from './runner.ts';
import { scoreScenario } from './metrics.ts';
import type { BenchmarkScenario, ModelSpec } from './types.ts';
import { createProviderClient, type ModelCallFn } from './providers.ts';

export type JudgeInput = {
  scenario: BenchmarkScenario;
  result: InvestigationResult;
};

export type JudgeVerdict = {
  /** 0..1 quality score for the scenario. */
  score: number;
  rationale?: string;
};

export type Judge = {
  score(input: JudgeInput): Promise<JudgeVerdict>;
};

/** Deterministic judge: averages the four measured dimension passes. */
export function createKeywordJudge(): Judge {
  return {
    async score({ scenario, result }: JudgeInput): Promise<JudgeVerdict> {
      const checks: ScenarioChecks = checkScenario(scenario, result);
      const score = scoreScenario(scenario, {
        toolSuccess: checks.toolSuccess,
        citationAccuracy: checks.citationAccuracy,
        retrievalRelevance: checks.retrievalRelevance,
        answerCompleteness: checks.answerCompleteness,
      });
      const failures = [
        checks.toolSuccess,
        checks.citationAccuracy,
        checks.retrievalRelevance,
        checks.answerCompleteness,
      ].filter((c) => !c.passed);
      return {
        score,
        rationale:
          failures.length === 0
            ? 'All measured dimensions passed'
            : `Failed dimensions: ${failures.map((f) => f.detail).join('; ')}`,
      };
    },
  };
}

/** Build the rubric prompt passed to an LLM judge. */
export function formatJudgePrompt(
  scenario: BenchmarkScenario,
  answer: string,
  evidenceText: string,
): string {
  return [
    'You are a strict benchmark judge. Score the answer on a 0..1 scale.',
    '',
    'Question:',
    scenario.prompt,
    '',
    scenario.expectedSources?.length
      ? `Expected sources: ${scenario.expectedSources.join(', ')}`
      : 'Expected sources: none',
    scenario.expectedKeywords?.length
      ? `Expected keywords: ${scenario.expectedKeywords.join(', ')}`
      : 'Expected keywords: none',
    scenario.requiresCitation === false
      ? 'Citations not required.'
      : 'Citations required when sources are available.',
    '',
    'Answer:',
    answer,
    '',
    'Evidence:',
    evidenceText.slice(0, 2000),
    '',
    'Reply with ONLY a JSON object: {"score": <0..1 number>, "rationale": "<short reason>"}',
  ].join('\n');
}

/**
 * LLM-as-a-judge: wraps a model call function that receives the rubric prompt
 * and returns a JSON verdict. Non-JSON or out-of-range replies fall back to a
 * neutral 0.5 score rather than failing the run.
 */
export function createLlmJudge(modelCall: (prompt: string) => Promise<string>): Judge {
  const judge = createLlmJudgeFromCall(modelCall);
  return {
    async score(input) {
      return judge.score(input);
    },
  };
}

/**
 * Build an LLM judge from a model spec through the provider registry, so the
 * judge can use a different provider/key than the evaluated model. Throws an
 * actionable error when the provider/key cannot be resolved.
 */
export function createLlmJudgeFromSpec(
  model: ModelSpec,
  env: Record<string, string | undefined> = process.env,
): Judge {
  const modelCall: ModelCallFn = createProviderClient(model, env);
  return createLlmJudgeFromCall(async (prompt) => (await modelCall(prompt)).content);
}

/** Core LLM-judge implementation over a string-reply call function. */
function createLlmJudgeFromCall(modelCall: (prompt: string) => Promise<string>): Judge {
  return {
    async score({ scenario, result }: JudgeInput): Promise<JudgeVerdict> {
      const evidenceText = result.evidence.map((e) => e.excerpt).join('\n');
      const prompt = formatJudgePrompt(scenario, result.answer.answer, evidenceText);
      let reply: string;
      try {
        reply = await modelCall(prompt);
      } catch {
        return { score: 0.5, rationale: 'Judge call failed; neutral score' };
      }
      const parsed = parseVerdict(reply);
      if (parsed) return parsed;
      return { score: 0.5, rationale: 'Judge reply was not parseable JSON; neutral score' };
    },
  };
}

function parseVerdict(reply: string): JudgeVerdict | null {
  try {
    const match = reply.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { score?: unknown; rationale?: unknown };
    if (typeof parsed.score !== 'number' || Number.isNaN(parsed.score)) return null;
    const score = Math.min(1, Math.max(0, parsed.score));
    return {
      score,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : undefined,
    };
  } catch {
    return null;
  }
}
