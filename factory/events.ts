import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as v from 'valibot';
import { FACTORY_STAGES, type FactoryStage } from './capabilities.ts';
import type { FactoryRun } from './types.ts';
import type { FactoryWorkspaceEvent } from './workspace-lifecycle.ts';

export const FACTORY_RUN_EVENT_TYPES = [
  'run.started',
  'stage.started',
  'stage.completed',
  'stage.failed',
  'tool.invoked',
  'verification.completed',
  'gate.evaluated',
  'review.completed',
  'publication.completed',
  'run.suspended',
  'run.resumed',
  'run.completed',
  'workspace.allocated',
  'workspace.hydrated',
  'workspace.activated',
  'workspace.suspended',
  'workspace.resumed',
  'workspace.completed',
  'workspace.failed',
  'workspace.cancelled',
  'workspace.retained',
  'workspace.cleaned',
] as const;
export type FactoryRunEventType = (typeof FACTORY_RUN_EVENT_TYPES)[number];

export type FactoryUsage = {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  durationMs?: number;
  cost?: number;
  inspectionBudgetUsed?: number;
  unknown: string[];
};

export type FactoryRunEvent = {
  runId: string;
  sequence: number;
  stage?: FactoryStage | 'run';
  type: FactoryRunEventType;
  timestamp: number;
  attempt: number;
  summary: string;
  metadata: Record<string, unknown>;
  policyVersion?: string;
};

export type FactoryEventInput = Omit<FactoryRunEvent, 'sequence'> & { sequence?: number };

const eventSchema = v.object({
  runId: v.pipe(v.string(), v.minLength(1)),
  sequence: v.pipe(v.number(), v.integer(), v.minValue(1)),
  stage: v.optional(v.union([v.picklist(FACTORY_STAGES), v.literal('run')])),
  type: v.picklist(FACTORY_RUN_EVENT_TYPES),
  timestamp: v.pipe(v.number(), v.integer(), v.minValue(0)),
  attempt: v.pipe(v.number(), v.integer(), v.minValue(1)),
  summary: v.pipe(v.string(), v.minLength(1)),
  metadata: v.record(v.string(), v.unknown()),
  policyVersion: v.optional(v.pipe(v.string(), v.minLength(1))),
});

export function parseFactoryRunEvent(value: unknown): FactoryRunEvent {
  return v.parse(eventSchema, value);
}

export type FactoryEventLog = {
  append(event: FactoryEventInput): Promise<FactoryRunEvent>;
  list(runId?: string): Promise<FactoryRunEvent[]>;
};

export class MemoryFactoryEventLog implements FactoryEventLog {
  private readonly events = new Map<string, FactoryRunEvent[]>();

  async append(event: FactoryEventInput): Promise<FactoryRunEvent> {
    const current = this.events.get(event.runId) ?? [];
    const recorded = ingestEvent(current, event);
    this.events.set(event.runId, recorded.events);
    return recorded.event;
  }

  async list(runId?: string): Promise<FactoryRunEvent[]> {
    if (runId) return [...(this.events.get(runId) ?? [])];
    return [...this.events.values()].flat().sort(compareEvents);
  }
}

export class FileFactoryEventLog implements FactoryEventLog {
  constructor(private readonly directory: string) {}

  async append(event: FactoryEventInput): Promise<FactoryRunEvent> {
    await mkdir(this.directory, { recursive: true });
    const current = await this.list(event.runId);
    const recorded = ingestEvent(current, event);
    await writeAtomicJson(this.filePath(event.runId), recorded.events);
    return recorded.event;
  }

  async list(runId?: string): Promise<FactoryRunEvent[]> {
    if (runId) return readEventFile(this.filePath(runId));
    try {
      const names = await readdir(this.directory);
      const events: FactoryRunEvent[] = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        events.push(...(await readEventFile(path.join(this.directory, name))));
      }
      return events.sort(compareEvents);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  private filePath(runId: string): string {
    return path.join(this.directory, `${encodeURIComponent(runId)}.json`);
  }
}

export type FactoryStageProjection = {
  stage: FactoryStage | 'run';
  status: 'started' | 'completed' | 'failed';
  attempt: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
};

export type FactoryRunProjection = {
  runId: string;
  status: string;
  currentStage?: FactoryStage | 'run';
  repository?: string;
  issueNumber?: number;
  title?: string;
  branch?: string;
  workspaceId?: string;
  attempts: number;
  stages: FactoryStageProjection[];
  verification?: { passed: boolean; commands?: unknown; summary: string };
  review?: { verdict?: string; readyForHumanReview?: boolean; summary: string };
  publication?: { prNumber?: number; draft?: boolean; summary: string };
  gates: Array<{ boundary?: string; allowed?: boolean; reason?: string; policyVersion?: string }>;
  usage: FactoryUsage;
  workspace?: { id?: string; state?: string; path?: string };
  failure?: string;
};

export function projectFactoryRun(events: FactoryRunEvent[]): FactoryRunProjection {
  const ordered = [...events].sort(compareEvents);
  if (ordered.length === 0) {
    throw new Error('Cannot project a factory run from an empty event list.');
  }
  const projection: FactoryRunProjection = {
    runId: ordered[0]!.runId,
    status: 'unknown',
    attempts: 1,
    stages: [],
    gates: [],
    usage: emptyUsage(),
  };
  const stages = new Map<string, FactoryStageProjection>();

  for (const event of ordered) {
    projection.attempts = Math.max(projection.attempts, event.attempt);
    mergeIdentifiers(projection, event.metadata);
    mergeUsage(projection.usage, event.metadata.usage);
    switch (event.type) {
      case 'run.started':
        projection.status = 'started';
        projection.currentStage = 'run';
        break;
      case 'stage.started':
        projection.status = 'running';
        projection.currentStage = event.stage ?? projection.currentStage;
        upsertStage(stages, event, 'started');
        break;
      case 'stage.completed':
        projection.status = 'running';
        upsertStage(stages, event, 'completed');
        break;
      case 'stage.failed':
        projection.status = 'failed';
        projection.failure = String(event.metadata.failure ?? event.summary);
        upsertStage(stages, event, 'failed');
        break;
      case 'verification.completed':
        projection.verification = {
          passed: event.metadata.passed === true,
          commands: event.metadata.commands,
          summary: event.summary,
        };
        if (event.metadata.passed !== true) {
          projection.status = 'failed';
          projection.failure = event.summary;
        }
        break;
      case 'gate.evaluated':
        projection.gates.push({
          boundary: optionalString(event.metadata.boundary),
          allowed: event.metadata.allowed === true,
          reason: optionalString(event.metadata.reason) ?? event.summary,
          policyVersion: event.policyVersion ?? optionalString(event.metadata.policyVersion),
        });
        if (event.metadata.allowed === false) projection.status = 'blocked';
        break;
      case 'review.completed':
        projection.review = {
          verdict: optionalString(event.metadata.verdict),
          readyForHumanReview: event.metadata.readyForHumanReview === true,
          summary: event.summary,
        };
        break;
      case 'publication.completed':
        projection.publication = {
          prNumber: optionalNumber(event.metadata.prNumber),
          draft: event.metadata.draft !== false,
          summary: event.summary,
        };
        break;
      case 'run.completed':
        projection.status = 'completed';
        projection.currentStage = 'run';
        break;
      case 'run.suspended':
        projection.status = 'suspended';
        break;
      case 'run.resumed':
        projection.status = 'running';
        break;
      default:
        if (event.type.startsWith('workspace.')) {
          const workspaceId = optionalString(event.metadata.id) ?? projection.workspaceId;
          projection.workspace = {
            id: workspaceId,
            state: optionalString(event.metadata.state),
            path: optionalString(event.metadata.path),
          };
          projection.workspaceId = workspaceId;
        }
    }
  }
  projection.stages = [...stages.values()];
  return projection;
}

export function explainFactoryRun(events: FactoryRunEvent[]): string {
  const projection = projectFactoryRun(events);
  const lines = [
    `Run ${projection.runId} is ${projection.status}.`,
    projection.currentStage ? `Current stage: ${projection.currentStage}.` : undefined,
    projection.repository && projection.issueNumber
      ? `Issue: ${projection.repository}#${projection.issueNumber}.`
      : undefined,
    projection.branch ? `Branch: ${projection.branch}.` : undefined,
    projection.workspaceId ? `Workspace: ${projection.workspaceId}.` : undefined,
  ].filter((line): line is string => Boolean(line));
  const lastGate = projection.gates.at(-1);
  if (lastGate) {
    const reason = lastGate.reason ? ` ${lastGate.reason}` : '';
    lines.push(
      `Last gate (${lastGate.boundary ?? 'unknown'}): ${lastGate.allowed ? 'allowed' : 'blocked'}.${reason}`,
    );
    if (lastGate.policyVersion) lines.push(`Policy version: ${lastGate.policyVersion}.`);
  }
  if (projection.verification) {
    lines.push(`Verification: ${projection.verification.passed ? 'passed' : 'failed'}.`);
  }
  if (projection.review) lines.push(`Review: ${projection.review.summary}`);
  if (projection.publication) lines.push(`Publication: ${projection.publication.summary}`);
  if (projection.failure) lines.push(`Failure: ${projection.failure}`);
  const usage = formatUsage(projection.usage);
  if (usage) lines.push(`Usage: ${usage}`);
  return lines.join('\n');
}

export function workspaceEventsToLog(log: FactoryEventLog): {
  emit(event: FactoryWorkspaceEvent): Promise<void>;
} {
  return {
    async emit(event) {
      await log.append({
        runId: event.runId,
        stage: 'implementer',
        type: event.type,
        timestamp: event.timestamp,
        attempt: Number(event.metadata.attempt) || 1,
        summary: event.summary,
        metadata: { ...event.metadata, id: event.workspaceId },
      });
    },
  };
}

export function unknownUsage(fields: string[]): FactoryUsage {
  return { unknown: [...fields] };
}

const FORBIDDEN_METADATA_KEYS = [
  'chainOfThought',
  'chain-of-thought',
  'transcript',
  'scratch',
  'implementerScratch',
];

export function eventsForRunTransition(
  previous: FactoryRun | undefined,
  next: FactoryRun,
): FactoryEventInput[] {
  const now = next.updatedAt;
  const attempt = 1;
  const base = {
    runId: next.id,
    timestamp: now,
    attempt,
    metadata: identifiers(next),
    policyVersion: next.capabilities?.policyVersion ?? next.autonomy?.policyVersion,
  };
  const events: FactoryEventInput[] = [];
  if (!previous) {
    events.push({
      ...base,
      stage: 'run',
      type: 'run.started',
      summary: `Factory run started for ${next.task.repository}#${next.task.issueNumber}.`,
    });
  }
  const from = previous?.state;
  const to = next.state;
  if (from !== to) {
    events.push(...stageEvents(base, from, to, next));
  }
  if (!previous?.review && next.review) {
    events.push({
      ...base,
      stage: 'reviewer',
      type: 'review.completed',
      summary: next.review.summary,
      metadata: {
        ...base.metadata,
        readyForHumanReview: next.review.readyForHumanReview,
        unresolvedFindings: next.review.unresolvedFindings,
      },
    });
  }
  const previousGates = previous?.autonomy?.gateDecisions ?? [];
  for (const decision of next.autonomy?.gateDecisions ?? []) {
    const seen = previousGates.find(
      (item) =>
        item.boundary === decision.boundary &&
        item.allowed === decision.allowed &&
        item.reason === decision.reason,
    );
    if (seen) continue;
    events.push({
      ...base,
      stage: decision.boundary === 'publication' ? 'publisher' : 'implementer',
      type: 'gate.evaluated',
      summary: decision.reason,
      metadata: {
        ...base.metadata,
        boundary: decision.boundary,
        allowed: decision.allowed,
        reason: decision.reason,
        policyVersion: next.autonomy?.policyVersion,
      },
      policyVersion: next.autonomy?.policyVersion,
    });
  }
  return events.map((event) => ({ ...event, metadata: sanitizeMetadata(event.metadata) }));
}

function stageEvents(
  base: Omit<FactoryEventInput, 'type' | 'summary' | 'stage'>,
  from: FactoryRun['state'] | undefined,
  to: FactoryRun['state'],
  next: FactoryRun,
): FactoryEventInput[] {
  switch (`${from ?? ''}->${to}`) {
    case '->queued':
    case 'queued->queued':
      return [];
    case 'queued->classified':
      return [completed(base, 'classifier', 'Classification complete.')];
    case 'queued->needs-input':
      return [failed(base, 'classifier', next.failure ?? 'Issue needs input before planning.')];
    case 'classified->planning':
      return [started(base, 'planner', 'Planning started.')];
    case 'planning->planned':
    case 'classified->planned':
      return [completed(base, 'planner', next.plan?.summary ?? 'Plan recorded.')];
    case 'planned->implementing':
      return [started(base, 'implementer', 'Implementation started.')];
    case 'implementing->verifying':
      return [
        completed(base, 'implementer', 'Implementation recorded.'),
        started(base, 'verifier', 'Verification started.'),
      ];
    case 'verifying->reviewing':
      return [
        {
          ...base,
          stage: 'verifier',
          type: 'verification.completed',
          summary: 'Verification passed.',
          metadata: { ...base.metadata, passed: true, commands: next.implementation?.commands },
        },
        completed(base, 'verifier', 'Verification passed.'),
        started(base, 'reviewer', 'Independent review started.'),
      ];
    case 'verifying->failed':
      return [
        {
          ...base,
          stage: 'verifier',
          type: 'verification.completed',
          summary: next.failure ?? 'Verification failed.',
          metadata: { ...base.metadata, passed: false, commands: next.implementation?.commands },
        },
        failed(base, 'verifier', next.failure ?? 'Verification failed.'),
      ];
    case 'reviewing->pr-created':
      return [
        {
          ...base,
          stage: 'publisher',
          type: 'publication.completed',
          summary: `Draft PR #${next.prNumber} created.`,
          metadata: { ...base.metadata, prNumber: next.prNumber, draft: true },
        },
      ];
    case 'pr-created->completed':
    case 'reviewing->completed':
      return [
        {
          ...base,
          stage: 'run',
          type: 'run.completed',
          summary: 'Factory run completed without merge or approval.',
        },
      ];
    default:
      return [];
  }
}

function started(
  base: Omit<FactoryEventInput, 'type' | 'summary' | 'stage'>,
  stage: FactoryStage,
  summary: string,
): FactoryEventInput {
  return { ...base, stage, type: 'stage.started', summary };
}

function completed(
  base: Omit<FactoryEventInput, 'type' | 'summary' | 'stage'>,
  stage: FactoryStage,
  summary: string,
): FactoryEventInput {
  return { ...base, stage, type: 'stage.completed', summary };
}

function failed(
  base: Omit<FactoryEventInput, 'type' | 'summary' | 'stage'>,
  stage: FactoryStage,
  summary: string,
): FactoryEventInput {
  return {
    ...base,
    stage,
    type: 'stage.failed',
    summary,
    metadata: { ...base.metadata, failure: summary },
  };
}

function identifiers(run: FactoryRun): Record<string, unknown> {
  return {
    repository: run.task.repository,
    issueNumber: run.task.issueNumber,
    title: run.task.title,
    branch: run.branch,
    workspaceId: run.implementation?.workspaceId,
  };
}

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (FORBIDDEN_METADATA_KEYS.includes(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

function ingestEvent(
  current: FactoryRunEvent[],
  event: FactoryEventInput,
): { events: FactoryRunEvent[]; event: FactoryRunEvent } {
  const nextSequence = (current.at(-1)?.sequence ?? 0) + 1;
  const sequence = event.sequence ?? nextSequence;
  const recorded: FactoryRunEvent = parseFactoryRunEvent({
    ...event,
    sequence,
    metadata: sanitizeMetadata(event.metadata ?? {}),
  });
  const existing = current.find((item) => item.sequence === sequence);
  if (existing) {
    if (sameEvent(existing, recorded)) return { events: current, event: existing };
    throw new Error(
      `Factory event ${event.runId}#${sequence} already exists with different payload.`,
    );
  }
  if (sequence !== nextSequence) {
    throw new Error(
      `Factory event ${event.runId} must use sequence ${nextSequence}, received ${sequence}.`,
    );
  }
  const events = [...current, recorded];
  return { events, event: recorded };
}

function sameEvent(left: FactoryRunEvent, right: FactoryRunEvent): boolean {
  return JSON.stringify(canonicalEvent(left)) === JSON.stringify(canonicalEvent(right));
}

function canonicalEvent(event: FactoryRunEvent): unknown {
  return {
    runId: event.runId,
    sequence: event.sequence,
    stage: event.stage ?? null,
    type: event.type,
    timestamp: event.timestamp,
    attempt: event.attempt,
    summary: event.summary,
    metadata: event.metadata,
    policyVersion: event.policyVersion ?? null,
  };
}

function compareEvents(left: FactoryRunEvent, right: FactoryRunEvent): number {
  if (left.runId === right.runId) return left.sequence - right.sequence;
  return left.runId.localeCompare(right.runId) || left.timestamp - right.timestamp;
}

function upsertStage(
  stages: Map<string, FactoryStageProjection>,
  event: FactoryRunEvent,
  status: FactoryStageProjection['status'],
): void {
  const stage = event.stage ?? 'run';
  const key = `${stage}:${event.attempt}`;
  const current = stages.get(key) ?? { stage, status, attempt: event.attempt };
  if (status === 'started') current.startedAt = event.timestamp;
  if (status === 'completed' || status === 'failed') {
    current.endedAt = event.timestamp;
    if (current.startedAt !== undefined) current.durationMs = event.timestamp - current.startedAt;
  }
  current.status = status;
  stages.set(key, current);
}

function mergeIdentifiers(
  projection: FactoryRunProjection,
  metadata: Record<string, unknown>,
): void {
  projection.repository = optionalString(metadata.repository) ?? projection.repository;
  projection.issueNumber = optionalNumber(metadata.issueNumber) ?? projection.issueNumber;
  projection.title = optionalString(metadata.title) ?? projection.title;
  projection.branch = optionalString(metadata.branch) ?? projection.branch;
  projection.workspaceId = optionalString(metadata.workspaceId) ?? projection.workspaceId;
}

function mergeUsage(usage: FactoryUsage, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const incoming = value as FactoryUsage;
  if (incoming.model) usage.model = incoming.model;
  if (typeof incoming.inputTokens === 'number') usage.inputTokens = incoming.inputTokens;
  if (typeof incoming.outputTokens === 'number') usage.outputTokens = incoming.outputTokens;
  if (typeof incoming.cacheTokens === 'number') usage.cacheTokens = incoming.cacheTokens;
  if (typeof incoming.durationMs === 'number') usage.durationMs = incoming.durationMs;
  if (typeof incoming.cost === 'number') usage.cost = incoming.cost;
  if (typeof incoming.inspectionBudgetUsed === 'number') {
    usage.inspectionBudgetUsed = incoming.inspectionBudgetUsed;
  }
  if (Array.isArray(incoming.unknown)) {
    usage.unknown = [...new Set([...usage.unknown, ...incoming.unknown.map(String)])];
  }
}

function emptyUsage(): FactoryUsage {
  return { unknown: ['tokens', 'cost'] };
}

function formatUsage(usage: FactoryUsage): string | undefined {
  const known = [
    usage.model ? `model ${usage.model}` : undefined,
    usage.inputTokens !== undefined ? `${usage.inputTokens} input tokens` : undefined,
    usage.outputTokens !== undefined ? `${usage.outputTokens} output tokens` : undefined,
    usage.durationMs !== undefined ? `${usage.durationMs} ms` : undefined,
    usage.cost !== undefined ? `cost ${usage.cost}` : undefined,
  ].filter((item): item is string => Boolean(item));
  const unknown = usage.unknown.length > 0 ? `unknown: ${usage.unknown.join(', ')}` : undefined;
  const parts = [...known, unknown].filter((item): item is string => Boolean(item));
  return parts.length > 0 ? parts.join('; ') : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function readEventFile(filePath: string): Promise<FactoryRunEvent[]> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => parseFactoryRunEvent(item));
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function writeAtomicJson(filePath: string, events: FactoryRunEvent[]): Promise<void> {
  const temporaryPath = `${filePath}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(events, null, 2)}\n`);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
