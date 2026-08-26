import { runFactoryPipeline, type FactoryPipelineDependencies } from './run.ts';
import type { FactoryRun, FactoryTask } from './types.ts';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    const name = isObject(item) ? item['name'] : undefined;
    if (typeof name === 'string' && name.length > 0) names.push(name);
  }
  return names;
}

/**
 * Build a factory task from an `issues.labeled` delivery. Rejects any event
 * that is not a factory-labeled issue so the workflow cannot start a run
 * from a review or CI payload.
 */
export function factoryTaskFromIssuesEvent(eventName: string, payload: unknown): FactoryTask {
  if (eventName !== 'issues') {
    throw new Error(`Factory dispatch expected issues.labeled, received ${eventName}.`);
  }
  if (!isObject(payload)) {
    throw new Error('Factory dispatch rejected the event payload: not a JSON object.');
  }
  if (payload['action'] !== 'labeled') {
    throw new Error(
      `Factory dispatch expected issues.labeled, received issues.${String(payload['action'])}.`,
    );
  }

  const repository = isObject(payload['repository'])
    ? payload['repository']['full_name']
    : undefined;
  if (typeof repository !== 'string' || !repository.includes('/')) {
    throw new Error('Factory dispatch requires repository.full_name.');
  }

  const issue = isObject(payload['issue']) ? payload['issue'] : undefined;
  const addedLabel = isObject(payload['label']) ? payload['label']['name'] : undefined;
  const labels = labelNames(issue?.['labels']);
  if (addedLabel !== 'factory' && !labels.includes('factory')) {
    throw new Error('Factory dispatch requires the factory label on the issue.');
  }

  const number = issue?.['number'];
  const title = issue?.['title'];
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
    throw new Error('Factory dispatch requires a positive issue number.');
  }
  if (typeof title !== 'string' || !title.trim()) {
    throw new Error('Factory dispatch requires an issue title.');
  }
  const body = typeof issue?.['body'] === 'string' ? issue['body'] : '';
  return {
    issueNumber: number,
    title: title.trim(),
    body,
    repository,
  };
}

export async function dispatchFactoryLabeledIssue(
  eventName: string,
  payload: unknown,
  dependencies: FactoryPipelineDependencies,
): Promise<FactoryRun> {
  const task = factoryTaskFromIssuesEvent(eventName, payload);
  return runFactoryPipeline(task, dependencies);
}
