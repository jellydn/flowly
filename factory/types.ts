/** Explicit, serializable state exchanged by the isolated factory stages. */
export const FACTORY_RUN_STATES = [
  'queued',
  'classified',
  'planning',
  'planned',
  'implementing',
  'verifying',
  'reviewing',
  'pr-created',
  'completed',
  'failed',
  'needs-input',
] as const;

export type FactoryRunState = (typeof FACTORY_RUN_STATES)[number];

export type FactoryTask = {
  issueNumber: number;
  title: string;
  body: string;
  repository: string;
  campaign?: {
    campaignId: string;
    batchId: string;
  };
};

export type TaskClassification = {
  actionable: boolean;
  type: 'bug' | 'feature' | 'refactor' | 'docs' | 'maintenance';
  priority: 'low' | 'medium' | 'high';
  complexity: 'small' | 'medium' | 'large';
  missingInformation: string[];
};

export type AcceptanceCriterion = { description: string };

export type ImplementationPlan = {
  summary: string;
  steps: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  verificationCommands: string[];
  relevantFiles?: string[];
  risks?: string[];
};

/** Output supplied by the isolated, writable implementation stage. */
export type ImplementationResult = {
  workspaceId: string;
  commitSha: string;
  changedFiles: string[];
  commands: Array<{ command: string; exitCode: number }>;
};

/** The independent review outcome. It contains evidence, not agent scratch context. */
export type ReviewVerdict = {
  readyForHumanReview: boolean;
  acceptanceCriteria: Array<{ description: string; satisfied: boolean; evidence: string }>;
  summary: string;
  unresolvedFindings: string[];
};

export const FACTORY_AUTONOMY_LEVELS = [
  'plan-only',
  'implement-and-verify',
  'publish-draft-pr',
] as const;
export type FactoryAutonomyLevel = (typeof FACTORY_AUTONOMY_LEVELS)[number];

export const FACTORY_AUTONOMY_EVENTS = [
  'verification-failure',
  'review-failure',
  'security-failure',
  'publication-failure',
] as const;
export type FactoryAutonomyEvent = (typeof FACTORY_AUTONOMY_EVENTS)[number];

export type FactoryAutonomyBoundary = 'implementation' | 'publication';
export type FactoryManualConfirmation = FactoryAutonomyBoundary;

export type FactoryAutonomyPolicy = {
  version: string;
  promotionEnabled: boolean;
  defaultLevel: FactoryAutonomyLevel;
  maximumLevel: FactoryAutonomyLevel;
  minimumSamples: {
    implementAndVerify: number;
    publishDraftPr: number;
  };
  promotionThresholds: {
    verificationSuccessRate: number;
    reviewReadyRate: number;
    publicationSuccessRate: number;
  };
  demotions: Partial<Record<FactoryAutonomyEvent, FactoryAutonomyLevel>>;
};

export type FactoryAutonomyEvidence = {
  runsConsidered: number;
  verificationSamples: number;
  verificationSuccesses: number;
  verificationSuccessRate: number;
  reviewSamples: number;
  reviewReady: number;
  reviewReadyRate: number;
  publicationSamples: number;
  publicationSuccesses: number;
  publicationSuccessRate: number;
  events: FactoryAutonomyEvent[];
};

export type FactoryAutonomyGateDecision = {
  boundary: FactoryAutonomyBoundary;
  allowed: boolean;
  manualConfirmation: boolean;
  reason: string;
  decidedAt: number;
};

export type FactoryAutonomyAudit = {
  policyVersion: string;
  evidence: FactoryAutonomyEvidence;
  effectiveLevel: FactoryAutonomyLevel;
  explanation: string[];
  gateDecisions: FactoryAutonomyGateDecision[];
};

export type FactoryRun = {
  id: string;
  task: FactoryTask;
  state: FactoryRunState;
  version: number;
  classification?: TaskClassification;
  plan?: ImplementationPlan;
  branch?: string;
  implementation?: ImplementationResult;
  review?: ReviewVerdict;
  autonomy?: FactoryAutonomyAudit;
  autonomyEvents?: FactoryAutonomyEvent[];
  prNumber?: number;
  failure?: string;
  updatedAt: number;
  /** Set when the run enters `planning`; used to reclaim a stale lease. */
  planningStartedAt?: number;
};

export function factoryBranch(
  issueNumber: number,
  title: string,
  campaign?: FactoryTask['campaign'],
): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'issue';
  const campaignSlug = campaign
    ? `${campaign.campaignId}-${campaign.batchId}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50)
    : undefined;
  return `factory/${issueNumber}-${campaignSlug ? `${campaignSlug}-` : ''}${slug}`;
}
