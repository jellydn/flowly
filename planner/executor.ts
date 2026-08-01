import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type { DebugLogger, StepBudget } from '../tools/repository.ts';
import { summarizeInput } from '../tools/repository.ts';
import {
  runExecutionLoop,
  type ExecutionLoopAdapter,
  type ToolRegistry,
} from '../investigation/tool-call.ts';
import type { PlanStore } from './plan-store.ts';
import { normalizePlan } from './planner.ts';
import type {
  ExecutionResult,
  ExecutionStatus,
  Plan,
  PlanStepInput,
  PlanTool,
} from './types.ts';

/**
 * Programmatic executor: run each plan step against the matching tool.
 *
 * Steps with `tool: 'answer'` are terminal and produce no tool call.
 * Steps without concrete `input` are marked `skipped` (the model fills in
 * inputs during live execution; the programmatic executor can only run steps
 * whose inputs are known at planning time).
 */
export async function executePlan(
  plan: Plan,
  tools: ToolRegistry,
  signal?: AbortSignal,
): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];
  const adapter: ExecutionLoopAdapter<ExecutionResult[]> = {
    next(iteration) {
      const step = plan.steps[iteration];
      if (!step) return { type: 'stop', reason: 'completed' };
      if (step.tool === 'answer') {
        results.push({
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
          stepId: step.id,
          reason: 'No concrete input; skipped in programmatic execution',
        };
      }
      return {
        type: 'call',
        tool: step.tool,
        input: step.input,
        toolCallId: `exec-${step.id}`,
        stepId: step.id,
      };
    },
    onSkip(action) {
      results.push({
        stepId: action.stepId ?? results.length + 1,
        status: 'skipped',
        tool: action.tool as PlanTool,
        summary: action.reason,
      });
    },
    onResult(action, call) {
      if (!call.ok) {
        results.push({
          stepId: action.stepId ?? Number(action.toolCallId.slice('exec-'.length)),
          status: 'error',
          tool: action.tool as PlanTool,
          summary: call.error,
        });
        return;
      }
      const output = call.output;
      const status: ExecutionStatus = isEmptyResult(action.tool as PlanTool, output)
        ? 'empty'
        : 'success';
      results.push({
        stepId: action.stepId ?? Number(action.toolCallId.slice('exec-'.length)),
        status,
        tool: action.tool as PlanTool,
        summary: summarizeResult(action.tool as PlanTool, output),
        output,
      });
    },
    finish() {
      return results;
    },
  };

  return runExecutionLoop(tools, adapter, {
    maxIterations: plan.steps.length,
    signal,
  });
}

/** Detect empty results for replanning decisions. */
export function isEmptyResult(tool: PlanTool, output: unknown): boolean {
  if (tool === 'search_code' || tool === 'search_docs') {
    const matches = (output as { matches?: unknown[] })?.matches;
    return Array.isArray(matches) && matches.length === 0;
  }
  if (tool === 'list_files') {
    const entries = (output as { entries?: unknown[] })?.entries;
    return Array.isArray(entries) && entries.length === 0;
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
  return 'done';
}

// ---------------------------------------------------------------------------
// Replanning (stretch goal)
// ---------------------------------------------------------------------------

/** True when any executed search or list step returned no evidence. */
export function shouldReplan(results: ExecutionResult[]): boolean {
  return results.some(
    (r) =>
      r.status === 'empty' &&
      (r.tool === 'search_code' ||
        r.tool === 'search_docs' ||
        r.tool === 'list_files'),
  );
}

/**
 * Produce a revised plan when a step returns no results.
 *
 * Strategy: replace the failed search with a `list_files` to discover
 * structure, then keep the remaining non-answer steps from the original plan.
 */
export function replan(
  originalPlan: Plan,
  results: ExecutionResult[],
): Plan {
  const executedCount = results.length;
  const remainingSteps = originalPlan.steps.slice(executedCount);
  const newSteps: PlanStepInput[] = [];

  // Keep successfully executed steps as context (not re-executed).
  for (const result of results) {
    if (result.status === 'empty') {
      newSteps.push({
        description: `List repository structure (replanned after empty ${result.tool})`,
        tool: 'list_files',
        input: { path: '.', depth: 2 },
      });
    }
  }

  // Carry forward remaining non-answer steps.
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

  return normalizePlan(originalPlan.question, newSteps);
}

// ---------------------------------------------------------------------------
// Model-facing replan tool
// ---------------------------------------------------------------------------

const planStepSchema = v.object({
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  tool: v.picklist(['list_files', 'read_file', 'search_code', 'search_docs', 'answer']),
  input: v.optional(v.record(v.string(), v.union([v.string(), v.number(), v.boolean(), v.null()]))),
});

export function createReplanTool(
  store: PlanStore,
  budget: StepBudget,
  debug: DebugLogger,
) {
  return defineTool({
    name: 'replan',
    description:
      'Revise the current plan when a step returns no useful results. Provide the reason and new steps. Previously executed steps are preserved in the results log. Does not consume the inspection budget.',
    input: v.object({
      reason: v.pipe(v.string(), v.minLength(1), v.maxLength(300)),
      steps: v.pipe(
        v.array(planStepSchema),
        v.minLength(1),
        v.maxLength(10),
      ),
    }),
    run({ data }) {
      const revised = normalizePlan(
        store.plan?.question ?? '(replanned)',
        data.steps,
      );
      const previousResults = store.results;
      store.setPlan(revised);
      const inspection = budget.snapshot();
      const inputSummary = summarizeInput({
        reason: data.reason,
        stepCount: data.steps.length,
      });
      debug.log({
        tool: 'replan',
        status: 'success',
        inputSummary,
        count: revised.steps.length,
        inspection,
      });
      return {
        output: {
          plan: revised,
          previousResultCount: previousResults.length,
          message: `Plan revised (${revised.steps.length} steps). Continue execution from the new first step.`,
          inspection,
        },
      };
    },
  });
}
