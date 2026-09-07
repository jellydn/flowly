export const REPOSITORY_INSTINCT_KINDS = [
  'convention',
  'verification',
  'review-rule',
  'architecture-boundary',
  'workflow',
] as const;

export type RepositoryInstinctKind = (typeof REPOSITORY_INSTINCT_KINDS)[number];

export const REPOSITORY_INSTINCT_STATUSES = [
  'candidate',
  'active',
  'rejected',
  'deprecated',
] as const;

export type RepositoryInstinctStatus = (typeof REPOSITORY_INSTINCT_STATUSES)[number];
export type RepositoryLearningStage = 'planning' | 'implementation' | 'review' | 'verification';
export type RepositoryEvidenceOutcome = 'supporting' | 'contradicting';

export type RepositoryInstinctScope = {
  paths: string[];
};

export type RepositoryInstinctEvidence = {
  id: string;
  source: 'factory-verification' | 'factory-review' | 'pr-review' | 'human';
  artifactId: string;
  outcome: RepositoryEvidenceOutcome;
  observedAt: number;
  statement: string;
  paths: string[];
  runId?: string;
  issueNumber?: number;
  prNumber?: number;
  command?: string;
  humanConfirmed?: boolean;
};

export type RepositoryInstinct = {
  id: string;
  repositoryId: string;
  kind: RepositoryInstinctKind;
  statement: string;
  scope: RepositoryInstinctScope;
  evidence: RepositoryInstinctEvidence[];
  confidence: number;
  status: RepositoryInstinctStatus;
  createdAt: number;
  lastObservedAt: number;
  supersedes?: string;
  policyVersion: string;
  promotionExplanation: string[];
};

export type RepositoryMemoryState = {
  version: 1;
  repositoryId: string;
  instincts: RepositoryInstinct[];
};

export type RepositoryLearningPolicy = {
  version: string;
  enabled: boolean;
  minimumObservations: number;
  requireHumanEvidenceFor: RepositoryInstinctKind[];
  decayAfterDays: number;
};

export type RepositoryLearningObservation = Omit<RepositoryInstinctEvidence, 'id' | 'outcome'> & {
  kind: RepositoryInstinctKind;
  outcome?: RepositoryEvidenceOutcome;
};
