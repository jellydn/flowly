/**
 * The routing engine: match a normalized event against configured routes.
 *
 * Matching is first-match-wins in route-declaration order. A route matches
 * when the event family and every declared filter (action, branch, label,
 * actor, repository, conclusion) matches. Unconfigured events are ignored
 * safely — the router never throws on a non-match.
 */

import type { EventRouterConfig, RouteRule } from './config.ts';
import { createMemoryDeliveryStore, type DeliveryStore } from './dedupe.ts';
import type { NormalizedEvent } from './types.ts';

export type RoutingDecision =
  | { outcome: 'dispatch'; route: RouteRule; agent: string }
  | {
      outcome: 'ignore';
      reason: 'duplicate' | 'unconfigured';
      detail: string;
    };

export type EventLogger = {
  log(decision: RoutingDecision, event: NormalizedEvent): void;
};

export type EventRouterOptions = {
  /** Delivery store for duplicate detection. Defaults to in-memory. */
  store?: DeliveryStore;
  /** Structured logger for routing decisions. Defaults to no-op. */
  logger?: EventLogger;
};

export type EventRouter = {
  route(event: NormalizedEvent): Promise<RoutingDecision>;
};

function filterMatches(rule: RouteRule, event: NormalizedEvent): boolean {
  const filter = rule.filter;
  if (!filter) return true;

  if (filter.action && !filter.action.includes(event.action)) return false;
  if (filter.branch && !(event.branch && filter.branch.includes(event.branch))) {
    return false;
  }
  if (filter.label && !event.labels.some((label) => filter.label!.includes(label))) {
    return false;
  }
  if (filter.actor && !filter.actor.includes(event.actor)) return false;
  if (filter.repository && !filter.repository.includes(event.repository)) return false;
  if (filter.conclusion && !(event.conclusion && filter.conclusion.includes(event.conclusion))) {
    return false;
  }
  return true;
}

/** First matching route for an event, or null. Pure and synchronous for tests. */
export function matchRoute(routes: RouteRule[], event: NormalizedEvent): RouteRule | null {
  for (const route of routes) {
    if (route.event !== event.type) continue;
    if (filterMatches(route, event)) return route;
  }
  return null;
}

export function createEventRouter(
  config: EventRouterConfig,
  options: EventRouterOptions = {},
): EventRouter {
  const store: DeliveryStore = options.store ?? createMemoryDeliveryStore();
  const logger: EventLogger = options.logger ?? { log() {} };
  const routes = config.routes;

  return {
    async route(event: NormalizedEvent): Promise<RoutingDecision> {
      if (await store.has(event.id)) {
        const decision: RoutingDecision = {
          outcome: 'ignore',
          reason: 'duplicate',
          detail: `Duplicate delivery for "${event.id}"`,
        };
        logger.log(decision, event);
        return decision;
      }

      const route = matchRoute(routes, event);
      if (!route) {
        const decision: RoutingDecision = {
          outcome: 'ignore',
          reason: 'unconfigured',
          detail: `No route configured for ${event.type}.${event.action}`,
        };
        logger.log(decision, event);
        return decision;
      }

      await store.remember(event.id);
      const decision: RoutingDecision = {
        outcome: 'dispatch',
        route,
        agent: route.agent,
      };
      logger.log(decision, event);
      return decision;
    },
  };
}
