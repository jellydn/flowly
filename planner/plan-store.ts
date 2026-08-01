import { createPlanRun, type PlanRun } from './plan-run.ts';
import type { ExecutionResult, Plan, PlanReflection } from './types.ts';

const currentResultsByStore = new WeakMap<object, { baselineLength: number }>();

/**
 * Compatibility surface for planner tools. The concrete implementation is the
 * deeper {@link PlanRun}; keeping this interface narrow preserves callers that
 * provide their own plan store.
 */
export type PlanStore = {
  readonly plan: Plan | undefined;
  readonly results: ExecutionResult[];
  readonly currentResults?: ExecutionResult[];
  readonly reflection: PlanReflection | undefined;
  setPlan(plan: Plan): void;
  /** Replace a plan without discarding results from the preceding run. */
  replacePlan?(plan: Plan): void;
  addResult(result: ExecutionResult): void;
  setReflection(reflection: PlanReflection): void;
  clear(): void;
};

export function createPlanStore(): PlanRun {
  return createPlanRun();
}

export function currentPlanResults(store: PlanStore): ExecutionResult[] {
  if (store.currentResults) return store.currentResults;
  const state = currentResultsByStore.get(store);
  return state ? store.results.slice(state.baselineLength) : store.results;
}

/** Mark the current result length as the start of a newly recorded plan. */
export function startPlan(store: PlanStore): void {
  currentResultsByStore.set(store, { baselineLength: store.results.length });
}

export function replacePlan(store: PlanStore, plan: Plan): void {
  const previousResults = [...store.results];
  if (store.replacePlan) {
    store.replacePlan(plan);
    currentResultsByStore.set(store, { baselineLength: previousResults.length });
    return;
  }

  // Preserve the old interface's results when adapting a legacy store. Its
  // setPlan method resets state by contract, so restore the history explicitly.
  store.setPlan(plan);
  currentResultsByStore.set(store, { baselineLength: previousResults.length });
  for (const result of previousResults) store.addResult(result);
}
