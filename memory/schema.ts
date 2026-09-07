import * as v from 'valibot';
import {
  REPOSITORY_INSTINCT_KINDS,
  REPOSITORY_INSTINCT_STATUSES,
  type RepositoryLearningObservation,
  type RepositoryLearningPolicy,
  type RepositoryMemoryState,
} from './types.ts';

const pathSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(500),
  v.check((value) => !value.startsWith('/') && !value.split('/').includes('..'), 'Invalid path.'),
);
const kindSchema = v.picklist(REPOSITORY_INSTINCT_KINDS);
const statusSchema = v.picklist(REPOSITORY_INSTINCT_STATUSES);
const sourceSchema = v.picklist(['factory-verification', 'factory-review', 'pr-review', 'human']);
const commonEvidenceFields = {
  source: sourceSchema,
  artifactId: v.pipe(v.string(), v.minLength(1), v.maxLength(300)),
  observedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  statement: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1000)),
  paths: v.pipe(v.array(pathSchema), v.maxLength(100)),
  runId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  issueNumber: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  prNumber: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  command: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(500))),
  humanConfirmed: v.optional(v.boolean()),
};
const evidenceSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  ...commonEvidenceFields,
  outcome: v.picklist(['supporting', 'contradicting']),
});
const instinctSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  repositoryId: v.pipe(v.string(), v.regex(/^[^/]+\/[^/]+$/)),
  kind: kindSchema,
  statement: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
  scope: v.object({ paths: v.pipe(v.array(pathSchema), v.maxLength(100)) }),
  evidence: v.pipe(v.array(evidenceSchema), v.minLength(1), v.maxLength(500)),
  confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  status: statusSchema,
  createdAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  lastObservedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  supersedes: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
  policyVersion: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  promotionExplanation: v.array(v.pipe(v.string(), v.maxLength(500))),
});
const stateSchema = v.object({
  version: v.literal(1),
  repositoryId: v.pipe(v.string(), v.regex(/^[^/]+\/[^/]+$/)),
  instincts: v.pipe(v.array(instinctSchema), v.maxLength(1000)),
});
const policySchema = v.object({
  version: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  enabled: v.boolean(),
  minimumObservations: v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(100)),
  requireHumanEvidenceFor: v.array(kindSchema),
  decayAfterDays: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3650)),
});
const observationSchema = v.object({
  kind: kindSchema,
  ...commonEvidenceFields,
  outcome: v.optional(v.picklist(['supporting', 'contradicting'])),
});

export function parseRepositoryMemoryState(value: unknown): RepositoryMemoryState {
  return v.parse(stateSchema, value);
}

export function parseRepositoryLearningPolicy(value: unknown): RepositoryLearningPolicy {
  return v.parse(policySchema, value);
}

export function safeParseRepositoryLearningObservation(
  value: unknown,
): RepositoryLearningObservation | null {
  const result = v.safeParse(observationSchema, value);
  return result.success ? result.output : null;
}
