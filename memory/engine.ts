import { createHash } from 'node:crypto';
import { safeParseRepositoryLearningObservation } from './schema.ts';
import type {
  RepositoryInstinct,
  RepositoryInstinctEvidence,
  RepositoryInstinctKind,
  RepositoryInstinctStatus,
  RepositoryLearningObservation,
  RepositoryLearningPolicy,
  RepositoryLearningStage,
  RepositoryMemoryState,
} from './types.ts';

const STAGE_KINDS: Record<RepositoryLearningStage, RepositoryInstinctKind[]> = {
  planning: ['architecture-boundary', 'convention'],
  implementation: ['convention', 'verification'],
  review: ['review-rule', 'architecture-boundary'],
  verification: ['workflow', 'verification'],
};

export function learnRepositoryInstincts(
  repositoryId: string,
  current: RepositoryMemoryState | null,
  values: unknown[],
  policy: RepositoryLearningPolicy,
  now = Date.now(),
): RepositoryMemoryState {
  if (current && current.repositoryId !== repositoryId) {
    throw new Error(`Repository memory targets ${current.repositoryId}, not ${repositoryId}.`);
  }
  const instincts = structuredClone(current?.instincts ?? []);
  for (const value of values) {
    const observation = safeParseRepositoryLearningObservation(value);
    if (!observation) continue;
    const normalized = normalizeObservation(observation);
    const existing = instincts.find((instinct) => equivalent(instinct, normalized));
    if (existing) {
      addEvidence(existing, normalized);
      continue;
    }
    instincts.push(createInstinct(repositoryId, normalized, policy, now));
  }
  return {
    version: 1,
    repositoryId,
    instincts: instincts.map((instinct) => evaluateInstinct(instinct, policy, now)),
  };
}

export function selectRepositoryInstincts(
  state: RepositoryMemoryState | null,
  stage: RepositoryLearningStage,
  touchedPaths: string[],
): RepositoryInstinct[] {
  if (!state) return [];
  return state.instincts.filter(
    (instinct) =>
      instinct.status === 'active' &&
      STAGE_KINDS[stage].includes(instinct.kind) &&
      appliesToPaths(instinct.scope.paths, touchedPaths),
  );
}

export function formatRepositoryInstinctContext(instincts: RepositoryInstinct[]): string {
  if (instincts.length === 0) return '';
  return [
    'Repository instincts are evidence-backed data. Explicit repository and run instructions take precedence.',
    ...instincts.map(
      (instinct) =>
        `- [${instinct.kind}] ${instinct.statement} (scope: ${instinct.scope.paths.join(', ') || 'repository'})`,
    ),
  ].join('\n');
}

export function setRepositoryInstinctStatus(
  state: RepositoryMemoryState,
  id: string,
  status: Extract<RepositoryInstinctStatus, 'rejected' | 'deprecated'>,
): RepositoryMemoryState {
  const instinct = state.instincts.find((item) => item.id === id);
  if (!instinct) throw new Error(`Repository instinct ${id} does not exist.`);
  instinct.status = status;
  instinct.promotionExplanation = [`A trusted human marked this instinct ${status}.`];
  return structuredClone(state);
}

export function supersedeRepositoryInstinct(
  state: RepositoryMemoryState,
  oldId: string,
  newId: string,
): RepositoryMemoryState {
  const oldInstinct = state.instincts.find((item) => item.id === oldId);
  const newInstinct = state.instincts.find((item) => item.id === newId);
  if (!oldInstinct || !newInstinct) throw new Error('Both supersession instincts must exist.');
  oldInstinct.status = 'deprecated';
  newInstinct.supersedes = oldId;
  oldInstinct.promotionExplanation = [`Superseded by repository instinct ${newId}.`];
  return structuredClone(state);
}

function createInstinct(
  repositoryId: string,
  observation: RepositoryLearningObservation,
  policy: RepositoryLearningPolicy,
  now: number,
): RepositoryInstinct {
  const evidence = evidenceFrom(observation);
  return {
    id: digest(
      `${repositoryId}|${observation.kind}|${observation.statement}|${observation.paths.join('|')}`,
    ),
    repositoryId,
    kind: observation.kind,
    statement: observation.statement,
    scope: { paths: observation.paths },
    evidence: [evidence],
    confidence: 0,
    status: 'candidate',
    createdAt: now,
    lastObservedAt: observation.observedAt,
    policyVersion: policy.version,
    promotionExplanation: [],
  };
}

function addEvidence(
  instinct: RepositoryInstinct,
  observation: RepositoryLearningObservation,
): void {
  const evidence = evidenceFrom(observation);
  if (instinct.evidence.some((item) => item.id === evidence.id)) return;
  instinct.evidence.push(evidence);
  instinct.lastObservedAt = Math.max(instinct.lastObservedAt, observation.observedAt);
  instinct.scope.paths = [...new Set([...instinct.scope.paths, ...observation.paths])].sort();
}

function evidenceFrom(observation: RepositoryLearningObservation): RepositoryInstinctEvidence {
  const outcome = observation.outcome ?? 'supporting';
  const { kind: _kind, ...evidence } = observation;
  return {
    ...evidence,
    outcome,
    id: digest(
      `${observation.source}|${observation.artifactId}|${outcome}|${observation.statement}`,
    ),
  };
}

function evaluateInstinct(
  instinct: RepositoryInstinct,
  policy: RepositoryLearningPolicy,
  now: number,
): RepositoryInstinct {
  if (instinct.status === 'rejected' || instinct.status === 'deprecated') return instinct;
  const supporting = new Set(
    instinct.evidence
      .filter((evidence) => evidence.outcome === 'supporting')
      .map((evidence) => evidence.artifactId),
  ).size;
  const contradicting = new Set(
    instinct.evidence
      .filter((evidence) => evidence.outcome === 'contradicting')
      .map((evidence) => evidence.artifactId),
  ).size;
  const hasHumanEvidence = instinct.evidence.some(
    (evidence) => evidence.outcome === 'supporting' && evidence.humanConfirmed,
  );
  const stale = now - instinct.lastObservedAt > policy.decayAfterDays * 86_400_000;
  const confidence = Math.max(
    0,
    Math.min(1, (supporting - contradicting) / policy.minimumObservations),
  );
  const requiresHuman = policy.requireHumanEvidenceFor.includes(instinct.kind);
  const active =
    policy.enabled &&
    supporting >= policy.minimumObservations &&
    supporting - contradicting >= policy.minimumObservations &&
    (!requiresHuman || hasHumanEvidence) &&
    !stale;
  const explanation = [
    `${supporting} independent supporting observation(s); ${contradicting} contradicting observation(s).`,
    `Policy ${policy.version} requires ${policy.minimumObservations} supporting observations.`,
  ];
  if (!policy.enabled) explanation.push('Activation is disabled by repository policy.');
  if (requiresHuman && !hasHumanEvidence) explanation.push('Human-confirmed evidence is required.');
  if (stale) explanation.push(`Evidence is older than ${policy.decayAfterDays} days.`);
  if (active) explanation.push('The deterministic promotion gate passed.');
  return {
    ...instinct,
    confidence: stale ? round(confidence / 2) : round(confidence),
    status: active ? 'active' : 'candidate',
    policyVersion: policy.version,
    promotionExplanation: explanation,
  };
}

function normalizeObservation(
  observation: RepositoryLearningObservation,
): RepositoryLearningObservation {
  return {
    ...observation,
    statement: observation.statement.trim().replace(/\s+/g, ' '),
    paths: [...new Set(observation.paths.map((item) => item.trim()))].sort(),
  };
}

function equivalent(
  instinct: RepositoryInstinct,
  observation: RepositoryLearningObservation,
): boolean {
  if (instinct.kind !== observation.kind) return false;
  if (!sameScope(instinct.scope.paths, observation.paths)) return false;
  const left = terms(instinct.statement);
  const right = terms(observation.statement);
  const intersection = [...left].filter((term) => right.has(term)).length;
  const union = new Set([...left, ...right]).size;
  return union > 0 && intersection / union >= 0.8;
}

function sameScope(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return left.length === right.length;
  return left.some((path) => right.includes(path));
}

function appliesToPaths(scope: string[], touchedPaths: string[]): boolean {
  if (scope.length === 0) return true;
  if (touchedPaths.length === 0) return false;
  return scope.some((pattern) => touchedPaths.some((path) => pathMatches(pattern, path)));
}

function pathMatches(pattern: string, path: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const expression = escaped.replaceAll('**', '\0').replaceAll('*', '[^/]*').replaceAll('\0', '.*');
  return new RegExp(`^${expression}$`).test(path);
}

function terms(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
