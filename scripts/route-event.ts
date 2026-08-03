#!/usr/bin/env node
/**
 * GitHub event router entrypoint for GitHub Actions.
 *
 * Reads the event name and payload that GitHub Actions provides
 * (GITHUB_EVENT_NAME / GITHUB_EVENT_PATH), normalizes it, and routes it to a
 * configured agent. Prints a JSON routing decision to stdout and writes
 * `agent=<id>` to $GITHUB_OUTPUT when dispatched, so a workflow can branch on
 * the result.
 *
 * Required environment:
 *   GITHUB_EVENT_NAME  – set automatically by GitHub Actions
 *   GITHUB_EVENT_PATH  – path to the event payload JSON (set by Actions)
 * Optional:
 *   EVENT_ROUTER_CONFIG – path to the route config (default event-router.config.json)
 *   EVENT_ROUTER_STORE  – file path for duplicate-delivery persistence (optional)
 *   EVENT_ROUTER_DEBUG  – "true" to emit structured decision logs
 *
 * Exit codes:
 *   0 – routed (dispatched or safely ignored)
 *   1 – configuration / payload errors
 */

import { appendFile, readFile } from 'node:fs/promises';
import process from 'node:process';
import {
  createConsoleEventLogger,
  createEventRouter,
  createFileDeliveryStore,
  createMemoryDeliveryStore,
  loadConfigFromFile,
  parseEventPayload,
} from '../github/events/index.ts';
const DEFAULT_CONFIG_PATH = 'event-router.config.json';

function fail(message: string): never {
  console.error(`[event-router] ${message}`);
  process.exit(1);
}

async function main(): Promise<number> {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventName) fail('Missing required environment variable: GITHUB_EVENT_NAME');
  if (!eventPath) fail('Missing required environment variable: GITHUB_EVENT_PATH');

  const configPath = process.env.EVENT_ROUTER_CONFIG ?? DEFAULT_CONFIG_PATH;
  const loaded = await loadConfigFromFile(configPath);
  if (!loaded.ok) {
    console.error(`[event-router] Invalid event router config (${configPath}):`);
    for (const issue of loaded.issues) console.error(`  - ${issue}`);
    return 1;
  }

  let payloadText: string;
  try {
    payloadText = await readFile(eventPath, 'utf8');
  } catch (error) {
    fail(
      `Cannot read event payload at "${eventPath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadText) as unknown;
  } catch {
    fail(`Event payload at "${eventPath}" is not valid JSON.`);
  }

  const parsed = parseEventPayload(eventName, payload);
  if (!parsed.ok) {
    // Unsupported events are ignored safely — a routing decision, not an error.
    const reason = parsed.reason === 'unsupported' ? 'unconfigured' : 'malformed';
    console.error(`[event-router] ${parsed.detail}`);
    process.stdout.write(`${JSON.stringify({ outcome: 'ignore', reason, detail: parsed.detail })}\n`);
    return 0;
  }

  const store = process.env.EVENT_ROUTER_STORE
    ? createFileDeliveryStore(process.env.EVENT_ROUTER_STORE)
    : createMemoryDeliveryStore();
  const debug = process.env.EVENT_ROUTER_DEBUG === 'true';
  const router = createEventRouter(loaded.config, {
    store,
    logger: debug ? createConsoleEventLogger() : { log() {} },
  });

  const decision = await router.route(parsed.event);
  process.stdout.write(`${JSON.stringify(decision)}\n`);

  // Let downstream workflow steps branch on the dispatched agent id.
  if (decision.outcome === 'dispatch' && process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `agent=${decision.agent}\n`, 'utf8');
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  },
);
