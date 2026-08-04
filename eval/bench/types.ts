/**
 * Core types for the model evaluation benchmark framework (issue #38).
 *
 * A benchmark is a named suite of scenarios. Each scenario is a prompt plus
 * the expected outcome (sources that must be cited, keywords that must
 * appear, whether a tool call is required). Running a suite against a model
 * produces a BenchmarkReport with per-scenario metrics and an aggregate
 * summary. Reports can be persisted (see store.ts) so models can be compared
 * on a leaderboard and regressions across model versions can be caught.
 */

/** Pricing per 1K tokens, in USD. */
export type ModelPricing = {
  inputPer1kUsd: number;
  outputPer1kUsd: number;
};

/**
 * A model that can be evaluated. `id` is the provider-qualified specifier
 * (e.g. "openrouter/qwen/qwen3-coder"). Pricing is optional; when absent,
 * cost is not estimated.
 */
export type ModelSpec = {
  id: string;
  provider: string;
  label?: string;
  pricing?: ModelPricing;
  /**
   * Environment variable holding the API key for this model's provider
   * (e.g. "OPENAI_API_KEY"). When absent, a per-provider default key env is
   * used (see createProviderClient in providers.ts).
   */
  apiKeyEnv?: string;
  /**
   * OpenAI-compatible base URL for this model's provider. When absent, a
   * known per-provider endpoint is used; unknown providers require this.
   */
  baseUrl?: string;
};

/** One evaluation question in a benchmark suite. */
export type BenchmarkScenario = {
  id: string;
  prompt: string;
  /** Source files the answer must cite (path prefixes match). */
  expectedSources?: string[];
  /** Keywords the answer (or evidence) must contain. */
  expectedKeywords?: string[];
  /** Whether the answer must cite sources. */
  requiresCitation?: boolean;
  /** Whether a tool call is required to answer. */
  requiresToolCall?: boolean;
  /** Per-scenario inspection budget override. */
  maxSteps?: number;
};

/** A named, versioned collection of scenarios. */
export type BenchmarkSuite = {
  id: string;
  name: string;
  description?: string;
  /** Default inspection budget per scenario. */
  maxSteps?: number;
  /** Repository path the suite evaluates against (fixture by default). */
  repositoryPath?: string;
  scenarios: BenchmarkScenario[];
};

/** Pass/fail for one metric dimension, with an explanation. */
export type MetricPass = {
  passed: boolean;
  detail: string;
};

/** Per-scenario evaluation result. */
export type ScenarioResult = {
  id: string;
  prompt: string;
  passed: boolean;
  metrics: {
    /** 0..1 quality score (average of measured dimensions). */
    qualityScore: number;
    latencyMs: number;
    tokensIn: number;
    tokensOut: number;
    /** USD cost; billed when the provider reported it, estimated otherwise. */
    costUsd: number;
    /**
     * Whether tokens/cost came from the provider ('provider') or a heuristic
     * ('estimated'). Reports saved before this field existed omit it; treat
     * undefined as 'estimated'.
     */
    usageSource?: 'provider' | 'estimated';
    toolSuccess: MetricPass;
    citationAccuracy: MetricPass;
    retrievalRelevance: MetricPass;
    answerCompleteness: MetricPass;
    /** Null when patch applicability was not measured for this scenario. */
    patchApplicability: MetricPass | null;
    /** Human accept/reject verdict; undefined until reviewed (see recordHumanAcceptance). */
    humanAccepted?: boolean;
  };
  toolsUsed: string[];
  citedSources: string[];
  errors: string[];
  answer: string;
  confidence: string;
  /** Free-text rationale from the judge (deterministic or LLM). */
  judgeRationale?: string;
};

/** Aggregate summary shared by reports, leaderboard rows, and comparisons. */
export type BenchmarkSummary = {
  qualityScore: number;
  avgLatencyMs: number;
  totalTokens: number;
  costUsd: number;
  toolSuccessRate: number;
  /** NaN when patch applicability was not measured. */
  patchApplicabilityRate: number;
  /** NaN when no scenario has been human-reviewed yet. */
  humanAcceptanceRate: number;
};

/** Full result of running one suite against one model. */
export type BenchmarkReport = {
  runId: string;
  suiteId: string;
  suiteName: string;
  model: { id: string; provider: string; label: string };
  ranAt: string;
  mode: 'deterministic' | 'live';
  totalScenarios: number;
  passed: number;
  failed: number;
  results: ScenarioResult[];
  summary: BenchmarkSummary;
  /**
   * Judge used for scoring: 'keyword' (default) or the model id of the
   * LLM-as-a-judge. Absent on reports saved before this field existed;
   * treat as 'keyword'.
   */
  judge?: 'keyword' | string;
};

/** One row in the cross-model leaderboard for a suite. */
export type LeaderboardEntry = {
  modelId: string;
  modelLabel: string;
  provider: string;
  suiteId: string;
  runId: string;
  ranAt: string;
  qualityScore: number;
  avgLatencyMs: number;
  totalTokens: number;
  costUsd: number;
  toolSuccessRate: number;
};

/** Side-by-side model comparison for a suite. */
export type ModelComparison = {
  suiteId: string;
  suiteName: string;
  /** Judge used for all models: 'keyword' or the LLM judge model id. */
  judgeLabel?: string;
  models: Array<{
    model: { id: string; provider: string; label: string };
    runId: string;
    passed: number;
    total: number;
    summary: BenchmarkSummary;
  }>;
};

/** Supported benchmark execution modes. */
export type BenchmarkMode = 'deterministic' | 'live';
