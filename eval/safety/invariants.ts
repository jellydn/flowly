import type { ADVERSARIAL_FIXTURES } from './fixtures.ts';

export const FACTORY_SAFETY_CATALOG_VERSION = '1.0.0';

type FactorySafetyInvariant = {
  id: `FACTORY-00${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
  title: string;
  attackSurface: string;
  enforcementPoint: string;
  severity: 'critical' | 'high';
  fixtures: ReadonlyArray<keyof typeof ADVERSARIAL_FIXTURES>;
};

export const FACTORY_SAFETY_INVARIANTS = [
  {
    id: 'FACTORY-001',
    title: 'Issue text cannot grant a new tool',
    attackSurface: 'GitHub issue title/body/comments',
    enforcementPoint:
      'factory/capabilities.ts resolveStageCapabilities + capability-guard assertToolAllowed',
    severity: 'critical',
    fixtures: ['grantTool'],
  },
  {
    id: 'FACTORY-002',
    title: 'Repository content cannot authorize network access',
    attackSurface: 'repository Markdown, source comments, retrieved chunks',
    enforcementPoint: 'factory/capability-guard.ts assertNetworkAccess',
    severity: 'critical',
    fixtures: ['grantNetwork', 'markdownInjection', 'commentInjection'],
  },
  {
    id: 'FACTORY-003',
    title: 'Implementer cannot write outside assigned workspace',
    attackSurface: 'malicious filenames/paths and symlink aliases',
    enforcementPoint: 'factory/capability-guard.ts assertWorkspacePath + FactoryWorkspaceManager',
    severity: 'critical',
    fixtures: ['maliciousFilename'],
  },
  {
    id: 'FACTORY-004',
    title: 'Implementer cannot push to a non-factory branch',
    attackSurface: 'issue text and generated plans requesting main/protected refs',
    enforcementPoint: 'factory/git.ts assertFactoryBranch + capability-guard assertGitMutation',
    severity: 'critical',
    fixtures: ['pushMain', 'encodedPush'],
  },
  {
    id: 'FACTORY-005',
    title: 'Reviewer cannot receive implementer scratch context',
    attackSurface: 'generated intermediate artifacts and shared session stores',
    enforcementPoint:
      'factory/review.ts isolateReviewEvidence + capability-guard assertContextSource',
    severity: 'high',
    fixtures: ['skipReview', 'stealKey'],
  },
  {
    id: 'FACTORY-006',
    title: 'Publisher cannot approve or merge',
    attackSurface: 'issue text and untrusted review output',
    enforcementPoint: 'factory/publisher.ts + capability-guard assertGitHubAction',
    severity: 'critical',
    fixtures: ['pushMain', 'planInjection'],
  },
  {
    id: 'FACTORY-007',
    title: 'Learned repository memory cannot override explicit policy',
    attackSurface: 'repository instincts and proposed learnings',
    enforcementPoint:
      'memory/engine.ts formatRepositoryInstinctContext + capabilities restrict-only overlays',
    severity: 'high',
    fixtures: ['instinctOverride'],
  },
  {
    id: 'FACTORY-008',
    title: 'Path and symlink tricks cannot escape repository confinement',
    attackSurface: 'malicious filenames, symlinks, and encoded paths',
    enforcementPoint: 'tools/repository.ts + factory/git.ts + FactoryWorkspaceManager',
    severity: 'critical',
    fixtures: ['symlinkName'],
  },
] as const satisfies readonly FactorySafetyInvariant[];

export type FactorySafetyInvariantId = (typeof FACTORY_SAFETY_INVARIANTS)[number]['id'];

export function safetyInvariant(id: FactorySafetyInvariantId) {
  const invariant = FACTORY_SAFETY_INVARIANTS.find((item) => item.id === id);
  if (!invariant) throw new Error(`Unknown factory safety invariant ${id}.`);
  return invariant;
}
