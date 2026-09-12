/**
 * Model-driven investigation loop for live benchmark runs.
 *
 * The deterministic path drives the loop with code-defined decision
 * functions. Live mode instead asks the provider model, at every iteration,
 * which tool to call next (or to stop and answer), so the evaluated agent
 * actually exercises the plan→execute→reflect loop rather than a single
 * hard-coded `retrieve` call.
 *
 * The model replies with a JSON action:
 *   {"action":"call","tool":"search_code","input":{"query":"auth"}}
 *   {"action":"stop","reason":"enough evidence"}
 * Malformed or out-of-schema replies stop the loop safely rather than
 * crashing the run.
 */

import type { InvestigationState, InvestigationAction } from '../../investigation/types.ts';
import type { ModelCallFn } from './providers.ts';

/** Max prompt characters; keeps provider calls bounded on large evidence. */
const MAX_EVIDENCE_CHARS = 4000;
const MAX_HISTORY_ITEMS = 10;

/** Format the current investigation state into a decider prompt. */
export function formatDeciderPrompt(
  state: InvestigationState,
  toolNames: readonly string[],
): string {
  const evidence = state.evidence
    .slice(0, MAX_HISTORY_ITEMS)
    .map(
      (e) =>
        `${e.filePath}${e.lineStart ? `:${e.lineStart}-${e.lineEnd ?? ''}` : ''}: ${e.excerpt}`,
    )
    .join('\n')
    .slice(0, MAX_EVIDENCE_CHARS);
  const history = state.callHistory
    .slice(-MAX_HISTORY_ITEMS)
    .map((c) => `${c.tool} ${JSON.stringify(c.input)}`)
    .join('\n');

  return [
    `You are investigating a repository question. You have ${state.iteration + 1}/${state.maxIterations} iterations left and ${state.budget.remaining}/${state.budget.limit} inspection calls left.`,
    '',
    `Question: ${state.question}`,
    '',
    `Available tools: ${toolNames.join(', ')}`,
    '',
    evidence ? `Evidence collected so far:\n${evidence}` : 'No evidence collected yet.',
    history ? `Tool calls so far:\n${history}` : '',
    state.errors.length > 0 ? `Errors so far: ${state.errors.join('; ')}` : '',
    '',
    'Reply with ONLY a JSON object, one of:',
    '{"action":"call","tool":"<tool>","input":{...}}   (call a tool next)',
    '{"action":"stop","reason":"<why>"}                (enough evidence to answer)',
    '',
    'Choose the cheapest useful tool. Stop once you have enough evidence to answer.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Parse a model reply into an InvestigationAction; null when not usable. */
export function parseModelAction(
  reply: string,
  validTools: ReadonlySet<string>,
): InvestigationAction | null {
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: { action?: unknown; tool?: unknown; input?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(match[0]) as typeof parsed;
  } catch {
    return null;
  }
  if (parsed.action === 'stop') {
    return {
      type: 'stop',
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'model requested stop',
    };
  }
  if (parsed.action === 'call') {
    const tool = typeof parsed.tool === 'string' ? parsed.tool : '';
    if (!validTools.has(tool)) return null;
    if (parsed.input === undefined || parsed.input === null || typeof parsed.input !== 'object') {
      return null;
    }
    return {
      type: 'call',
      tool,
      input: parsed.input as Record<string, unknown>,
    };
  }
  return null;
}

/** Build a live-loop decider from a model call function. */
export function createModelDecider(input: {
  modelCall: ModelCallFn;
  toolNames: readonly string[];
  maxParseAttempts?: number;
}): (state: InvestigationState) => Promise<InvestigationAction> {
  const { modelCall, toolNames } = input;
  const validTools = new Set(toolNames);
  const maxParseAttempts = input.maxParseAttempts ?? 2;

  return async (state): Promise<InvestigationAction> => {
    const prompt = formatDeciderPrompt(state, toolNames);
    let lastReply = '';
    for (let attempt = 0; attempt < maxParseAttempts; attempt += 1) {
      lastReply = (await modelCall(prompt)).content;
      const action = parseModelAction(lastReply, validTools);
      if (action) return action;
    }
    return {
      type: 'stop',
      reason: `model reply not parseable: ${lastReply.slice(0, 80)}`,
    };
  };
}
