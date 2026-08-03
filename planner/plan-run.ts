import {
  runExecutionLoop,
  type ExecutionLoopAdapter,
  type ToolRegistry,
} from '../investigation/tool-call.ts';
import type {
  ExecutionResult,
  ExecutionStatus,
  Plan,
  PlanReflection,
  PlanStepInput,
  PlanTool,
} from './types.ts';

export type PlanRun = {
  readonly plan: Plan | undefined;
  readonly results: ExecutionResult[];
  /** Results belonging to the current plan version, excluding prior replans. */
  readonly currentResults: ExecutionResult[];
  readonly reflection: PlanReflection | undefined;
  setPlan(plan: Plan): void;
  replacePlan(plan: Plan): void;
  addResult(result: ExecutionResult): void;
  setReflection(reflection: PlanReflection): void;
  execute(tools: ToolRegistry, signal?: AbortSignal): Promise<ExecutionResult[]>;
  replan(results?: ExecutionResult[]): Plan;
  reflect(couldSimplify: boolean, simplificationNote?: string): PlanReflection;
  clear(): void;
};

/**
 * Deep module for the plan lifecycle. It owns state transitions shared by
 * model-facing plan tools and deterministic execution tests.
 */
export function createPlanRun(): PlanRun {
  let plan: Plan | undefined;
  let results: ExecutionResult[] = [];
  let latestExecutionResults: ExecutionResult[] = [];
  let reflection: PlanReflection | undefined;

  const run: PlanRun = {
    get plan() {
      return plan;
    },
    get results() {
      return results;
    },
    get currentResults() {
      return latestExecutionResults;
    },
    get reflection() {
      return reflection;
    },
    setPlan(next) {
      plan = next;
      results = [];
      latestExecutionResults = [];
      reflection = undefined;
    },
    replacePlan(next) {
      plan = next;
      latestExecutionResults = [];
      reflection = undefined;
    },
    addResult(result) {
      results = [...results, result];
      latestExecutionResults = [...latestExecutionResults, result];
    },
    setReflection(next) {
      reflection = next;
    },
    async execute(tools, signal) {
      if (!plan) return [];

      const executed: ExecutionResult[] = [];
      latestExecutionResults = [];
      const adapter: ExecutionLoopAdapter<ExecutionResult[], { stepId: number; tool: PlanTool }> = {
        next(iteration) {
          const step = plan?.steps[iteration];
          if (!step) return { type: 'stop', reason: 'completed' };
          if (step.tool === 'answer') {
            executed.push({
              stepId: step.id,
              status: 'success',
              tool: 'answer',
              summary: 'Final answer step (no tool call needed)',
            });
            return { type: 'stop', reason: 'completed' };
          }
          if (!step.input || Object.keys(step.input).length === 0) {
            return {
              type: 'skip',
              tool: step.tool,
              metadata: { stepId: step.id, tool: step.tool },
              reason: 'No concrete input; skipped in programmatic execution',
            };
          }
          return {
            type: 'call',
            tool: step.tool,
            input: step.input,
            toolCallId: `exec-${step.id}`,
            metadata: { stepId: step.id, tool: step.tool },
          };
        },
        onSkip(action) {
          executed.push({
            stepId: action.metadata.stepId,
            status: 'skipped',
            tool: action.metadata.tool,
            summary: action.reason,
          });
        },
        onResult(action, call) {
          const { stepId, tool } = action.metadata;
          if (!call.ok) {
            executed.push({
              stepId,
              status: 'error',
              tool,
              summary: call.error,
            });
            return;
          }
          const output = call.output;
          const status: ExecutionStatus = isEmptyResult(tool, output) ? 'empty' : 'success';
          executed.push({
            stepId,
            status,
            tool,
            summary: summarizeResult(tool, output),
            output,
          });
        },
        finish() {
          return executed;
        },
      };

      try {
        const completed = await runExecutionLoop(tools, adapter, {
          maxIterations: plan.steps.length,
          signal,
        });
        latestExecutionResults = completed;
        results = [...results, ...completed];
        return completed;
      } catch (error) {
        latestExecutionResults = executed;
        results = [...results, ...executed];
        throw error;
      }
    },
    replan(executed = latestExecutionResults) {
      if (!plan) {
        throw new Error('Cannot replan before a plan is recorded.');
      }

      const remainingSteps = plan.steps.slice(executed.length);
      const newSteps: PlanStepInput[] = [];
      for (const result of executed) {
        if (result.status === 'empty') {
          newSteps.push({
            description: `List repository structure (replanned after empty ${result.tool})`,
            tool: 'list_files',
            input: { path: '.', depth: 2 },
          });
        }
      }
      for (const step of remainingSteps) {
        if (step.tool !== 'answer') {
          newSteps.push({
            description: step.description,
            tool: step.tool,
            input: step.input,
          });
        }
      }
      newSteps.push({
        description: 'Generate the final answer with the evidence collected',
        tool: 'answer',
      });

      const revised = normalizePlan(plan.question, newSteps);
      run.replacePlan(revised);
      return revised;
    },
    reflect(couldSimplify, simplificationNote = '') {
      if (!plan) {
        throw new Error('Cannot reflect before a plan is recorded.');
      }
      const next = createPlanReflection(
        plan,
        latestExecutionResults,
        couldSimplify,
        simplificationNote,
      );
      run.setReflection(next);
      return next;
    },
    clear() {
      plan = undefined;
      results = [];
      latestExecutionResults = [];
      reflection = undefined;
    },
  };

  return run;
}

export function normalizePlan(question: string, stepInputs: PlanStepInput[]): Plan {
  return {
    question,
    steps: stepInputs.map((step, index) => ({ ...step, id: index + 1 })),
    createdAt: Date.now(),
  };
}

export function createPlanReflection(
  plan: Plan,
  results: ExecutionResult[],
  couldSimplify: boolean,
  simplificationNote = '',
): PlanReflection {
  return {
    totalSteps: plan.steps.length,
    executedSteps: results.length,
    successfulSteps: results.filter((result) => result.status === 'success').length,
    emptyResults: results.filter((result) => result.status === 'empty').length,
    failedSteps: results.filter((result) => result.status === 'error').length,
    skippedSteps: results.filter((result) => result.status === 'skipped').length,
    couldSimplify,
    simplificationNote,
  };
}

export function isEmptyResult(tool: PlanTool, output: unknown): boolean {
  if (tool === 'search_code' || tool === 'search_docs') {
    const matches = (output as { matches?: unknown[] })?.matches;
    return Array.isArray(matches) && matches.length === 0;
  }
  if (tool === 'list_files') {
    const entries = (output as { entries?: unknown[] })?.entries;
    return Array.isArray(entries) && entries.length === 0;
  }
  if (tool === 'retrieve') {
    const results = (output as { results?: unknown[] })?.results;
    return Array.isArray(results) && results.length === 0;
  }
  return false;
}

function summarizeResult(tool: PlanTool, output: unknown): string {
  if (tool === 'search_code' || tool === 'search_docs') {
    const matches = (output as { matches?: unknown[] })?.matches;
    return `${Array.isArray(matches) ? matches.length : 0} matches`;
  }
  if (tool === 'list_files') {
    const entries = (output as { entries?: unknown[] })?.entries;
    return `${Array.isArray(entries) ? entries.length : 0} entries`;
  }
  if (tool === 'read_file') {
    const total = (output as { totalLines?: number })?.totalLines;
    return total !== undefined ? `${total} lines read` : 'file read';
  }
  if (tool === 'retrieve') {
    const results = (output as { results?: unknown[] })?.results;
    return `${Array.isArray(results) ? results.length : 0} chunks retrieved`;
  }
  return 'done';
}
