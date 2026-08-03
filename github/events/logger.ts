/**
 * Structured, JSON-line routing logs. Each routing decision is emitted as a
 * single JSON object on stderr so stdout stays clean for the CLI's machine
 * output. Sensitive payload content is never logged — only event metadata and
 * the decision.
 */

import type { EventLogger, RoutingDecision } from './router.ts';
import type { NormalizedEvent } from './types.ts';

export function createConsoleEventLogger(
  write: (line: string) => void = (line) => console.error(line),
): EventLogger {
  return {
    log(decision: RoutingDecision, event: NormalizedEvent): void {
      const entry: Record<string, unknown> = {
        ts: new Date().toISOString(),
        level: decision.outcome === 'dispatch' ? 'info' : 'warn',
        event: event.type,
        action: event.action,
        repository: event.repository,
        actor: event.actor,
        decision: decision.outcome,
      };
      if (decision.outcome === 'dispatch') {
        entry['agent'] = decision.agent;
      } else {
        entry['reason'] = decision.reason;
        entry['detail'] = decision.detail;
      }
      write(`[event-router] ${JSON.stringify(entry)}`);
    },
  };
}
