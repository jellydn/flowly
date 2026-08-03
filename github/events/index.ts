/**
 * GitHub event router — maps repository events to configured agents.
 *
 * Public surface: config parsing/loading, payload normalization, the routing
 * engine, duplicate-delivery stores, and structured logging. See
 * {@link ./router.ts} for the engine and {@link ./config.ts} for the
 * configuration file format.
 */

export {
  loadConfigFromFile,
  safeParseConfig,
  type ConfigResult,
  type EventRouterConfig,
  type RouteFilter,
  type RouteRule,
} from './config.ts';
export {
  createFileDeliveryStore,
  createMemoryDeliveryStore,
  type DeliveryStore,
} from './dedupe.ts';
export { createConsoleEventLogger } from './logger.ts';
export { parseEventPayload, type PayloadParseResult } from './payloads.ts';
export {
  createEventRouter,
  matchRoute,
  type EventLogger,
  type EventRouter,
  type EventRouterOptions,
  type RoutingDecision,
} from './router.ts';
export {
  isEventType,
  SUPPORTED_EVENT_TYPES,
  type EventType,
  type NormalizedEvent,
} from './types.ts';
