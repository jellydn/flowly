/**
 * Event router configuration. Maps event families to agent IDs with optional
 * filters (action, branch, label, actor, repository, conclusion).
 *
 * Two shapes are accepted:
 *
 *   - array form (recommended):
 *       { "routes": [{ "event": "pull_request", "action": "opened", "agent": "review" }] }
 *   - shorthand map:
 *       { "routes": { "pull_request.opened": "review" } }
 *
 * Invalid routes fail validation with actionable messages naming the route
 * and the offending field, so a misconfigured file is caught before any
 * event is routed.
 */

import { readFile } from 'node:fs/promises';
import * as v from 'valibot';
import { isEventType, SUPPORTED_EVENT_TYPES, type EventType } from './types.ts';

const nonEmptyStringArray = v.pipe(
  v.array(v.pipe(v.string(), v.minLength(1))),
  v.minLength(1),
);

const filterSchema = v.object({
  action: v.optional(nonEmptyStringArray),
  branch: v.optional(nonEmptyStringArray),
  label: v.optional(nonEmptyStringArray),
  actor: v.optional(nonEmptyStringArray),
  repository: v.optional(nonEmptyStringArray),
  conclusion: v.optional(nonEmptyStringArray),
});

const ruleSchema = v.object({
  event: v.picklist([...SUPPORTED_EVENT_TYPES]),
  agent: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  /** Shorthand for `filter.action`; folded into the filter on normalize. */
  action: v.optional(v.pipe(v.string(), v.minLength(1))),
  filter: v.optional(filterSchema),
});

const configSchema = v.object({
  routes: v.pipe(v.array(ruleSchema), v.minLength(1)),
});

export type RouteFilter = {
  action?: string[];
  branch?: string[];
  label?: string[];
  actor?: string[];
  repository?: string[];
  conclusion?: string[];
};

export type RouteRule = {
  event: EventType;
  agent: string;
  filter?: RouteFilter;
};

export type EventRouterConfig = {
  routes: RouteRule[];
};

export type ConfigResult =
  | { ok: true; config: EventRouterConfig }
  | { ok: false; issues: string[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatIssue(issue: {
  path?: Array<{ key: unknown }>;
  message: string;
}): string {
  const path = issue.path?.map((p) => String(p.key)).join('.');
  return `${path ? path : '(root)'}: ${issue.message}`;
}

/**
 * Parse a shorthand key into a rule head. Supported shapes:
 *   "event"                        – any action of the family
 *   "event.action"                 – one action of the family
 *   "workflow_run.action.conclusion" – workflow_run action + conclusion
 *   "event.action.label"           – non-workflow_run action + required label
 */
function parseShorthandKey(key: string): {
  event: EventType;
  action?: string;
  conclusion?: string;
  label?: string;
} | null {
  const parts = key.split('.');
  if (parts.length < 1 || parts.length > 3) return null;
  const [event] = parts;
  if (!isEventType(event)) return null;
  if (parts.length === 1) return { event };
  if (parts.length === 2) return { event, action: parts[1] };
  if (event === 'workflow_run') {
    return { event, action: parts[1], conclusion: parts[2] };
  }
  return { event, action: parts[1], label: parts[2] };
}

/** Fold a rule's top-level `action` into its filter, dropping empty filters. */
function normalizeRule(rule: v.InferOutput<typeof ruleSchema>): RouteRule {
  const filter: RouteFilter = rule.filter ? { ...rule.filter } : {};
  if (rule.action) {
    filter.action = filter.action
      ? [...new Set([...filter.action, rule.action])]
      : [rule.action];
  }
  const normalized: RouteRule = { event: rule.event, agent: rule.agent };
  if (Object.keys(filter).length > 0) normalized.filter = filter;
  return normalized;
}

/**
 * Parse and validate an event router config (array or shorthand shape).
 * Never throws — returns human-readable, actionable issues instead.
 */
export function safeParseConfig(value: unknown): ConfigResult {
  const routesValue = isObject(value) ? value['routes'] : undefined;
  if (routesValue === undefined) {
    return { ok: false, issues: ['config must be an object with a non-empty "routes" key'] };
  }

  if (Array.isArray(routesValue)) {
    const result = v.safeParse(configSchema, value);
    if (!result.success) return { ok: false, issues: result.issues.map(formatIssue) };
    return { ok: true, config: { routes: result.output.routes.map(normalizeRule) } };
  }

  if (isObject(routesValue)) {
    const rules: RouteRule[] = [];
    const issues: string[] = [];
    for (const [key, agent] of Object.entries(routesValue)) {
      if (typeof agent !== 'string' || agent.trim() === '') {
        issues.push(
          `routes["${key}"]: agent must be a non-empty string, got ${typeof agent}`,
        );
        continue;
      }
      const parsed = parseShorthandKey(key);
      if (!parsed) {
        issues.push(
          `routes["${key}"]: key must be "<event>", "<event>.<action>", or "<event>.<action>.<conclusion>" where <event> is one of ${SUPPORTED_EVENT_TYPES.join(', ')}`,
        );
        continue;
      }
      const rule: RouteRule = { event: parsed.event, agent };
      if (parsed.action || parsed.conclusion || parsed.label) {
        rule.filter = {};
        if (parsed.action) rule.filter.action = [parsed.action];
        if (parsed.conclusion) rule.filter.conclusion = [parsed.conclusion];
        if (parsed.label) rule.filter.label = [parsed.label];
      }
      rules.push(rule);
    }
    if (issues.length > 0) return { ok: false, issues };
    if (rules.length === 0) {
      return { ok: false, issues: ['config must declare at least one route'] };
    }
    return { ok: true, config: { routes: rules } };
  }

  return {
    ok: false,
    issues: ['"routes" must be an array or an object mapping event keys to agent IDs'],
  };
}

/**
 * Load and validate a config file from disk. Returns actionable issues when
 * the file is missing, unreadable, not JSON, or fails validation.
 */
export async function loadConfigFromFile(filePath: string): Promise<ConfigResult> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, issues: [`Cannot read config file "${filePath}": ${detail}`] };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, issues: [`Config file "${filePath}" is not valid JSON.`] };
  }
  return safeParseConfig(json);
}
