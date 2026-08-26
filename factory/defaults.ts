import type { FactoryClassifier, FactoryProgressPublisher } from './intake.ts';
import type { FactoryImplementer } from './implementation.ts';
import type { FactoryPlanner } from './plan.ts';
import type { FactoryIndependentReviewer } from './review.ts';
import type { FactoryTask } from './types.ts';
import { GitHubClient } from '../github/client.ts';

/** Classifier that only asks for a non-empty issue body. */
export function createDeterministicFactoryClassifier(): FactoryClassifier {
  return {
    async classify(task: FactoryTask) {
      const missing = task.body.trim()
        ? []
        : ['Describe the requested change so the factory can plan it.'];
      return {
        actionable: missing.length === 0,
        type: 'feature' as const,
        priority: 'medium' as const,
        complexity: 'medium' as const,
        missingInformation: missing,
      };
    },
  };
}

/** Planner that records the issue title without inspecting the repository. */
export function createDeterministicFactoryPlanner(): FactoryPlanner {
  return {
    async plan({ task }) {
      return {
        summary: task.title,
        steps: ['Implement the requested change in an isolated factory workspace.'],
        acceptanceCriteria: [{ description: `Issue #${task.issueNumber} is addressed.` }],
        verificationCommands: ['npm test'],
        relevantFiles: [],
        risks: [
          'Deterministic planner does not inspect the repository; replace with a read-only analyst agent.',
        ],
      };
    },
  };
}

/** Independent reviewer that never auto-approves. */
export function createDeterministicFactoryReviewer(): FactoryIndependentReviewer {
  return {
    async review(evidence) {
      const hasDiff = evidence.diff.trim().length > 0;
      return {
        summary: hasDiff
          ? 'A factory-branch diff is present for human review.'
          : 'No implementation diff was produced.',
        verdict: 'COMMENT',
        findings: [],
      };
    },
  };
}

/** Implementer that leaves the isolated workspace unchanged. */
export function createNoopFactoryImplementer(): FactoryImplementer {
  return {
    async implement() {},
  };
}

/** Trusted issue-comment progress boundary. */
export function createIssueCommentProgress(client: GitHubClient): FactoryProgressPublisher {
  return {
    async publish(task, body) {
      await client.createIssueComment(task.issueNumber, body);
    },
  };
}
