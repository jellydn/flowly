import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ToolDefinition } from '@flue/runtime';
import {
  executeToolCallWithMetadata,
  invokeTool,
  unwrapToolOutput,
} from '../investigation/tool-execution.ts';
import {
  invokeTool as invokeToolFromCompatibilityPath,
  unwrapToolOutput as unwrapToolOutputFromCompatibilityPath,
} from '../reliability/tool-invocation.ts';

function tool(
  run: ToolDefinition['run'],
  name = 'read_file',
): ToolDefinition {
  return {
    name,
    description: 'test tool',
    input: undefined,
    output: undefined,
    run,
  };
}

describe('tool execution deep module', () => {
  test('unwraps Flue envelopes and tolerates legacy payloads', () => {
    assert.deepEqual(unwrapToolOutput({ output: { value: 1 } }), { value: 1 });
    assert.deepEqual(unwrapToolOutput({ value: 2 }), { value: 2 });
  });

  test('normalizes successful calls with invocation metadata', async () => {
    let receivedId = '';
    const result = await executeToolCallWithMetadata(
      {
        read_file: tool(async ({ toolCallId }) => {
          receivedId = toolCallId;
          return { output: { content: 'ok' } };
        }),
      },
      'read_file',
      { path: 'src/auth.ts' },
      'metadata-call',
    );

    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.output, { content: 'ok' });
    assert.equal(receivedId, 'metadata-call');
    assert.equal(result.metadata.toolCallId, 'metadata-call');
    assert.ok(result.metadata.startedAt > 0);
    assert.ok(result.metadata.durationMs >= 0);
  });

  test('returns normalized outcomes for unknown tools and preflight failures', async () => {
    const unknown = await executeToolCallWithMetadata(
      {},
      'missing',
      {},
      'unknown-call',
    );
    assert.deepEqual(unknown, {
      ok: false,
      tool: 'missing',
      error: 'Unknown or unsupported tool: missing',
      metadata: {
        toolCallId: 'unknown-call',
        startedAt: unknown.metadata.startedAt,
        durationMs: unknown.metadata.durationMs,
      },
    });

    let invoked = false;
    const rejected = await executeToolCallWithMetadata(
      { read_file: tool(async () => { invoked = true; return { output: {} }; }) },
      'read_file',
      {},
      'preflight-call',
      undefined,
      () => 'Inspection budget exhausted',
    );
    assert.equal(invoked, false);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error, 'Inspection budget exhausted');
    assert.equal(rejected.metadata.toolCallId, 'preflight-call');
  });

  test('rejects a call when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    let invoked = false;
    const resultPromise = executeToolCallWithMetadata(
      { read_file: tool(async () => { invoked = true; return { output: {} }; }) },
      'read_file',
      {},
      'pre-aborted-call',
      controller.signal,
    );
    await assert.rejects(resultPromise, /cancel/i);
    assert.equal(invoked, false);
  });

  test('normalizes callback failures as tool errors', async () => {
    const preflightFailure = await executeToolCallWithMetadata(
      { read_file: tool(async () => ({ output: {} })) },
      'read_file',
      {},
      'preflight-error',
      undefined,
      () => { throw new Error('preflight failed'); },
    );
    assert.equal(preflightFailure.ok, false);
    if (!preflightFailure.ok) assert.equal(preflightFailure.error, 'preflight failed');

    const resolvedFailure = await executeToolCallWithMetadata(
      { read_file: tool(async () => ({ output: {} })) },
      'read_file',
      {},
      'resolved-error',
      undefined,
      undefined,
      () => { throw new Error('resolution failed'); },
    );
    assert.equal(resolvedFailure.ok, false);
    if (!resolvedFailure.ok) assert.equal(resolvedFailure.error, 'resolution failed');
  });

  test('runs resolution callback only after tool lookup and preflight', async () => {
    const events: string[] = [];
    await executeToolCallWithMetadata(
      { read_file: tool(async () => { events.push('run'); return { output: {} }; }) },
      'read_file',
      {},
      'callback-call',
      undefined,
      () => { events.push('preflight'); return undefined; },
      () => events.push('resolved'),
    );
    assert.deepEqual(events, ['preflight', 'resolved', 'run']);
  });

  test('preserves cancellation as an exception', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const promise = executeToolCallWithMetadata(
      { read_file: tool(async ({ signal }) => {
        started();
        await new Promise<void>((_, reject) => {
          const onAbort = () => {
            signal?.removeEventListener('abort', onAbort);
            reject(new Error('operation cancelled'));
          };
          signal?.addEventListener('abort', onAbort, { once: true });
        });
        return { output: {} };
      }) },
      'read_file',
      {},
      'cancel-call',
      controller.signal,
    );
    await running;
    controller.abort(new Error('cancelled'));
    await assert.rejects(promise, /cancel/i);
  });

  test('keeps the old invocation module path as a compatibility adapter', async () => {
    const definition = tool(async () => ({ output: { ok: true } }));
    assert.deepEqual(
      await invokeTool(definition, { toolCallId: 'direct', data: {} }),
      { ok: true },
    );
    assert.deepEqual(
      await invokeToolFromCompatibilityPath(definition, { toolCallId: 'compat', data: {} }),
      { ok: true },
    );
    assert.deepEqual(
      unwrapToolOutputFromCompatibilityPath({ output: 'compat' }),
      'compat',
    );
  });
});
