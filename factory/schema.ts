import * as v from 'valibot';
import { FACTORY_RUN_STATES, type FactoryRun, type FactoryRunState } from './types.ts';

const factoryRunStateSchema = v.picklist(
  FACTORY_RUN_STATES as unknown as [FactoryRunState, ...FactoryRunState[]],
);

const factoryTaskSchema = v.object({
  issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  title: v.string(),
  body: v.string(),
  repository: v.pipe(v.string(), v.regex(/^.+\/.+$/)),
});

const classificationSchema = v.object({
  actionable: v.boolean(),
  type: v.picklist(['bug', 'feature', 'refactor', 'docs', 'maintenance']),
  priority: v.picklist(['low', 'medium', 'high']),
  complexity: v.picklist(['small', 'medium', 'large']),
  missingInformation: v.array(v.string()),
});

const implementationPlanSchema = v.object({
  summary: v.string(),
  steps: v.array(v.string()),
  acceptanceCriteria: v.array(v.object({ description: v.string() })),
  verificationCommands: v.array(v.string()),
  relevantFiles: v.optional(v.array(v.string())),
  risks: v.optional(v.array(v.string())),
});

const implementationResultSchema = v.object({
  workspaceId: v.pipe(v.string(), v.minLength(1)),
  commitSha: v.pipe(v.string(), v.minLength(1)),
  changedFiles: v.array(v.string()),
  commands: v.array(
    v.object({
      command: v.string(),
      exitCode: v.pipe(v.number(), v.integer()),
    }),
  ),
});

const reviewVerdictSchema = v.object({
  readyForHumanReview: v.boolean(),
  acceptanceCriteria: v.array(
    v.object({
      description: v.string(),
      satisfied: v.boolean(),
      evidence: v.string(),
    }),
  ),
  summary: v.string(),
  unresolvedFindings: v.array(v.string()),
});

/** Persistence contract for a factory run snapshot. */
export const factoryRunSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  task: factoryTaskSchema,
  state: factoryRunStateSchema,
  version: v.pipe(v.number(), v.integer(), v.minValue(0)),
  classification: v.optional(classificationSchema),
  plan: v.optional(implementationPlanSchema),
  branch: v.optional(v.pipe(v.string(), v.minLength(1))),
  implementation: v.optional(implementationResultSchema),
  review: v.optional(reviewVerdictSchema),
  prNumber: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  failure: v.optional(v.string()),
  updatedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  planningStartedAt: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

export function parseFactoryRun(value: unknown): FactoryRun {
  return v.parse(factoryRunSchema, value);
}
