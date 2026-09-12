/**
 * Deterministic tour of the controls around Flowly's issue-to-draft-PR factory.
 * It performs no repository writes, network calls, Git operations, or GitHub mutations.
 */

import { FACTORY_STAGES, resolveFactoryCapabilityAudit } from '../factory/capabilities.ts';
import { explainFactoryRun, projectFactoryRun, type FactoryRunEvent } from '../factory/events.ts';
import { DEFAULT_WORKSPACE_RETENTION } from '../factory/workspace-lifecycle.ts';
import {
  FACTORY_SAFETY_CATALOG_VERSION,
  FACTORY_SAFETY_INVARIANTS,
} from '../eval/security/invariants.ts';

const runId = 'demo-run';
const common = {
  runId,
  attempt: 1,
  policyVersion: '1.0.0',
  metadata: {
    repository: 'owner/repository',
    issueNumber: 42,
    title: 'Improve the repository documentation',
    branch: 'factory/42-improve-repository-documentation',
    workspaceId: 'demo-run-a1',
  },
};

const sampleEvents: FactoryRunEvent[] = [
  {
    ...common,
    sequence: 1,
    stage: 'run',
    type: 'run.started',
    timestamp: 1,
    summary: 'Factory run started.',
  },
  {
    ...common,
    sequence: 2,
    stage: 'verifier',
    type: 'verification.completed',
    timestamp: 2,
    summary: 'Repository verification passed.',
    metadata: { ...common.metadata, passed: true, commands: ['npm run check'] },
  },
  {
    ...common,
    sequence: 3,
    stage: 'reviewer',
    type: 'review.completed',
    timestamp: 3,
    summary: 'Independent review is ready for human review.',
    metadata: {
      ...common.metadata,
      verdict: 'COMMENT',
      readyForHumanReview: true,
    },
  },
  {
    ...common,
    sequence: 4,
    stage: 'publisher',
    type: 'publication.completed',
    timestamp: 4,
    summary: 'Draft PR #123 created.',
    metadata: { ...common.metadata, prNumber: 123, draft: true },
  },
  {
    ...common,
    sequence: 5,
    stage: 'run',
    type: 'run.completed',
    timestamp: 5,
    summary: 'Factory run completed.',
  },
];

function main(): void {
  const capabilityAudit = resolveFactoryCapabilityAudit();
  const projection = projectFactoryRun(sampleEvents);
  const output = {
    capabilities: FACTORY_STAGES.map((stage) => {
      const profile = capabilityAudit.stages[stage]!;
      return {
        stage,
        repository: profile.repository,
        tools: profile.tools,
        network: profile.network,
        githubActions: profile.github.allowedActions,
      };
    }),
    workspaceRetention: DEFAULT_WORKSPACE_RETENTION,
    safetyCatalog: {
      version: FACTORY_SAFETY_CATALOG_VERSION,
      invariants: FACTORY_SAFETY_INVARIANTS.map(({ id, title, enforcementPoint }) => ({
        id,
        title,
        enforcementPoint,
      })),
    },
    sampleRun: projection,
    explanation: explainFactoryRun(sampleEvents),
  };

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log('Flowly factory controls');
  console.log('=======================');
  console.log('This deterministic demo performs no writes or network calls.');
  console.log();
  console.log('Least-capability stages:');
  for (const profile of output.capabilities) {
    const actions = profile.githubActions.length > 0 ? profile.githubActions.join(', ') : 'none';
    console.log(
      `- ${profile.stage}: tools=${profile.tools.length}, network=${profile.network.mode}, GitHub=${actions}`,
    );
  }
  console.log();
  console.log('Workspace retention defaults:');
  console.log(`- completed: ${DEFAULT_WORKSPACE_RETENTION.completedMs / 60_000} minutes`);
  console.log(`- failed: ${DEFAULT_WORKSPACE_RETENTION.failedMs / 3_600_000} hours`);
  console.log(`- cancelled: ${DEFAULT_WORKSPACE_RETENTION.cancelledMs / 60_000} minutes`);
  console.log(`- retained for debugging: ${DEFAULT_WORKSPACE_RETENTION.debugMs / 86_400_000} days`);
  console.log();
  console.log(
    `Security catalog ${FACTORY_SAFETY_CATALOG_VERSION}: ${FACTORY_SAFETY_INVARIANTS.length} invariants`,
  );
  for (const invariant of FACTORY_SAFETY_INVARIANTS) {
    console.log(`- ${invariant.id}: ${invariant.title}`);
  }
  console.log();
  console.log('Operator timeline:');
  for (const event of sampleEvents) {
    console.log(`- ${event.sequence}. ${event.type}: ${event.summary}`);
  }
  console.log();
  console.log(output.explanation);
}

main();
