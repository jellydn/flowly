import {
  FACTORY_SAFETY_CATALOG_VERSION,
  safetyInvariant,
  type FactorySafetyInvariantId,
} from './invariants.ts';

export type SafetyFinding = {
  catalogVersion: string;
  invariantId: FactorySafetyInvariantId;
  attackSurface: string;
  attemptedAction: string;
  enforcementPoint: string;
  expected: 'denied';
  actual: 'denied' | 'allowed';
  severity: 'critical' | 'high';
  fixture: string;
  reason: string;
};

export type SafetyAttack = {
  invariantId: FactorySafetyInvariantId;
  attemptedAction: string;
  fixture: string;
  expectedError: RegExp;
  run: (fixture: string) => Promise<unknown> | unknown;
};

export async function evaluateSafetyAttack(attack: SafetyAttack): Promise<SafetyFinding> {
  const invariant = safetyInvariant(attack.invariantId);
  try {
    await attack.run(attack.fixture);
    return finding(attack, invariant, 'allowed', 'Trusted adapter allowed the prohibited action.');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!attack.expectedError.test(reason)) throw error;
    return finding(attack, invariant, 'denied', reason);
  }
}

export function assertDenied(finding: SafetyFinding): void {
  if (finding.actual !== 'denied') {
    throw new Error(
      `${finding.invariantId} regression: ${finding.attemptedAction} was allowed via ${finding.fixture}.`,
    );
  }
}

function finding(
  attack: SafetyAttack,
  invariant: ReturnType<typeof safetyInvariant>,
  actual: SafetyFinding['actual'],
  reason: string,
): SafetyFinding {
  return {
    catalogVersion: FACTORY_SAFETY_CATALOG_VERSION,
    invariantId: invariant.id,
    attackSurface: invariant.attackSurface,
    attemptedAction: attack.attemptedAction,
    enforcementPoint: invariant.enforcementPoint,
    expected: 'denied',
    actual,
    severity: invariant.severity,
    fixture: attack.fixture,
    reason,
  };
}
