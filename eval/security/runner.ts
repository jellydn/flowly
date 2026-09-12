import { ADVERSARIAL_FIXTURES } from './fixtures.ts';
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
  if (!fixtureBelongsToInvariant(invariant, attack.fixture)) {
    throw new Error(`${attack.invariantId} fixture is not listed in the invariant catalog.`);
  }
  try {
    await attack.run(attack.fixture);
    return finding(attack, invariant, 'allowed', 'Trusted adapter allowed the prohibited action.');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    attack.expectedError.lastIndex = 0;
    if (!attack.expectedError.test(reason)) throw error;
    return finding(attack, invariant, 'denied', reason);
  }
}

function fixtureBelongsToInvariant(
  invariant: ReturnType<typeof safetyInvariant>,
  fixture: string,
): boolean {
  return invariant.fixtures.some((key) => valueContainsFixture(ADVERSARIAL_FIXTURES[key], fixture));
}

function valueContainsFixture(value: unknown, fixture: string): boolean {
  if (value === fixture) return true;
  if (typeof value === 'string') return decodeBase64(value) === fixture;
  if (Array.isArray(value)) return value.some((item) => valueContainsFixture(item, fixture));
  if (value && typeof value === 'object') {
    return Object.values(value).some((item) => valueContainsFixture(item, fixture));
  }
  return false;
}

function decodeBase64(value: string): string | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return undefined;
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  return Buffer.from(decoded, 'utf8').toString('base64') === value ? decoded : undefined;
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
