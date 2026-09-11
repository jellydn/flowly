#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { explainFactoryRun, FileFactoryEventLog, projectFactoryRun } from '../factory/events.ts';

const [command, subcommand, runId] = process.argv.slice(2);
const log = new FileFactoryEventLog(
  path.resolve(process.env.FACTORY_EVENT_STORE ?? '.factory-events'),
);

async function main(): Promise<void> {
  if (command !== 'runs') {
    throw new Error(
      'Usage: npm run factory -- runs list | show <run-id> | timeline <run-id> | explain <run-id>',
    );
  }
  if (subcommand === 'list') {
    const events = await log.list();
    const runIds = [...new Set(events.map((event) => event.runId))];
    const projections = [];
    for (const id of runIds) {
      projections.push(projectFactoryRun(events.filter((event) => event.runId === id)));
    }
    console.log(
      JSON.stringify(
        projections.map((projection) => ({
          runId: projection.runId,
          status: projection.status,
          currentStage: projection.currentStage,
          repository: projection.repository,
          issueNumber: projection.issueNumber,
          branch: projection.branch,
          workspaceId: projection.workspaceId,
        })),
        null,
        2,
      ),
    );
    return;
  }
  if (!runId) {
    throw new Error('A run id is required for show, timeline, and explain.');
  }
  const events = await log.list(runId);
  if (events.length === 0) throw new Error(`Factory run ${runId} has no recorded events.`);
  if (subcommand === 'show') {
    console.log(JSON.stringify(projectFactoryRun(events), null, 2));
    return;
  }
  if (subcommand === 'timeline') {
    console.log(
      JSON.stringify(
        events.map((event) => ({
          sequence: event.sequence,
          type: event.type,
          stage: event.stage,
          attempt: event.attempt,
          timestamp: event.timestamp,
          summary: event.summary,
          policyVersion: event.policyVersion,
        })),
        null,
        2,
      ),
    );
    return;
  }
  if (subcommand === 'explain') {
    console.log(explainFactoryRun(events));
    return;
  }
  throw new Error(
    'Usage: npm run factory -- runs list | show <run-id> | timeline <run-id> | explain <run-id>',
  );
}

main().catch((error: unknown) => {
  console.error(`[flowly-factory] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
