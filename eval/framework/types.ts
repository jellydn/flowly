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
   * (e.g. "OPENAI_API_KEY"). This override requires an explicit trust opt-in
   * at the provider-client boundary. When absent, a per-provider default key
   * env is used (see createProviderClient in providers.ts).
   */
  apiKeyEnv?: string;
  /**
   * OpenAI-compatible base URL for this model's provider. When absent, a
   * known per-provider endpoint is used. This override requires an explicit
   * trust opt-in; unknown providers can also use FLOWLY_EVAL_BASE_URL.
   */
  baseUrl?: string;
};

/** Repository workload represented by a benchmark scenario. */
export type BenchmarkWorkload =
  | { type: 'repository-question' }
  | {
      type: 'github-issue';
      repository: string;
      number: number;
      title: string;
      body: string;
    }
  | {
      type: 'pull-request-review';
      repository: string;
      number: number;
      title: string;
      body?: string;
      diff: string;
    }
  | {
      type: 'coding-task';
      repository?: string;
      issueNumber?: number;
      title: string;
      body: string;
    };

/** One evaluation question in a benchmark suite. */
export type BenchmarkScenario = {
  id: string;
  prompt: string;
  /** Typed real-world task context. Repository questions are the default. */
  workload?: BenchmarkWorkload;
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
  /** Versioned acceptance thresholds enforced by `npm run eval -- gate`. */
  gate?: BenchmarkGate;
  scenarios: BenchmarkScenario[];
};

/** Stable quality and efficiency thresholds for a benchmark suite. */
export type BenchmarkGate = {
  minPassRate?: number;
  minQualityScore?: number;
  minToolSuccessRate?: number;
  maxAvgLatencyMs?: number;
  maxCostUsd?: number;
};

export type BenchmarkGateCheck = {
  metric: keyof BenchmarkGate;
  passed: boolean;
  actual: number;
  threshold: number;
};

export type BenchmarkGateResult = {
  passed: boolean;
  checks: BenchmarkGateCheck[];
};

export type BenchmarkRegressionResult = BenchmarkGateResult & {
  baselineRunId: string;
  candidateRunId: string;
  regressedScenarioIds: string[];
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
  workloadType?: BenchmarkWorkload['type'];
  passed: boolean;
  metrics: {
    /** 0..1 quality score (average of measured dimensions). */
    qualityScore: number;
    latencyMs: number;
    tokensIn: number;
    tokensOut: number;
    /** USD cost; billed when the provider reported it, estimated otherwise. NaN when unknown. */
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
  /** USD cost; NaN when pricing is absent and the provider did not report billed cost. */
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
  /** Digests identify the exact suite and inspectable repository corpus. */
  lineage?: {
    suiteDigest: string;
    repositoryDigest: string;
  };
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
