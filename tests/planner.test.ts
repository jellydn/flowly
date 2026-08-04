import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ToolDefinition } from '@flue/runtime';
import { runExecutionLoop } from '../investigation/tool-call.ts';
import type { ToolExecutionOutcome } from '../investigation/tool-execution.ts';
import { createPlanRun, executePlan, replan, shouldReplan } from '../planner/plan-run.ts';
import { createPlanStore, replacePlan as replaceStoredPlan } from '../planner/plan-store.ts';
import { createPlan, createPlanTool, createReplanTool, normalizePlan } from '../planner/planner.ts';
import { createReflectPlanTool, formatReflection, reflectOnPlan } from '../planner/reflection.ts';
import type { ExecutionResult, Plan, PlanReflection } from '../planner/types.ts';
import { createListFilesTool } from '../tools/list-files.ts';
import { createReadFileTool } from '../tools/read-file.ts';
import type { InspectionMetadata } from '../tools/repository.ts';
import {
  createDebugLogger,
  createRepositoryReader,
  createStepBudget,
} from '../tools/repository.ts';
import { createSearchCodeTool } from '../tools/search-code.ts';
import { withInspectionBudget } from '../reliability/resilient-tool.ts';
import { createSampleRepo, removeRepo, runTool } from './helpers.ts';

const noDebug = () => createDebugLogger(false);
let root: string;

before(async () => {
  root = await createSampleRepo();
});

after(async () => {
  await removeRepo(root);
});

// ---------------------------------------------------------------------------
// Programmatic planner
// ---------------------------------------------------------------------------

describe('createPlan (programmatic)', () => {
  test('conceptual question produces a single answer step', () => {
    const plan = createPlan('What is the difference between listing and searching?');
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].tool, 'answer');
  });

  test('specific file path produces a read then answer plan', () => {
    const plan = createPlan('Read src/config.ts and explain the port.');
    assert.equal(plan.steps.length, 2);
    assert.equal(plan.steps[0].tool, 'read_file');
    assert.equal(plan.steps[0].input?.path, 'src/config.ts');
    assert.equal(plan.steps[1].tool, 'answer');
  });

  test('overview question produces search_docs → list → read → answer', () => {
    const plan = createPlan('Give me a high-level overview of this repository.');
    assert.equal(plan.steps.length, 4);
    assert.equal(plan.steps[0].tool, 'search_docs');
    assert.equal(plan.steps[1].tool, 'list_files');
    assert.equal(plan.steps[2].tool, 'read_file');
    assert.equal(plan.steps[3].tool, 'answer');
  });

  test('default question produces search → read → read → answer', () => {
    const plan = createPlan('Find where user authentication is implemented.');
    assert.ok(plan.steps.length >= 3);
    assert.equal(plan.steps[0].tool, 'search_code');
    assert.equal(plan.steps[plan.steps.length - 1].tool, 'answer');
  });

  test('all steps have sequential ids', () => {
    const plan = createPlan('Find where auth is implemented.');
    const ids = plan.steps.map((s) => s.id);
    assert.deepEqual(
      ids,
      ids.map((_, i) => i + 1),
    );
  });
});

describe('normalizePlan', () => {
  test('assigns sequential ids and preserves step data', () => {
    const plan = normalizePlan('test question', [
      {
        description: 'step one',
        tool: 'search_code',
        input: { query: 'auth' },
      },
      { description: 'step two', tool: 'answer' },
    ]);
    assert.equal(plan.question, 'test question');
    assert.equal(plan.steps[0].id, 1);
    assert.equal(plan.steps[1].id, 2);
    assert.equal(plan.steps[0].description, 'step one');
    assert.equal(plan.steps[1].tool, 'answer');
  });
});

// ---------------------------------------------------------------------------
// Programmatic executor
// ---------------------------------------------------------------------------

describe('executePlan', () => {
  test('shared execution loop preserves adapter skips and stops', async () => {
    const skipped: string[] = [];
    const result = await runExecutionLoop(
      {},
      {
        next(iteration) {
          return iteration === 0
            ? { type: 'skip', tool: 'read_file', reason: 'input deferred' }
            : { type: 'stop', reason: 'adapter complete' };
        },
        onResult() {},
        onSkip(action) {
          skipped.push(action.reason);
        },
        finish(reason, iterations) {
          return { reason, iterations, skipped: skipped.length };
        },
      },
      { maxIterations: 3 },
    );
    assert.deepEqual(result, {
      reason: 'adapter complete',
      iterations: 1,
      skipped: 1,
    });
  });

  test('normalizes invocation failures through the shared result protocol', async () => {
    let observed: ToolExecutionOutcome | undefined;
    const result = await runExecutionLoop(
      {
        read_file: {
          name: 'read_file',
          description: 'test',
          input: undefined,
          output: undefined,
          async run() {
            throw new Error('tool failed');
          },
        },
      },
      {
        next() {
          return {
            type: 'call',
            tool: 'read_file',
            input: { path: 'missing.ts' },
            toolCallId: 'shared-error',
          };
        },
        onResult(_action, call) {
          observed = call;
          return 'done';
        },
        finish(reason, iterations) {
          return { reason, iterations };
        },
      },
      { maxIterations: 1 },
    );

    assert.deepEqual(result, { reason: 'done', iterations: 1 });
    assert.ok(observed);
    assert.equal(observed.ok, false);
    if (!observed.ok) {
      assert.equal(observed.tool, 'read_file');
      assert.equal(observed.error, 'tool failed');
    }
    assert.equal(observed.metadata.toolCallId, 'shared-error');
    assert.ok(observed.metadata.durationMs >= 0);
  });

  test('stops after adapter preflight rejects a call', async () => {
    let invoked = false;
    const result = await runExecutionLoop(
      {
        read_file: {
          name: 'read_file',
          description: 'test',
          input: undefined,
          output: undefined,
          async run() {
            invoked = true;
            return { output: {} };
          },
        },
      },
      {
        next() {
          return {
            type: 'call',
            tool: 'read_file',
            input: { path: 'src/auth.ts' },
            toolCallId: 'shared-budget',
            preflight: () => 'Inspection budget exhausted',
          };
        },
        onResult(_action, call) {
          assert.equal(call.ok, false);
          if (!call.ok) {
            assert.equal(call.tool, 'read_file');
            assert.equal(call.error, 'Inspection budget exhausted');
          }
          assert.equal(call.metadata.toolCallId, 'shared-budget');
          return 'budget exhausted';
        },
        finish(reason, iterations) {
          return { reason, iterations };
        },
      },
      { maxIterations: 3 },
    );

    assert.deepEqual(result, { reason: 'budget exhausted', iterations: 1 });
    assert.equal(invoked, false);
  });

  test('propagates cancellation from the shared invocation seam', async () => {
    const controller = new AbortController();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const tools: Partial<Record<string, ToolDefinition>> = {
      read_file: {
        name: 'read_file',
        description: 'test',
        input: undefined,
        output: undefined,
        async run({ signal }) {
          resolveStarted();
          await new Promise<void>((_, reject) => {
            const onAbort = () => {
              signal?.removeEventListener('abort', onAbort);
              reject(new Error('shared operation cancelled'));
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
          });
          return { output: {} };
        },
      },
    };

    const promise = runExecutionLoop(
      tools,
      {
        next() {
          return {
            type: 'call',
            tool: 'read_file',
            input: { path: 'src/auth.ts' },
            toolCallId: 'shared-cancel',
          };
        },
        onResult() {
          return undefined;
        },
        finish() {
          return undefined;
        },
      },
      { maxIterations: 1, signal: controller.signal },
    );
    await started;
    controller.abort(new Error('cancelled'));
    await assert.rejects(promise, /shared operation cancelled/);
  });

  test('finishes when the shared loop reaches max iterations', async () => {
    const result = await runExecutionLoop(
      {},
      {
        next() {
          return {
            type: 'call',
            tool: 'read_file',
            input: { path: 'src/auth.ts' },
            toolCallId: 'max-iterations',
          };
        },
        onResult() {
          return undefined;
        },
        finish(reason, iterations) {
          return { reason, iterations };
        },
      },
      { maxIterations: 2 },
    );

    assert.deepEqual(result, {
      reason: 'max iterations reached',
      iterations: 2,
    });
  });

  test('executes a search → read plan against the fixture repo', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const debug = noDebug();
    const tools: Partial<Record<string, ToolDefinition>> = {
      search_code: withInspectionBudget(createSearchCodeTool(repository), budget, debug),
      read_file: withInspectionBudget(createReadFileTool(repository), budget, debug),
    };
    const plan = normalizePlan('Find auth', [
      {
        description: 'Search for auth',
        tool: 'search_code',
        input: { query: 'login', path: '.', caseSensitive: false },
      },
      {
        description: 'Read auth file',
        tool: 'read_file',
        input: { path: 'src/auth.ts', startLine: 1 },
      },
      { description: 'Answer', tool: 'answer' },
    ]);
    const results = await executePlan(plan, tools);
    assert.equal(results.length, 3);
    assert.equal(results[0].status, 'success');
    assert.match(results[0].summary, /matches/);
    assert.equal(results[1].status, 'success');
    assert.match(results[1].summary, /lines read/);
    assert.equal(results[2].status, 'success');
    assert.equal(results[2].tool, 'answer');
    assert.equal(budget.used, 2);
  });

  test('skips steps without concrete input', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const tools: Partial<Record<string, ToolDefinition>> = {
      read_file: withInspectionBudget(createReadFileTool(repository), budget, noDebug()),
    };
    const plan = normalizePlan('Read a file', [
      { description: 'Read some file', tool: 'read_file' },
      { description: 'Answer', tool: 'answer' },
    ]);
    const results = await executePlan(plan, tools);
    assert.equal(results[0].status, 'skipped');
    assert.equal(results[1].status, 'success');
    assert.equal(budget.used, 0);
  });

  test('marks empty search results as empty', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const tools: Partial<Record<string, ToolDefinition>> = {
      search_code: withInspectionBudget(createSearchCodeTool(repository), budget, noDebug()),
    };
    const plan = normalizePlan('Find nonexistent', [
      {
        description: 'Search for nothing',
        tool: 'search_code',
        input: { query: 'doesnotexistxyz', path: '.', caseSensitive: false },
      },
      { description: 'Answer', tool: 'answer' },
    ]);
    const results = await executePlan(plan, tools);
    assert.equal(results[0].status, 'empty');
    assert.match(results[0].summary, /0 matches/);
  });

  test('answer step terminates execution and produces no tool call', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const tools: Partial<Record<string, ToolDefinition>> = {
      search_code: withInspectionBudget(createSearchCodeTool(repository), budget, noDebug()),
    };
    const plan = normalizePlan('conceptual', [
      { description: 'Answer directly', tool: 'answer' },
      {
        description: 'This should not run',
        tool: 'search_code',
        input: { query: 'x', path: '.', caseSensitive: false },
      },
    ]);
    const results = await executePlan(plan, tools);
    assert.equal(results.length, 1);
    assert.equal(results[0].tool, 'answer');
    assert.equal(budget.used, 0);
  });

  test('propagates cancellation from an in-flight tool call', async () => {
    const controller = new AbortController();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let releaseTool!: () => void;
    const toolReleased = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const tools: Partial<Record<string, ToolDefinition>> = {
      read_file: {
        name: 'read_file',
        description: 'test',
        input: undefined,
        output: undefined,
        async run() {
          resolveStarted();
          await toolReleased;
          return { output: {} };
        },
      },
    };
    const plan = normalizePlan('cancel', [
      {
        description: 'Read file',
        tool: 'read_file',
        input: { path: 'src/auth.ts', startLine: 1 },
      },
    ]);

    const promise = executePlan(plan, tools, controller.signal);
    await started;
    controller.abort(new Error('cancelled'));
    releaseTool();
    await assert.rejects(promise, /cancel/i);
  });
});

// ---------------------------------------------------------------------------
// Replanning
// ---------------------------------------------------------------------------

describe('replanning', () => {
  test('shouldReplan returns true when a search step is empty', () => {
    const results: ExecutionResult[] = [
      { stepId: 1, status: 'empty', tool: 'search_code', summary: '0 matches' },
    ];
    assert.equal(shouldReplan(results), true);
  });

  test('shouldReplan returns false when all steps succeed', () => {
    const results: ExecutionResult[] = [
      {
        stepId: 1,
        status: 'success',
        tool: 'search_code',
        summary: '3 matches',
      },
    ];
    assert.equal(shouldReplan(results), false);
  });

  test('replan replaces empty search with list_files', () => {
    const original = normalizePlan('Find X', [
      {
        description: 'Search for X',
        tool: 'search_code',
        input: { query: 'X', path: '.', caseSensitive: false },
      },
      { description: 'Read result', tool: 'read_file' },
      { description: 'Answer', tool: 'answer' },
    ]);
    const results: ExecutionResult[] = [
      { stepId: 1, status: 'empty', tool: 'search_code', summary: '0 matches' },
    ];
    const revised = replan(original, results);
    assert.equal(revised.steps[0].tool, 'list_files');
    assert.equal(revised.steps[revised.steps.length - 1].tool, 'answer');
    // Original read_file step is preserved
    assert.ok(revised.steps.some((s) => s.tool === 'read_file'));
  });

  test('replanned plan can execute successfully', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const debug = noDebug();
    const tools: Partial<Record<string, ToolDefinition>> = {
      search_code: withInspectionBudget(createSearchCodeTool(repository), budget, debug),
      list_files: withInspectionBudget(createListFilesTool(repository), budget, debug),
      read_file: withInspectionBudget(createReadFileTool(repository), budget, debug),
    };
    const original = normalizePlan('Find nonexistent', [
      {
        description: 'Search for nothing',
        tool: 'search_code',
        input: { query: 'doesnotexistxyz', path: '.', caseSensitive: false },
      },
      { description: 'Answer', tool: 'answer' },
    ]);
    const firstResults = await executePlan(original, tools);
    assert.equal(shouldReplan(firstResults), true);
    const revised = replan(original, firstResults);
    const revisedResults = await executePlan(revised, tools);
    assert.ok(revisedResults.some((r) => r.status === 'success'));
  });
});

// ---------------------------------------------------------------------------
// Reflection
// ---------------------------------------------------------------------------

describe('reflection', () => {
  test('reflectOnPlan counts statuses correctly', () => {
    const plan = normalizePlan('test', [
      { description: 'a', tool: 'search_code' },
      { description: 'b', tool: 'read_file' },
      { description: 'c', tool: 'answer' },
    ]);
    const results: ExecutionResult[] = [
      {
        stepId: 1,
        status: 'success',
        tool: 'search_code',
        summary: '3 matches',
      },
      { stepId: 2, status: 'empty', tool: 'read_file', summary: 'no file' },
    ];
    const reflection = reflectOnPlan(plan, results, true, 'Steps 1 and 2 could be merged');
    assert.equal(reflection.totalSteps, 3);
    assert.equal(reflection.executedSteps, 2);
    assert.equal(reflection.successfulSteps, 1);
    assert.equal(reflection.emptyResults, 1);
    assert.equal(reflection.couldSimplify, true);
    assert.equal(reflection.simplificationNote, 'Steps 1 and 2 could be merged');
  });

  test('formatReflection produces a readable summary', () => {
    const reflection = reflectOnPlan(
      normalizePlan('t', [{ description: 'a', tool: 'answer' }]),
      [{ stepId: 1, status: 'success', tool: 'search_code', summary: 'ok' }],
      false,
    );
    const text = formatReflection(reflection);
    assert.match(text, /1\/1 executed/);
    assert.match(text, /1 success/);
  });
});

// ---------------------------------------------------------------------------
// Plan store
// ---------------------------------------------------------------------------

describe('PlanRun', () => {
  test('preserves completed results when execution is aborted', async () => {
    const run = createPlanRun();
    const controller = new AbortController();
    let releaseSecond!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const plan = normalizePlan('abort', [
      { description: 'First', tool: 'search_code', input: { query: 'auth' } },
      {
        description: 'Second',
        tool: 'search_code',
        input: { query: 'config' },
      },
    ]);
    run.setPlan(plan);
    let calls = 0;
    const tools: Partial<Record<string, ToolDefinition>> = {
      search_code: {
        name: 'search_code',
        description: 'test',
        input: undefined,
        output: undefined,
        async run() {
          calls += 1;
          if (calls === 2) await secondStarted;
          return { output: { matches: [] } };
        },
      },
    };

    const execution = run.execute(tools, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error('cancelled'));
    releaseSecond();
    await assert.rejects(execution, /cancel/i);
    assert.equal(run.currentResults.length, 1);
    assert.equal(run.currentResults[0].status, 'empty');
  });

  test('owns execution results and preserves them while replacing a plan', async () => {
    const run = createPlanRun();
    const plan = normalizePlan('Find auth', [
      { description: 'Search', tool: 'search_code', input: { query: 'auth' } },
      { description: 'Answer', tool: 'answer' },
    ]);
    run.setPlan(plan);
    const results = await run.execute({
      search_code: {
        name: 'search_code',
        description: 'test',
        input: undefined,
        output: undefined,
        async run() {
          return { output: { matches: [{ file: 'src/auth.ts', line: 1 }] } };
        },
      },
    });
    assert.equal(results.length, 2);
    assert.equal(run.results.length, 2);

    const revised = run.replan(results);
    assert.equal(run.results.length, 2);
    assert.equal(run.currentResults.length, 0);
    assert.equal(run.plan, revised);
    assert.equal(run.reflection, undefined);

    const reflection = run.reflect(false);
    assert.equal(reflection.totalSteps, 1);
    assert.equal(reflection.executedSteps, 0);
  });
});

describe('PlanStore', () => {
  test('legacy replacePlan adapter preserves results', () => {
    const plan1 = normalizePlan('q1', [{ description: 'a', tool: 'answer' }]);
    const plan2 = normalizePlan('q2', [{ description: 'b', tool: 'answer' }]);
    const legacy = {
      plan: undefined as Plan | undefined,
      results: [] as ExecutionResult[],
      reflection: undefined as PlanReflection | undefined,
      setPlan(next: Plan) {
        this.plan = next;
        this.results = [];
        this.reflection = undefined;
      },
      addResult(result: ExecutionResult) {
        this.results = [...this.results, result];
      },
      setReflection(next: PlanReflection) {
        this.reflection = next;
      },
      clear() {
        this.plan = undefined;
        this.results = [];
        this.reflection = undefined;
      },
    };
    legacy.setPlan(plan1);
    const result = {
      stepId: 1,
      status: 'success' as const,
      tool: 'answer' as const,
      summary: 'ok',
    };
    legacy.addResult(result);
    replaceStoredPlan(legacy, plan2);
    assert.equal(legacy.plan?.question, 'q2');
    assert.deepEqual(legacy.results, [result]);
  });

  test('setPlan resets results and reflection', () => {
    const store = createPlanStore();
    const plan1 = normalizePlan('q1', [{ description: 'a', tool: 'answer' }]);
    store.setPlan(plan1);
    store.addResult({
      stepId: 1,
      status: 'success',
      tool: 'answer',
      summary: 'ok',
    });
    store.setReflection(reflectOnPlan(plan1, store.results, false));
    assert.equal(store.results.length, 1);
    assert.ok(store.reflection);

    const plan2 = normalizePlan('q2', [{ description: 'b', tool: 'answer' }]);
    store.setPlan(plan2);
    assert.equal(store.results.length, 0);
    assert.equal(store.reflection, undefined);
    assert.equal(store.plan?.question, 'q2');
  });
});

// ---------------------------------------------------------------------------
// Model-facing tools
// ---------------------------------------------------------------------------

describe('create_plan tool', () => {
  test('stores the plan and returns confirmation', async () => {
    const store = createPlanStore();
    const budget = createStepBudget(8);
    const tool = createPlanTool(store, budget, noDebug());
    const result = await runTool<{
      plan: Plan;
      message: string;
      inspection: InspectionMetadata;
    }>(tool, {
      question: 'How does auth work?',
      steps: [
        {
          description: 'Search for auth',
          tool: 'search_code',
          input: { query: 'auth' },
        },
        { description: 'Read the auth file', tool: 'read_file' },
        { description: 'Answer', tool: 'answer' },
      ],
    });
    assert.ok(store.plan);
    assert.equal(store.plan.question, 'How does auth work?');
    assert.equal(store.plan.steps.length, 3);
    assert.equal(result.plan.steps.length, 3);
    assert.match(result.message, /3 steps/);
    // Does not consume inspection budget
    assert.equal(budget.used, 0);
  });
});

describe('replan tool', () => {
  test('replaces the plan and preserves previous result count', async () => {
    const store = createPlanStore();
    const budget = createStepBudget(8);
    const planTool = createPlanTool(store, budget, noDebug());
    const replanTool = createReplanTool(store, budget, noDebug());

    await runTool(planTool, {
      question: 'Find X',
      steps: [
        {
          description: 'Search for X',
          tool: 'search_code',
          input: { query: 'X' },
        },
        { description: 'Answer', tool: 'answer' },
      ],
    });
    store.addResult({
      stepId: 1,
      status: 'empty',
      tool: 'search_code',
      summary: '0 matches',
    });

    const result = await runTool<{
      plan: Plan;
      previousResultCount: number;
      message: string;
      inspection: InspectionMetadata;
    }>(replanTool, {
      reason: 'Search returned no results',
      steps: [
        { description: 'List files', tool: 'list_files', input: { path: '.' } },
        { description: 'Answer', tool: 'answer' },
      ],
    });
    assert.equal(result.plan.steps.length, 2);
    assert.equal(result.plan.steps[0].tool, 'list_files');
    assert.equal(result.previousResultCount, 1);
    assert.equal(budget.used, 0);

    const reflectTool = createReflectPlanTool(store, budget, noDebug());
    const reflection = await runTool<{ reflection: PlanReflection }>(reflectTool, {
      couldSimplify: false,
      simplificationNote: '',
    });
    assert.equal(reflection.reflection.executedSteps, 0);
  });
});

describe('reflect_plan tool', () => {
  test('records reflection when a plan exists', async () => {
    const store = createPlanStore();
    const budget = createStepBudget(8);
    const planTool = createPlanTool(store, budget, noDebug());
    const reflectTool = createReflectPlanTool(store, budget, noDebug());

    await runTool(planTool, {
      question: 'Test',
      steps: [
        { description: 'Search', tool: 'search_code', input: { query: 'x' } },
        { description: 'Answer', tool: 'answer' },
      ],
    });
    store.addResult({
      stepId: 1,
      status: 'success',
      tool: 'search_code',
      summary: '2 matches',
    });

    const result = await runTool<{
      error: string | null;
      reflection: PlanReflection | null;
      summary: string;
      inspection: InspectionMetadata;
    }>(reflectTool, {
      couldSimplify: true,
      simplificationNote: 'Could merge steps',
    });
    assert.equal(result.error, null);
    assert.ok(result.reflection);
    assert.equal(result.reflection.totalSteps, 2);
    assert.equal(result.reflection.executedSteps, 1);
    assert.equal(result.reflection.couldSimplify, true);
    assert.ok(store.reflection);
    assert.equal(budget.used, 0);
  });

  test('returns error when no plan exists', async () => {
    const store = createPlanStore();
    const budget = createStepBudget(8);
    const reflectTool = createReflectPlanTool(store, budget, noDebug());
    const result = await runTool<{
      error: string | null;
      reflection: null;
      summary: string;
      inspection: InspectionMetadata;
    }>(reflectTool, { couldSimplify: false, simplificationNote: '' });
    assert.ok(result.error);
    assert.equal(result.reflection, null);
  });
});

// ---------------------------------------------------------------------------
// Integration: plan → execute → reflect
// ---------------------------------------------------------------------------

describe('full plan-execute-reflect cycle', () => {
  test('search → read → reflect against fixture repo', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const debug = noDebug();
    const store = createPlanStore();

    // Tools for execution
    const tools: Partial<Record<string, ToolDefinition>> = {
      search_code: withInspectionBudget(createSearchCodeTool(repository), budget, debug),
      read_file: withInspectionBudget(createReadFileTool(repository), budget, debug),
    };

    // Plan
    const planTool = createPlanTool(store, budget, debug);
    await runTool(planTool, {
      question: 'Find where user authentication is implemented and explain the flow.',
      steps: [
        {
          description: 'Search for auth code',
          tool: 'search_code',
          input: { query: 'login', path: '.', caseSensitive: false },
        },
        {
          description: 'Read the auth file',
          tool: 'read_file',
          input: { path: 'src/auth.ts', startLine: 1 },
        },
        { description: 'Answer', tool: 'answer' },
      ],
    });
    assert.ok(store.plan);

    // Execute
    const results = await store.execute(tools);
    assert.equal(budget.used, 2);
    assert.ok(results.some((r) => r.status === 'success'));

    // Reflect
    const reflectTool = createReflectPlanTool(store, budget, debug);
    const reflectResult = await runTool<{
      error: string | null;
      reflection: PlanReflection | null;
      summary: string;
      inspection: InspectionMetadata;
    }>(reflectTool, { couldSimplify: false, simplificationNote: '' });
    assert.equal(reflectResult.error, null);
    assert.equal(reflectResult.reflection?.executedSteps, 3);
    assert.equal(reflectResult.reflection?.successfulSteps, 3);
    assert.equal(reflectResult.reflection?.emptyResults, 0);
  });

  test('empty search triggers replan, then succeeds', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const debug = noDebug();
    const store = createPlanStore();

    const tools: Partial<Record<string, ToolDefinition>> = {
      search_code: withInspectionBudget(createSearchCodeTool(repository), budget, debug),
      list_files: withInspectionBudget(createListFilesTool(repository), budget, debug),
      read_file: withInspectionBudget(createReadFileTool(repository), budget, debug),
    };

    // Plan with a query that won't match
    const planTool = createPlanTool(store, budget, debug);
    await runTool(planTool, {
      question: 'Find payment processing.',
      steps: [
        {
          description: 'Search for payment',
          tool: 'search_code',
          input: {
            query: 'payment_processor',
            path: '.',
            caseSensitive: false,
          },
        },
        { description: 'Answer', tool: 'answer' },
      ],
    });

    // Execute
    const firstResults = await store.execute(tools);
    assert.equal(shouldReplan(firstResults), true);

    // Replan
    const replanTool = createReplanTool(store, budget, debug);
    await runTool(replanTool, {
      reason: 'No payment_processor matches; trying broader search',
      steps: [
        {
          description: 'Search for payment',
          tool: 'search_code',
          input: { query: 'payment', path: '.', caseSensitive: false },
        },
        {
          description: 'Read the matching file',
          tool: 'read_file',
          input: { path: 'src/utils/notes.md', startLine: 1 },
        },
        {
          description: 'Answer: no payment implementation found',
          tool: 'answer',
        },
      ],
    });

    // Execute revised plan
    const revisedResults = await executePlan(store.plan!, tools);
    assert.ok(revisedResults.some((r) => r.status === 'success'));
    assert.ok(budget.used > 0);
  });
});

// ---------------------------------------------------------------------------
// Debug logging for plan tools
// ---------------------------------------------------------------------------

describe('plan tool debug logging', () => {
  test('create_plan logs plan metadata without consuming budget', async () => {
    const store = createPlanStore();
    const budget = createStepBudget(8);
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => lines.push(args.join(' '));
    try {
      const tool = createPlanTool(store, budget, createDebugLogger(true));
      await runTool(tool, {
        question: 'Test',
        steps: [{ description: 'Answer', tool: 'answer' }],
      });
    } finally {
      console.error = original;
    }
    const line = lines.join('\n');
    assert.match(line, /create_plan success/);
    assert.match(line, /used=0 remaining=8\/8/);
    // No absolute paths
    assert.doesNotMatch(line, /\/tmp\//);
  });
});
