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
  prNumber?: number;
  failure?: string;
  updatedAt: number;
  /** Set when the run enters `planning`; used to reclaim a stale lease. */
  planningStartedAt?: number;
};

export function factoryBranch(issueNumber: number, title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'issue';
  return `factory/${issueNumber}-${slug}`;
}
