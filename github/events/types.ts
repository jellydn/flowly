/**
 * Normalized GitHub event model shared by the event router.
 *
 * The router maps repository events (pull requests, issues, reviews,
 * comments, workflow runs) to configured agent IDs. Webhook and GitHub
 * Actions payloads are normalized into this provider-agnostic shape before
 * any routing happens.
 */

/** Event families the router understands. */
export const SUPPORTED_EVENT_TYPES = [
  'pull_request',
  'issues',
  'issue_comment',
  'pull_request_review',
  'pull_request_review_comment',
  'workflow_run',
] as const;

export type EventType = (typeof SUPPORTED_EVENT_TYPES)[number];

export function isEventType(value: string): value is EventType {
  return (SUPPORTED_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * A normalized, provider-agnostic event. `id` is a stable fingerprint used to
 * detect duplicate deliveries; `payload` keeps the raw webhook payload for
 * downstream consumers.
 */
export type NormalizedEvent = {
  /** Stable fingerprint for duplicate-delivery detection. */
  id: string;
  type: EventType;
  action: string;
  /** Full repository name, e.g. "owner/repo". */
  repository: string;
  /** Login of the user (or app) that triggered the event. */
  actor: string;
  /** Head branch when the event is branch-scoped. */
  branch?: string;
  /** Labels attached to the issue or pull request. */
  labels: string[];
  /** Workflow conclusion for `workflow_run` events (success, failure, ...). */
  conclusion?: string;
  /** Workflow name for `workflow_run` events. */
  workflow?: string;
  /** Original raw payload, kept for downstream consumers. */
  payload: unknown;
};
