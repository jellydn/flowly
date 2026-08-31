import * as v from 'valibot';
import {
  FACTORY_AUTONOMY_EVENTS,
  FACTORY_AUTONOMY_LEVELS,
  type FactoryAutonomyAudit,
  type FactoryAutonomyBoundary,
  type FactoryAutonomyEvidence,
  type FactoryAutonomyLevel,
  type FactoryAutonomyPolicy,
  type FactoryManualConfirmation,
  type FactoryRun,
} from './types.ts';

const autonomyLevelSchema = v.picklist(FACTORY_AUTONOMY_LEVELS);
const rateSchema = v.pipe(v.number(), v.minValue(0), v.maxValue(1));

export const factoryAutonomyPolicySchema = v.object({
  version: v.pipe(v.string(), v.minLength(1)),
  promotionEnabled: v.optional(v.boolean(), false),
  defaultLevel: autonomyLevelSchema,
  maximumLevel: autonomyLevelSchema,
  minimumSamples: v.object({
    implementAndVerify: v.pipe(v.number(), v.integer(), v.minValue(1)),
    publishDraftPr: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
  promotionThresholds: v.object({
    verificationSuccessRate: rateSchema,
    reviewReadyRate: rateSchema,
    publicationSuccessRate: rateSchema,
  }),
  demotions: v.optional(
    v.object({
      'verification-failure': v.optional(autonomyLevelSchema),
      'review-failure': v.optional(autonomyLevelSchema),
      'security-failure': v.optional(autonomyLevelSchema),
      'publication-failure': v.optional(autonomyLevelSchema),
    }),
    {},
  ),
});

export function parseFactoryAutonomyPolicy(value: unknown): FactoryAutonomyPolicy {
  const policy = v.parse(factoryAutonomyPolicySchema, value);
  if (levelRank(policy.defaultLevel) > levelRank(policy.maximumLevel)) {
    throw new Error('Factory autonomy defaultLevel cannot exceed maximumLevel.');
  }
  for (const [event, level] of Object.entries(policy.demotions)) {
    if (level !== undefined && levelRank(level) > levelRank(policy.maximumLevel)) {
      throw new Error(`Factory autonomy demotion for ${event} cannot exceed maximumLevel.`);
    }
  }
  return policy;
}

export function evaluateFactoryAutonomy(
  policyValue: FactoryAutonomyPolicy | undefined,
  runs: FactoryRun[],
): FactoryAutonomyAudit {
  const evidence = summarizeFactoryOutcomes(runs);
  if (!policyValue) {
    return {
      policyVersion: 'implicit-plan-only-v1',
      evidence,
      effectiveLevel: 'plan-only',
      explanation: ['No autonomy policy configured; defaulted to Plan only.'],
      gateDecisions: [],
    };
  }

  const policy = parseFactoryAutonomyPolicy(policyValue);
  let effectiveLevel = minLevel(policy.defaultLevel, policy.maximumLevel);
  const explanation = [
    `Policy ${policy.version} starts at ${policy.defaultLevel} and caps at ${policy.maximumLevel}.`,
    `Verification: ${evidence.verificationSuccesses}/${evidence.verificationSamples} (${formatRate(evidence.verificationSuccessRate)}).`,
    `Review readiness: ${evidence.reviewReady}/${evidence.reviewSamples} (${formatRate(evidence.reviewReadyRate)}).`,
    `Draft publication: ${evidence.publicationSuccesses}/${evidence.publicationSamples} (${formatRate(evidence.publicationSuccessRate)}).`,
  ];

  if (policy.promotionEnabled) {
    if (
      evidence.verificationSamples >= policy.minimumSamples.implementAndVerify &&
      evidence.verificationSuccessRate >= policy.promotionThresholds.verificationSuccessRate
    ) {
      effectiveLevel = maxLevel(effectiveLevel, 'implement-and-verify');
      explanation.push('Implement-and-verify promotion threshold passed.');
    } else {
      explanation.push('Implement-and-verify promotion threshold not met.');
    }

    if (
      evidence.publicationSamples >= policy.minimumSamples.publishDraftPr &&
      evidence.verificationSuccessRate >= policy.promotionThresholds.verificationSuccessRate &&
      evidence.reviewReadyRate >= policy.promotionThresholds.reviewReadyRate &&
      evidence.publicationSuccessRate >= policy.promotionThresholds.publicationSuccessRate
    ) {
      effectiveLevel = maxLevel(effectiveLevel, 'publish-draft-pr');
      explanation.push('Publish-draft-PR promotion thresholds passed.');
    } else {
      explanation.push('Publish-draft-PR promotion thresholds not met.');
    }
  } else {
    explanation.push('History-based promotion is disabled.');
  }

  effectiveLevel = minLevel(effectiveLevel, policy.maximumLevel);
  for (const event of FACTORY_AUTONOMY_EVENTS) {
    const demotedLevel = policy.demotions[event];
    if (demotedLevel && evidence.events.includes(event)) {
      effectiveLevel = minLevel(effectiveLevel, demotedLevel);
      explanation.push(`${event} immediately demoted the run to at most ${demotedLevel}.`);
    }
  }
  return {
    policyVersion: policy.version,
    evidence,
    effectiveLevel,
    explanation,
    gateDecisions: [],
  };
}

export function summarizeFactoryOutcomes(runs: FactoryRun[]): FactoryAutonomyEvidence {
  const verificationRuns = runs.filter(
    (run) => run.implementation && run.implementation.commands.length > 0,
  );
  const verificationSuccesses = verificationRuns.filter(
    (run) =>
      run.implementation?.commands.every((command) => command.exitCode === 0) &&
      !run.autonomyEvents?.includes('verification-failure'),
  ).length;
  const reviewRuns = runs.filter((run) => run.review !== undefined);
  const reviewReady = reviewRuns.filter((run) => run.review?.readyForHumanReview).length;
  const publicationRuns = runs.filter(
    (run) => run.review !== undefined || run.autonomyEvents?.includes('publication-failure'),
  );
  const publicationSuccesses = publicationRuns.filter((run) => run.prNumber !== undefined).length;
  return {
    runsConsidered: runs.length,
    verificationSamples: verificationRuns.length,
    verificationSuccesses,
    verificationSuccessRate: rate(verificationSuccesses, verificationRuns.length),
    reviewSamples: reviewRuns.length,
    reviewReady,
    reviewReadyRate: rate(reviewReady, reviewRuns.length),
    publicationSamples: publicationRuns.length,
    publicationSuccesses,
    publicationSuccessRate: rate(publicationSuccesses, publicationRuns.length),
    events: [...new Set(runs.flatMap((run) => run.autonomyEvents ?? []))].sort(),
  };
}

export function decideFactoryAutonomyGate(
  audit: FactoryAutonomyAudit,
  boundary: FactoryAutonomyBoundary,
  confirmation: FactoryManualConfirmation | undefined,
): { allowed: boolean; manualConfirmation: boolean; reason: string } {
  const requiredLevel = boundary === 'implementation' ? 'implement-and-verify' : 'publish-draft-pr';
  const allowedByPolicy = levelRank(audit.effectiveLevel) >= levelRank(requiredLevel);
  const manualConfirmation = confirmation === boundary;
  return {
    allowed: allowedByPolicy || manualConfirmation,
    manualConfirmation,
    reason: allowedByPolicy
      ? `Policy level ${audit.effectiveLevel} allows ${boundary}.`
      : manualConfirmation
        ? `One-run manual confirmation allows ${boundary}.`
        : `Policy level ${audit.effectiveLevel} stops before ${boundary}.`,
  };
}

export function assertFactoryAutonomyGate(
  run: FactoryRun,
  boundary: FactoryAutonomyBoundary,
): void {
  const decision = run.autonomy?.gateDecisions.find(
    (candidate) => candidate.boundary === boundary && candidate.allowed,
  );
  if (!decision) {
    throw new Error(`Factory run ${run.id} has no allowed ${boundary} autonomy gate.`);
  }
}

function rate(successes: number, samples: number): number {
  return samples === 0 ? 0 : successes / samples;
}

function formatRate(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function levelRank(level: FactoryAutonomyLevel): number {
  return FACTORY_AUTONOMY_LEVELS.indexOf(level);
}

function minLevel(left: FactoryAutonomyLevel, right: FactoryAutonomyLevel): FactoryAutonomyLevel {
  return levelRank(left) <= levelRank(right) ? left : right;
}

function maxLevel(left: FactoryAutonomyLevel, right: FactoryAutonomyLevel): FactoryAutonomyLevel {
  return levelRank(left) >= levelRank(right) ? left : right;
}
