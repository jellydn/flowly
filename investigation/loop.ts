import type { ToolDefinition } from '@flue/runtime';
import { runExecutionLoop, type ExecutionLoopAdapter, type ToolRegistry } from './tool-call.ts';
import type { StepBudget } from '../tools/repository.ts';
import type {
  DecisionFn,
  InvestigationAction,
  InvestigationResult,
  InvestigationState,
} from './types.ts';
import { createCallTracker } from './call-tracker.ts';
import { createEvidenceCollector, extractEvidence, type EvidenceCollector } from './evidence.ts';
import { formatAnswer } from './answer.ts';

export const DEFAULT_MAX_ITERATIONS = 5;
const INSPECTION_BUDGET_EXHAUSTED = 'Inspection budget exhausted';

export type InvestigationOptions = {
  maxIterations?: number;
  signal?: AbortSignal;
};

/**
 * Run a bounded investigation loop.
 *
 * 1. Ask the {@link DecisionFn} for the next action (call a tool or stop).
 * 2. Block duplicate tool+input calls.
 * 3. Execute the tool, extract evidence, and record errors.
 * 4. Repeat until the decider says stop, the budget is exhausted, or
 *    {@link maxIterations} is reached.
 *
 * The loop is deterministic and testable: pass a mock {@link DecisionFn} to
 * simulate any tool sequence without an LLM. Failed tool calls become error
 * entries— they never crash the loop.
 */
export async function runInvestigation(
  question: string,
  tools: ToolRegistry,
  budget: StepBudget,
  decide: DecisionFn,
  options: InvestigationOptions = {},
): Promise<InvestigationResult> {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const collector = createEvidenceCollector();
  const tracker = createCallTracker();
  const errors: string[] = [];
  const toolsUsed: string[] = [];
  let budgetRejected = false;
  const adapter: ExecutionLoopAdapter<InvestigationResult> = {
    async next(iteration) {
      const state: InvestigationState = {
        question,
        iteration,
        maxIterations,
        evidence: collector.items,
        budget: budget.snapshot(),
        errors: [...errors],
        callHistory: tracker.history,
      };

      let action: InvestigationAction;
      try {
        action = await decide(state);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        errors.push(
          `Decision function failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { type: 'stop', reason: 'decision error' };
      }

      if (action.type === 'stop') {
        return action;
      }
      if (tracker.has(action.tool, action.input)) {
        return {
          type: 'skip',
          tool: action.tool,
          reason: `Duplicate call blocked: ${action.tool} with identical arguments`,
        };
      }
      return {
        type: 'call',
        tool: action.tool,
        input: action.input,
        toolCallId: `investigation-${iteration}-${action.tool}`,
        preflight: () => {
          budgetRejected = budget.remaining <= 0;
          return budgetRejected ? INSPECTION_BUDGET_EXHAUSTED : undefined;
        },
        onResolved: () => {
          tracker.record({
            tool: action.tool,
            input: action.input,
            timestamp: Date.now(),
          });
          if (!toolsUsed.includes(action.tool)) toolsUsed.push(action.tool);
        },
      };
    },
    onSkip(action) {
      errors.push(action.reason);
    },
    onResult(action, call) {
      if (!call.ok) {
        errors.push(call.error);
        const stopReason = budgetRejected ? 'budget exhausted' : undefined;
        budgetRejected = false;
        return stopReason;
      }
      extractEvidence(action.tool, call.output, collector);
      return undefined;
    },
    finish(reason, iterations) {
      const answer = formatAnswer(question, collector.items, toolsUsed, errors);
      return {
        answer,
        iterations,
        evidence: collector.items,
        errors,
        toolsUsed,
        stopReason: reason,
        callHistory: tracker.history,
      };
    },
  };

  return runExecutionLoop(tools, adapter, {
    maxIterations,
    signal: options.signal,
  });
}

/** Convenience: build a tools map from a record of tool definitions. */
export function buildToolMap(
  ...toolLists: Array<Record<string, ToolDefinition>>
): Map<string, ToolDefinition> {
  const map = new Map<string, ToolDefinition>();
  for (const list of toolLists) {
    for (const [name, tool] of Object.entries(list)) {
      map.set(name, tool);
    }
  }
  return map;
}

/** Export collector type for external use. */
export type { EvidenceCollector };
