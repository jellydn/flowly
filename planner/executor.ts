import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type { DebugLogger, StepBudget } from '../tools/repository.ts';
import { summarizeInput } from '../tools/repository.ts';
import type { ToolRegistry } from '../investigation/tool-call.ts';
import { replacePlan } from './plan-store.ts';
import type { PlanStore } from './plan-store.ts';
import { PLAN_TOOL_NAMES } from '../tools/contracts.ts';
import { createPlanRun, normalizePlan } from './plan-run.ts';

export { isEmptyResult } from './plan-run.ts';
import type { ExecutionResult, Plan } from './types.ts';

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
  const run = createPlanRun();
  run.setPlan(plan);
  return run.execute(tools, signal);
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
  const run = createPlanRun();
  run.setPlan(originalPlan);
  return run.replan(results);
}

// ---------------------------------------------------------------------------
// Model-facing replan tool
// ---------------------------------------------------------------------------

const planStepSchema = v.object({
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  tool: v.picklist(PLAN_TOOL_NAMES),
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
      replacePlan(store, revised);
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
