import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as v from 'valibot';
import {
  createModelDecider,
  formatDeciderPrompt,
  parseModelAction,
} from '../eval/bench/model-loop.ts';
import type { InvestigationState } from '../investigation/types.ts';
import type { ModelCallFn } from '../eval/bench/providers.ts';
import { runInvestigation, buildToolMap } from '../investigation/loop.ts';
import { createStepBudget } from '../tools/repository.ts';
import { defineTool } from '@flue/runtime';
import type { ToolDefinition } from '@flue/runtime';

const searchInput = v.object({ query: v.optional(v.string(), '') });
const readInput = v.object({ path: v.string() });

const TOOLS: ToolDefinition[] = [
  defineTool({
    name: 'search_code',
    description: 'search source',
    input: searchInput,
    async run({ data }) {
      return {
        output: {
          matches: [{ path: 'src/auth.ts', line: 3, excerpt: 'login function' }],
          filesSearched: 1,
          query: data.query,
          path: '.',
          truncated: false,
        },
      };
    },
  }),
  defineTool({
    name: 'read_file',
    description: 'read a file',
    input: readInput,
    async run() {
      return {
        output: {
          path: 'src/auth.ts',
          startLine: 1,
          endLine: 1,
          totalLines: 1,
          content: '1: export function login() {}',
          truncated: false,
        },
      };
    },
  }),
];

const toolMap = buildToolMap({ search_code: TOOLS[0], read_file: TOOLS[1] });
const toolNames = [...toolMap.keys()];

function state(overrides: Partial<InvestigationState> = {}): InvestigationState {
  return {
    question: 'How does auth work?',
    iteration: 0,
    maxIterations: 5,
    evidence: [],
    budget: { used: 0, remaining: 8, limit: 8 },
    errors: [],
    callHistory: [],
    ...overrides,
  };
}

describe('formatDeciderPrompt', () => {
  test('includes question, budget, tool list, and evidence', () => {
    const prompt = formatDeciderPrompt(
      state({
        evidence: [
          {
            filePath: 'README.md',
            lineStart: 1,
            lineEnd: 3,
            excerpt: 'auth docs',
            sourceType: 'documentation',
          },
        ],
      }),
      toolNames,
    );
    assert.match(prompt, /How does auth work\?/);
    assert.match(prompt, /search_code, read_file/);
    assert.match(prompt, /8 inspection calls left/);
    assert.match(prompt, /README.md:1-3: auth docs/);
  });
});

describe('parseModelAction', () => {
  test('parses a call action', () => {
    const action = parseModelAction(
      '{"action":"call","tool":"search_code","input":{"query":"auth"}}',
      new Set(['search_code', 'read_file']),
    );
    assert.deepEqual(action, { type: 'call', tool: 'search_code', input: { query: 'auth' } });
  });

  test('parses a stop action with reason', () => {
    const action = parseModelAction(
      '{"action":"stop","reason":"enough evidence"}',
      new Set(['search_code']),
    );
    assert.deepEqual(action, { type: 'stop', reason: 'enough evidence' });
  });

  test('rejects unknown tools', () => {
    assert.equal(
      parseModelAction('{"action":"call","tool":"ls","input":{}}', new Set(['search_code'])),
      null,
    );
  });

  test('rejects non-JSON and wrong shapes', () => {
    assert.equal(parseModelAction('just text', new Set(['search_code'])), null);
    assert.equal(
      parseModelAction('{"action":"call","tool":"search_code"}', new Set(['search_code'])),
      null,
    );
    assert.equal(parseModelAction('{"action":"dance"}', new Set(['search_code'])), null);
  });

  test('extracts JSON embedded in prose', () => {
    const action = parseModelAction(
      'Here you go: {"action":"stop","reason":"done"} hope that helps',
      new Set(['search_code']),
    );
    assert.deepEqual(action, { type: 'stop', reason: 'done' });
  });
});

describe('createModelDecider', () => {
  test('returns the parsed model action', async () => {
    const modelCall: ModelCallFn = async () => ({
      content: '{"action":"call","tool":"search_code","input":{"query":"auth"}}',
    });
    const decide = createModelDecider({ modelCall, toolNames });
    const action = await decide(state());
    assert.deepEqual(action, { type: 'call', tool: 'search_code', input: { query: 'auth' } });
  });

  test('stops safely when the model reply is unparseable', async () => {
    const modelCall: ModelCallFn = async () => ({ content: 'sorry, no json here' });
    const decide = createModelDecider({ modelCall, toolNames });
    const action = await decide(state());
    assert.equal(action.type, 'stop');
    assert.match((action as { reason: string }).reason, /not parseable/);
  });
});

describe('model-driven live investigation loop', () => {
  test('the model drives search, then stops once evidence is present', async () => {
    const decideCalls: string[] = [];
    const modelCall: ModelCallFn = async (prompt) => {
      const hasEvidence = prompt.includes('Evidence collected');
      decideCalls.push(hasEvidence ? 'answer' : 'decide');
      if (!hasEvidence) {
        return { content: '{"action":"call","tool":"search_code","input":{"query":"login"}}' };
      }
      return { content: '{"action":"stop","reason":"have evidence"}' };
    };

    const decide = createModelDecider({ modelCall, toolNames });
    const budget = createStepBudget(8);
    const result = await runInvestigation('How does auth work?', toolMap, budget, decide, {
      maxIterations: 5,
    });

    assert.ok(result.toolsUsed.includes('search_code'));
    assert.equal(result.evidence.length, 1);
    assert.equal(result.errors.length, 0);
    // Decide round 1 calls search_code; round 2 sees evidence and stops.
    assert.deepEqual(decideCalls, ['decide', 'answer']);
    assert.equal(result.stopReason, 'have evidence');
  });

  test('the model drives a two-tool sequence', async () => {
    const script = [
      '{"action":"call","tool":"search_code","input":{"query":"login"}}',
      '{"action":"call","tool":"read_file","input":{"path":"src/auth.ts"}}',
      '{"action":"stop","reason":"enough"}',
    ];
    let idx = 0;
    const modelCall: ModelCallFn = async () => ({
      content: script[Math.min(idx++, script.length - 1)],
    });

    const decide = createModelDecider({ modelCall, toolNames });
    const budget = createStepBudget(8);
    const result = await runInvestigation('How does auth work?', toolMap, budget, decide, {
      maxIterations: 5,
    });

    assert.deepEqual(result.toolsUsed, ['search_code', 'read_file']);
    assert.equal(result.evidence.length, 2);
    assert.equal(result.stopReason, 'enough');
  });
});
