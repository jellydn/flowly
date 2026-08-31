/** Canonical names for the repository inspection tools exposed to the agent. */
export const INSPECTION_TOOL_NAMES = [
  'list_files',
  'read_file',
  'search_code',
  'search_docs',
  'retrieve',
  'related_context',
] as const;

export type InspectionTool = (typeof INSPECTION_TOOL_NAMES)[number];

/** All tools a plan may target, including the terminal answer step. */
export const PLAN_TOOL_NAMES = [...INSPECTION_TOOL_NAMES, 'answer'] as const;
export type PlanTool = (typeof PLAN_TOOL_NAMES)[number];

/** Shared hard limits for repository inspection tool inputs and outputs. */
export const TOOL_LIMITS = {
  maxPathLength: 500,
  maxQueryLength: 200,
  maxDepth: 5,
  maxFileBytes: 1_000_000,
  maxWalkFiles: 10_000,
  maxReturnedEntries: 500,
  maxReturnedLines: 400,
  maxSearchMatches: 50,
  maxSearchExcerptLength: 300,
  maxEvidenceItems: 30,
  maxEvidenceExcerptLength: 500,
} as const;
