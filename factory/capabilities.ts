import * as v from 'valibot';

export const FACTORY_CAPABILITY_POLICY_VERSION = '1.0.0';

export const FACTORY_STAGES = [
  'classifier',
  'planner',
  'implementer',
  'verifier',
  'reviewer',
  'publisher',
] as const;
export type FactoryStage = (typeof FACTORY_STAGES)[number];

export const FACTORY_KNOWN_TOOLS = [
  'list_files',
  'read_file',
  'write_file',
  'search_code',
  'search_docs',
  'retrieve',
  'bash',
] as const;
export type FactoryKnownTool = (typeof FACTORY_KNOWN_TOOLS)[number];

export const FACTORY_CONTEXT_SOURCES = [
  'issue',
  'repository-instructions',
  'retrieval',
  'repository-instincts',
  'approved-plan',
  'repository-context',
  'workspace',
  'verification-commands',
  'acceptance-criteria',
  'diff',
  'verification-evidence',
  'structured-implementation',
  'structured-review',
] as const;
export type FactoryContextSource = (typeof FACTORY_CONTEXT_SOURCES)[number];

export const FORBIDDEN_CONTEXT_SOURCES = [
  'implementer-scratch',
  'chain-of-thought',
  'conversation',
  'workspace-scratch',
  'raw-transcript',
] as const;

export const FACTORY_GITHUB_ACTIONS = ['create-draft-pr', 'comment'] as const;
export type FactoryGitHubAction = (typeof FACTORY_GITHUB_ACTIONS)[number];

export const FORBIDDEN_GITHUB_ACTIONS = [
  'merge',
  'approve',
  'deploy',
  'expand-credentials',
  'production-mutation',
] as const;

export type RepositoryCapability = {
  read: boolean;
  write: boolean;
  allowedPaths?: string[];
};

export type ShellCapability = {
  enabled: boolean;
  mode?: 'read-only' | 'bounded-write';
  allowedCommands?: string[];
};

export type GitCapability = {
  read: boolean;
  write: boolean;
  allowedBranchPatterns: string[];
};

export type GitHubCapability = {
  allowedActions: string[];
};

export type NetworkCapability = {
  mode: 'deny' | 'allowlist';
  hosts: string[];
};

export type StageCapabilityManifest = {
  stage: FactoryStage;
  policyVersion: string;
  repository: RepositoryCapability;
  shell: ShellCapability;
  git: GitCapability;
  github: GitHubCapability;
  network: NetworkCapability;
  tools: string[];
  contextSources: string[];
};

export type FactoryCapabilityAudit = {
  policyVersion: string;
  stages: Partial<Record<FactoryStage, StageCapabilityManifest>>;
};

export type StageCapabilityOverlay = {
  repository?: Partial<RepositoryCapability>;
  shell?: Partial<ShellCapability>;
  git?: Partial<GitCapability>;
  github?: Partial<GitHubCapability>;
  network?: Partial<NetworkCapability>;
  tools?: string[];
  contextSources?: string[];
};

export type FactoryCapabilityPolicy = {
  version: string;
  stages?: Partial<Record<FactoryStage, StageCapabilityOverlay>>;
};

export class CapabilityDeniedError extends Error {
  readonly category = 'capability-denied';

  constructor(
    readonly stage: FactoryStage | 'unknown',
    readonly capability: string,
    readonly reason: string,
  ) {
    super(`Capability denied for ${stage}: ${capability}. ${reason}`);
    this.name = 'CapabilityDeniedError';
  }
}

const denyNetwork: NetworkCapability = { mode: 'deny', hosts: [] };

const STAGE_PROFILES: Record<FactoryStage, Omit<StageCapabilityManifest, 'policyVersion'>> = {
  classifier: {
    stage: 'classifier',
    repository: { read: true, write: false },
    shell: { enabled: false },
    git: { read: false, write: false, allowedBranchPatterns: [] },
    github: { allowedActions: [] },
    network: denyNetwork,
    tools: [],
    contextSources: ['issue'],
  },
  planner: {
    stage: 'planner',
    repository: { read: true, write: false },
    shell: { enabled: true, mode: 'read-only' },
    git: { read: true, write: false, allowedBranchPatterns: [] },
    github: { allowedActions: [] },
    network: denyNetwork,
    tools: ['list_files', 'read_file', 'search_code', 'search_docs', 'retrieve'],
    contextSources: ['issue', 'repository-instructions', 'retrieval', 'repository-instincts'],
  },
  implementer: {
    stage: 'implementer',
    repository: { read: true, write: true },
    shell: { enabled: true, mode: 'bounded-write' },
    git: { read: true, write: true, allowedBranchPatterns: ['factory/*'] },
    github: { allowedActions: [] },
    network: denyNetwork,
    tools: ['list_files', 'read_file', 'write_file', 'search_code', 'bash'],
    contextSources: ['issue', 'approved-plan', 'repository-context', 'repository-instincts'],
  },
  verifier: {
    stage: 'verifier',
    repository: { read: true, write: false },
    shell: { enabled: true, mode: 'bounded-write' },
    git: { read: true, write: false, allowedBranchPatterns: [] },
    github: { allowedActions: [] },
    network: denyNetwork,
    tools: ['bash'],
    contextSources: ['workspace', 'verification-commands'],
  },
  reviewer: {
    stage: 'reviewer',
    repository: { read: true, write: false },
    shell: { enabled: true, mode: 'read-only' },
    git: { read: true, write: false, allowedBranchPatterns: [] },
    github: { allowedActions: [] },
    network: denyNetwork,
    tools: ['list_files', 'read_file', 'search_code'],
    contextSources: [
      'issue',
      'acceptance-criteria',
      'diff',
      'verification-evidence',
      'repository-instincts',
    ],
  },
  publisher: {
    stage: 'publisher',
    repository: { read: false, write: false },
    shell: { enabled: false },
    git: { read: false, write: false, allowedBranchPatterns: [] },
    github: { allowedActions: ['create-draft-pr', 'comment'] },
    network: { mode: 'allowlist', hosts: ['api.github.com'] },
    tools: [],
    contextSources: ['structured-implementation', 'structured-review'],
  },
};

const shellModeSchema = v.picklist(['read-only', 'bounded-write'] as const);
const networkModeSchema = v.picklist(['deny', 'allowlist'] as const);

const overlaySchema = v.object({
  repository: v.optional(
    v.object({
      read: v.optional(v.boolean()),
      write: v.optional(v.boolean()),
      allowedPaths: v.optional(v.array(v.string())),
    }),
  ),
  shell: v.optional(
    v.object({
      enabled: v.optional(v.boolean()),
      mode: v.optional(shellModeSchema),
      allowedCommands: v.optional(v.array(v.string())),
    }),
  ),
  git: v.optional(
    v.object({
      read: v.optional(v.boolean()),
      write: v.optional(v.boolean()),
      allowedBranchPatterns: v.optional(v.array(v.string())),
    }),
  ),
  github: v.optional(
    v.object({
      allowedActions: v.optional(v.array(v.string())),
    }),
  ),
  network: v.optional(
    v.object({
      mode: v.optional(networkModeSchema),
      hosts: v.optional(v.array(v.string())),
    }),
  ),
  tools: v.optional(v.array(v.string())),
  contextSources: v.optional(v.array(v.string())),
});

export const factoryCapabilityPolicySchema = v.object({
  version: v.pipe(v.string(), v.minLength(1)),
  stages: v.optional(
    v.object({
      classifier: v.optional(overlaySchema),
      planner: v.optional(overlaySchema),
      implementer: v.optional(overlaySchema),
      verifier: v.optional(overlaySchema),
      reviewer: v.optional(overlaySchema),
      publisher: v.optional(overlaySchema),
    }),
  ),
});

export function parseFactoryCapabilityPolicy(value: unknown): FactoryCapabilityPolicy {
  if (value && typeof value === 'object' && 'stages' in value) {
    const stages = (value as { stages?: unknown }).stages;
    if (stages && typeof stages === 'object' && !Array.isArray(stages)) {
      for (const stage of Object.keys(stages)) {
        if (!isFactoryStage(stage)) {
          throw new CapabilityDeniedError(
            'unknown',
            'stage',
            `Stage "${stage}" has no capability profile.`,
          );
        }
      }
    }
  }
  const parsed = v.parse(factoryCapabilityPolicySchema, value);
  for (const [stage, overlay] of Object.entries(parsed.stages ?? {})) {
    if (overlay) assertOverlayDoesNotGrantForbidden(stage as FactoryStage, overlay);
  }
  return parsed;
}

/** Built-in maximum profile for a stage. Unknown stages fail closed. */
export function builtinStageProfile(stage: string): StageCapabilityManifest {
  if (!isFactoryStage(stage)) {
    throw new CapabilityDeniedError(
      'unknown',
      'stage',
      `Stage "${stage}" has no capability profile.`,
    );
  }
  return freezeManifest({
    ...cloneProfile(STAGE_PROFILES[stage]),
    policyVersion: FACTORY_CAPABILITY_POLICY_VERSION,
  });
}

/**
 * Resolve the effective manifest for a stage. A policy file may only restrict the
 * built-in profile. Untrusted issue or repository text is never an input.
 */
export function resolveStageCapabilities(
  stage: string,
  policy?: FactoryCapabilityPolicy,
): StageCapabilityManifest {
  const builtin = builtinStageProfile(stage);
  if (!policy) return builtin;
  const parsed = parseFactoryCapabilityPolicy(policy);
  const overlay = parsed.stages?.[builtin.stage];
  const resolved = overlay ? intersectManifest(builtin, overlay, parsed.version) : builtin;
  return freezeManifest({ ...resolved, policyVersion: parsed.version });
}

export function resolveFactoryCapabilityAudit(
  policy?: FactoryCapabilityPolicy,
): FactoryCapabilityAudit {
  const stages = {} as Record<FactoryStage, StageCapabilityManifest>;
  for (const stage of FACTORY_STAGES) {
    stages[stage] = resolveStageCapabilities(stage, policy);
  }
  return {
    policyVersion: policy?.version ?? FACTORY_CAPABILITY_POLICY_VERSION,
    stages,
  };
}

/** Return the recorded manifest. Legacy runs without an audit use the built-in maximum. */
export function stageCapabilitiesFromAudit(
  audit: FactoryCapabilityAudit | undefined,
  stage: FactoryStage,
): StageCapabilityManifest {
  return audit?.stages[stage] ?? builtinStageProfile(stage);
}

export function isFactoryStage(value: string): value is FactoryStage {
  return (FACTORY_STAGES as readonly string[]).includes(value);
}

export function isForbiddenGitHubAction(action: string): boolean {
  return (FORBIDDEN_GITHUB_ACTIONS as readonly string[]).includes(action);
}

export function isForbiddenContextSource(source: string): boolean {
  return (FORBIDDEN_CONTEXT_SOURCES as readonly string[]).includes(source);
}

export function branchMatchesPatterns(patterns: string[], branch: string): boolean {
  return patterns.some((pattern) => matchesGlob(pattern, branch));
}

function assertOverlayDoesNotGrantForbidden(
  stage: FactoryStage,
  overlay: StageCapabilityOverlay,
): void {
  for (const action of overlay.github?.allowedActions ?? []) {
    if (isForbiddenGitHubAction(action)) {
      throw new CapabilityDeniedError(
        stage,
        `github.${action}`,
        'Factory capability policy cannot grant merge, approval, deployment, or credential expansion.',
      );
    }
  }
  for (const source of overlay.contextSources ?? []) {
    if (isForbiddenContextSource(source)) {
      throw new CapabilityDeniedError(
        stage,
        `context.${source}`,
        'Factory capability policy cannot grant implementer scratch or chain-of-thought context.',
      );
    }
  }
}

function intersectManifest(
  builtin: StageCapabilityManifest,
  overlay: StageCapabilityOverlay,
  policyVersion: string,
): StageCapabilityManifest {
  const repository = {
    read: builtin.repository.read && (overlay.repository?.read ?? true),
    write: builtin.repository.write && (overlay.repository?.write ?? true),
    allowedPaths: intersectOptional(
      builtin.repository.allowedPaths,
      overlay.repository?.allowedPaths,
    ),
  };
  const shellEnabled = builtin.shell.enabled && (overlay.shell?.enabled ?? true);
  const shellMode =
    builtin.shell.mode === 'read-only' || overlay.shell?.mode === 'read-only'
      ? 'read-only'
      : (overlay.shell?.mode ?? builtin.shell.mode);
  const shell: ShellCapability = {
    enabled: shellEnabled,
    ...(shellEnabled && shellMode ? { mode: shellMode } : {}),
    allowedCommands: intersectOptional(
      builtin.shell.allowedCommands,
      overlay.shell?.allowedCommands,
    ),
  };
  const git = {
    read: builtin.git.read && (overlay.git?.read ?? true),
    write: builtin.git.write && (overlay.git?.write ?? true),
    allowedBranchPatterns: intersectLists(
      builtin.git.allowedBranchPatterns,
      overlay.git?.allowedBranchPatterns,
    ),
  };
  const github = {
    allowedActions: intersectLists(
      builtin.github.allowedActions,
      overlay.github?.allowedActions,
    ).filter((action) => !isForbiddenGitHubAction(action)),
  };
  const network = intersectNetwork(builtin.network, overlay.network);
  return {
    stage: builtin.stage,
    policyVersion,
    repository,
    shell,
    git,
    github,
    network,
    tools: intersectLists(builtin.tools, overlay.tools),
    contextSources: intersectLists(builtin.contextSources, overlay.contextSources).filter(
      (source) => !isForbiddenContextSource(source),
    ),
  };
}

function intersectNetwork(
  builtin: NetworkCapability,
  overlay: Partial<NetworkCapability> | undefined,
): NetworkCapability {
  if (!overlay) return { mode: builtin.mode, hosts: [...builtin.hosts] };
  if (builtin.mode === 'deny' || overlay.mode === 'deny') {
    return { mode: 'deny', hosts: [] };
  }
  return {
    mode: 'allowlist',
    hosts: overlay.hosts ? intersectLists(builtin.hosts, overlay.hosts) : [...builtin.hosts],
  };
}

function intersectLists(base: string[], overlay: string[] | undefined): string[] {
  if (!overlay) return [...base];
  const allowed = new Set(base);
  return overlay.filter((item) => allowed.has(item));
}

function intersectOptional(
  base: string[] | undefined,
  overlay: string[] | undefined,
): string[] | undefined {
  if (!base && !overlay) return undefined;
  if (!base) return overlay ? [...overlay] : undefined;
  return intersectLists(base, overlay);
}

function cloneProfile(
  profile: Omit<StageCapabilityManifest, 'policyVersion'>,
): Omit<StageCapabilityManifest, 'policyVersion'> {
  return {
    ...profile,
    repository: { ...profile.repository, allowedPaths: profile.repository.allowedPaths?.slice() },
    shell: { ...profile.shell, allowedCommands: profile.shell.allowedCommands?.slice() },
    git: { ...profile.git, allowedBranchPatterns: [...profile.git.allowedBranchPatterns] },
    github: { allowedActions: [...profile.github.allowedActions] },
    network: { ...profile.network, hosts: [...profile.network.hosts] },
    tools: [...profile.tools],
    contextSources: [...profile.contextSources],
  };
}

function freezeManifest(manifest: StageCapabilityManifest): StageCapabilityManifest {
  assertNoForbiddenGrants(manifest);
  return manifest;
}

function assertNoForbiddenGrants(manifest: StageCapabilityManifest): void {
  if (manifest.github.allowedActions.some((action) => isForbiddenGitHubAction(action))) {
    throw new CapabilityDeniedError(
      manifest.stage,
      'github',
      'Resolved profile grants a forbidden GitHub action.',
    );
  }
  if (manifest.contextSources.some((source) => isForbiddenContextSource(source))) {
    throw new CapabilityDeniedError(
      manifest.stage,
      'context',
      'Resolved profile grants a forbidden context source.',
    );
  }
  if (manifest.repository.write && manifest.stage !== 'implementer') {
    throw new CapabilityDeniedError(
      manifest.stage,
      'repository.write',
      'Only the implementer may write repository files.',
    );
  }
  if (manifest.git.write && manifest.stage !== 'implementer') {
    throw new CapabilityDeniedError(
      manifest.stage,
      'git.write',
      'Only the implementer may mutate factory-owned git state.',
    );
  }
}

function matchesGlob(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  if (!pattern.includes('*')) return false;
  const escaped = pattern.replaceAll(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(value);
}
