/**
 * GitHub Actions / webhook payload normalization.
 *
 * Reads the event name (GITHUB_EVENT_NAME) and raw webhook JSON payload
 * (GITHUB_EVENT_PATH) and produces a stable {@link NormalizedEvent}. Unsupported
 * event names and malformed payloads are reported as controlled results so the
 * CLI can ignore them safely instead of crashing.
 */

import {
  isEventType,
  SUPPORTED_EVENT_TYPES,
  type EventType,
  type NormalizedEvent,
} from './types.ts';

export type PayloadParseResult =
  | { ok: true; event: NormalizedEvent }
  | { ok: false; reason: 'unsupported' | 'malformed'; detail: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Stringify a numeric or string identifier. GitHub payload IDs (issue number,
 * comment id, review id, workflow_run id) are numbers — they must be included
 * in the dedupe fingerprint or every event of the same action would collide.
 */
function asStringId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

/** Extract `name` fields from an array of { name } objects (e.g. labels). */
function extractNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    const name = asString(asRecord(item)?.['name']);
    if (name) names.push(name);
  }
  return names;
}

/** Build the stable dedupe fingerprint for an event. */
function buildEventId(
  type: EventType,
  action: string,
  repository: string,
  discriminator: string | undefined,
): string {
  return `${type}:${action}:${repository}:${discriminator ?? '?'}`;
}

type CommonFields = {
  repository: string;
  actor: string;
  action: string;
};

/** Pull repository, actor, and action from a webhook payload. */
function readCommon(payload: Record<string, unknown>): CommonFields | null {
  const repository = asString(asRecord(payload['repository'])?.['full_name']);
  if (!repository) return null;
  const actor =
    asString(asRecord(payload['sender'])?.['login']) ??
    asString(asRecord(payload['pusher'])?.['name']) ??
    'unknown';
  const action = asString(payload['action']) ?? 'unknown';
  return { repository, actor, action };
}

/** Pull the head branch + sha off a `pull_request` object if present. */
function readPrHead(pr: Record<string, unknown> | undefined): {
  branch?: string;
  sha?: string;
} {
  const head = asRecord(pr?.['head']);
  return {
    branch: asString(head?.['ref']),
    sha: asString(head?.['sha']),
  };
}

function normalizePullRequest(payload: Record<string, unknown>): NormalizedEvent | null {
  const common = readCommon(payload);
  const pr = asRecord(payload['pull_request']);
  if (!common || !pr) return null;
  const head = readPrHead(pr);
  return {
    id: buildEventId('pull_request', common.action, common.repository, head.sha),
    type: 'pull_request',
    action: common.action,
    repository: common.repository,
    actor: common.actor,
    branch: head.branch,
    labels: extractNames(pr['labels']),
    payload,
  };
}

function normalizeIssues(payload: Record<string, unknown>): NormalizedEvent | null {
  const common = readCommon(payload);
  const issue = asRecord(payload['issue']);
  if (!common || !issue) return null;
  return {
    id: buildEventId('issues', common.action, common.repository, asStringId(issue['number'])),
    type: 'issues',
    action: common.action,
    repository: common.repository,
    actor: common.actor,
    labels: extractNames(issue['labels']),
    payload,
  };
}

function normalizeIssueComment(payload: Record<string, unknown>): NormalizedEvent | null {
  const common = readCommon(payload);
  const issue = asRecord(payload['issue']);
  const comment = asRecord(payload['comment']);
  if (!common || !issue || !comment) return null;
  return {
    id: buildEventId('issue_comment', common.action, common.repository, asStringId(comment['id'])),
    type: 'issue_comment',
    action: common.action,
    repository: common.repository,
    actor: common.actor,
    labels: extractNames(issue['labels']),
    payload,
  };
}

function normalizePullRequestReview(payload: Record<string, unknown>): NormalizedEvent | null {
  const common = readCommon(payload);
  const pr = asRecord(payload['pull_request']);
  const review = asRecord(payload['review']);
  if (!common || !pr || !review) return null;
  const head = readPrHead(pr);
  return {
    id: buildEventId(
      'pull_request_review',
      common.action,
      common.repository,
      asStringId(review['id']),
    ),
    type: 'pull_request_review',
    action: common.action,
    repository: common.repository,
    actor: common.actor,
    branch: head.branch,
    labels: extractNames(pr['labels']),
    payload,
  };
}

function normalizePullRequestReviewComment(
  payload: Record<string, unknown>,
): NormalizedEvent | null {
  const common = readCommon(payload);
  const pr = asRecord(payload['pull_request']);
  const comment = asRecord(payload['comment']);
  if (!common || !pr || !comment) return null;
  const head = readPrHead(pr);
  return {
    id: buildEventId(
      'pull_request_review_comment',
      common.action,
      common.repository,
      asStringId(comment['id']),
    ),
    type: 'pull_request_review_comment',
    action: common.action,
    repository: common.repository,
    actor: common.actor,
    branch: head.branch,
    labels: extractNames(pr['labels']),
    payload,
  };
}

function normalizeWorkflowRun(payload: Record<string, unknown>): NormalizedEvent | null {
  const common = readCommon(payload);
  const run = asRecord(payload['workflow_run']);
  if (!common || !run) return null;
  return {
    id: buildEventId('workflow_run', common.action, common.repository, asStringId(run['id'])),
    type: 'workflow_run',
    action: common.action,
    repository: common.repository,
    actor: common.actor,
    branch: asString(run['head_branch']),
    labels: [],
    conclusion: asString(run['conclusion']),
    workflow: asString(run['name']),
    payload,
  };
}

/** Normalize a raw GitHub webhook / Actions payload into a stable event. */
export function parseEventPayload(eventName: string, payload: unknown): PayloadParseResult {
  if (!isEventType(eventName)) {
    return {
      ok: false,
      reason: 'unsupported',
      detail: `Event "${eventName}" is not supported. Supported: ${SUPPORTED_EVENT_TYPES.join(', ')}`,
    };
  }
  if (!isObject(payload)) {
    return {
      ok: false,
      reason: 'malformed',
      detail: `Payload for "${eventName}" is not a JSON object.`,
    };
  }

  const normalizers: Record<EventType, (p: Record<string, unknown>) => NormalizedEvent | null> = {
    pull_request: normalizePullRequest,
    issues: normalizeIssues,
    issue_comment: normalizeIssueComment,
    pull_request_review: normalizePullRequestReview,
    pull_request_review_comment: normalizePullRequestReviewComment,
    workflow_run: normalizeWorkflowRun,
  };

  const event = normalizers[eventName](payload);
  if (!event) {
    return {
      ok: false,
      reason: 'malformed',
      detail: `Payload for "${eventName}" is missing required fields (repository, and the event subject).`,
    };
  }
  return { ok: true, event };
}
