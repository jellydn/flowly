import type { ToolDefinition } from '@flue/runtime';
import { executeToolCall, type ToolRegistry } from './tool-call.ts';
import type { StepBudget } from '../tools/repository.ts';
import type {
  DecisionFn,
  InvestigationAction,
  InvestigationResult,
  InvestigationState,
} from './types.ts';
import { createCallTracker } from './call-tracker.ts';
import {
  createEvidenceCollector,
  extractEvidence,
  type EvidenceCollector,
} from './evidence.ts';
import { formatAnswer } from './answer.ts';

export const DEFAULT_MAX_ITERATIONS = 5;

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
  let iteration = 0;
  let stopReason = '';

  while (iteration < maxIterations) {
    options.signal?.throwIfAborted();
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
      options.signal?.throwIfAborted();
    } catch (error) {
      if (options.signal?.aborted) throw error;
      errors.push(
        `Decision function failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      stopReason = 'decision error';
      break;
    }

    if (action.type === 'stop') {
      stopReason = action.reason;
      break;
    }

    // Block duplicate calls
    if (tracker.has(action.tool, action.input)) {
      errors.push(
        `Duplicate call blocked: ${action.tool} with identical arguments`,
      );
      iteration += 1;
      continue;
    }

    // Resolve the tool before applying budget policy. The shared call seam
    // owns lookup; its preflight hook keeps quota policy ahead of invocation.
    const call = await executeToolCall(
      tools,
      action.tool,
      action.input,
      `investigation-${action.tool}-${Date.now()}`,
      options.signal,
      () => budget.remaining <= 0 ? 'Inspection budget exhausted' : undefined,
      () => {
        tracker.record({
          tool: action.tool,
          input: action.input,
          timestamp: Date.now(),
        });
        if (!toolsUsed.includes(action.tool)) toolsUsed.push(action.tool);
      },
    );
    if (!call.ok && call.error === 'Inspection budget exhausted') {
      errors.push(call.error);
      stopReason = 'budget exhausted';
      break;
    }

    if (!call.ok) {
      errors.push(call.error);
    } else {
      extractEvidence(action.tool, call.output, collector);
    }

    iteration += 1;
  }

  if (!stopReason) {
    stopReason =
      iteration >= maxIterations ? 'max iterations reached' : 'completed';
  }

  const answer = formatAnswer(question, collector.items, toolsUsed, errors);

  return {
    answer,
    iterations: iteration,
    evidence: collector.items,
    errors,
    toolsUsed,
    stopReason,
    callHistory: tracker.history,
  };
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
