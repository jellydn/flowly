/**
 * Duplicate-delivery detection for the event router.
 *
 * GitHub webhooks can be redelivered (and GitHub Actions workflows can rerun),
 * so the router remembers the fingerprint of every event it has dispatched.
 * A store is pluggable: in-memory for single runs, or file-backed so reruns
 * of a workflow don't double-dispatch the same delivery.
 */

import { readFile, writeFile } from 'node:fs/promises';

export interface DeliveryStore {
  has(id: string): Promise<boolean>;
  remember(id: string): Promise<void>;
}

/** In-memory store. Sufficient for one-shot CLI invocations within a process. */
export function createMemoryDeliveryStore(): DeliveryStore {
  const seen = new Set<string>();
  return {
    async has(id: string): Promise<boolean> {
      return seen.has(id);
    },
    async remember(id: string): Promise<void> {
      seen.add(id);
    },
  };
}

/**
 * File-backed store that persists seen delivery fingerprints as a JSON array.
 * Creating a new store instance re-reads the file, so a restarted process
 * (e.g. a rerun of the same workflow) still recognizes earlier deliveries.
 */
export function createFileDeliveryStore(filePath: string): DeliveryStore {
  let loaded: Promise<Set<string>> | null = null;

  async function load(): Promise<Set<string>> {
    try {
      const text = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((x): x is string => typeof x === 'string'));
      }
    } catch {
      // Missing or corrupt file: start empty. Corrupt files are overwritten on save.
    }
    return new Set();
  }

  function getLoaded(): Promise<Set<string>> {
    if (loaded === null) loaded = load();
    return loaded;
  }

  return {
    async has(id: string): Promise<boolean> {
      return (await getLoaded()).has(id);
    },
    async remember(id: string): Promise<void> {
      const seen = await getLoaded();
      seen.add(id);
      await writeFile(filePath, JSON.stringify([...seen], null, 2), 'utf8');
    },
  };
}
