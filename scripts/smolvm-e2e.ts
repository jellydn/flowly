/**
 * End-to-end check of FLOWLY_EXECUTOR=smolvm on a Mac with smolvm installed.
 *
 * It makes a small demo repository with no dependencies (a bare `origin` and a
 * source checkout), writes an `issues.labeled` event, and runs the real
 * `scripts/run-factory.ts`: model classification and planning on the host,
 * implementer tools and checks in offline VMs, and the stop before `git push`.
 * GITHUB_TOKEN is a dummy value, so no GitHub write is possible.
 *
 *   FLOWLY_VM_IMAGE=node:24-alpine OPENROUTER_API_KEY=... npx tsx scripts/smolvm-e2e.ts
 *
 * Optional: FACTORY_MODEL (default openrouter/cohere/north-mini-code:free),
 * FLOWLY_VM_PREFIX, KEEP_SMOLVM_E2E=1 to keep the temporary directory.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  SmolvmExecutionAdapter,
  assertSmolvmAvailable,
  createSmolvmCommandRunner,
  parseSmolvmConfig,
} from '../factory/smolvm.ts';
import { FileFactoryRunStore } from '../factory/store.ts';
import { isProtectedPath } from '../factory/tree-import.ts';

const REPOSITORY = 'flowly-e2e/demo';
const RUN_TIMEOUT_MS = 40 * 60_000;
const model = process.env.FACTORY_MODEL ?? 'openrouter/cohere/north-mini-code:free';
const modelKey = model.startsWith('openrouter/') ? process.env.OPENROUTER_API_KEY : undefined;
if (model.startsWith('openrouter/') && !modelKey) {
  console.error(`${model} needs OPENROUTER_API_KEY on the host (it never enters a VM).`);
  process.exit(2);
}
const config = parseSmolvmConfig(process.env);
const runner = createSmolvmCommandRunner();
await assertSmolvmAvailable(runner);

let failed = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const tmp = mkdtempSync(path.join(os.tmpdir(), 'flowly-smolvm-e2e-'));
const origin = path.join(tmp, 'origin.git');
const source = path.join(tmp, 'source');
const policyPath = path.join(tmp, 'autonomy-policy.json');
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

try {
  // Demo repository: one failing test and a one-line fix. No dependencies.
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', source]);
  mkdirSync(path.join(source, 'src'));
  mkdirSync(path.join(source, 'test'));
  const files: Record<string, string> = {
    'package.json': `${JSON.stringify(
      {
        name: 'flowly-smolvm-demo',
        private: true,
        type: 'module',
        scripts: { test: 'node --test' },
      },
      null,
      2,
    )}\n`,
    'src/greet.js': 'export const greet = (name) => `Hello ${name}`;\n',
    'test/greet.test.js': [
      "import assert from 'node:assert/strict';",
      "import { test } from 'node:test';",
      "import { greet } from '../src/greet.js';",
      '',
      "test('greets with a comma and an exclamation mark', () => {",
      "  assert.equal(greet('Ada'), 'Hello, Ada!');",
      '});',
      '',
    ].join('\n'),
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(source, name), content);
  }
  git(source, 'add', '-A');
  git(source, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-qm', 'base');
  git(source, 'remote', 'add', 'origin', origin);
  git(source, 'push', '-q', 'origin', 'main');
  git(source, 'fetch', '-q', 'origin');

  const eventPath = path.join(tmp, 'event.json');
  writeFileSync(
    eventPath,
    JSON.stringify({
      action: 'labeled',
      label: { name: 'factory' },
      repository: { full_name: REPOSITORY },
      issue: {
        number: 1,
        title: 'Fix the greeting punctuation',
        labels: [{ name: 'factory' }],
        body: [
          "`greet('Ada')` in src/greet.js returns `Hello Ada`, but it must return `Hello, Ada!`.",
          '',
          'Acceptance criteria:',
          '- `greet(name)` returns `Hello, ${name}!`.',
          '- Do not change the tests.',
          '',
          'Verify with `npm test`.',
        ].join('\n'),
      },
    }),
  );

  // Without a policy, run-factory defaults to plan-only and stops before implementation.
  // implement-and-verify allows the VM phases; the publication gate stays closed, and
  // stopBeforePush refuses the push, so no PR is possible.
  writeFileSync(
    policyPath,
    JSON.stringify({
      version: 'smolvm-e2e-v1',
      promotionEnabled: false,
      defaultLevel: 'implement-and-verify',
      maximumLevel: 'implement-and-verify',
      minimumSamples: { implementAndVerify: 1, publishDraftPr: 1 },
      promotionThresholds: {
        verificationSuccessRate: 1,
        reviewReadyRate: 1,
        publicationSuccessRate: 1,
      },
    }),
  );

  const runStore = path.join(tmp, 'runs');
  const result = await runFactory({
    GITHUB_TOKEN: 'unused',
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_EVENT_NAME: 'issues',
    GITHUB_EVENT_PATH: eventPath,
    REPOSITORY_PATH: source,
    FACTORY_RUN_STORE: runStore,
    FACTORY_WORKSPACE_ROOT: path.join(tmp, 'workspaces'),
    FACTORY_MODEL: model,
    FLOWLY_EXECUTOR: 'smolvm',
    FACTORY_AUTONOMY_POLICY: policyPath,
  });

  const [run] = await new FileFactoryRunStore(runStore).listByRepository(REPOSITORY);
  if (run?.state === 'planned') {
    throw new Error(
      'smolvm e2e: the run stopped in `planned` before implementation, so no VM ran. ' +
        `Check the autonomy policy in ${policyPath}. Run failure: ${run.failure ?? 'none'}.`,
    );
  }
  const implementation = run?.implementation;
  check(
    'run-factory stopped before push',
    result.exitCode !== 0 && result.output.includes('stops before push'),
    `exit ${result.exitCode}${run?.failure ? `; failure: ${run.failure}` : ''}`,
  );
  check(
    'run is in verifying with a commit',
    run?.state === 'verifying' && /^[0-9a-f]{40}$/.test(implementation?.commitSha ?? ''),
    `state ${run?.state}`,
  );
  check(
    'all verification commands passed',
    (implementation?.commands.length ?? 0) > 0 &&
      implementation!.commands.every((command) => command.exitCode === 0),
    JSON.stringify(implementation?.commands ?? []),
  );
  check(
    'execution recorded the smolvm VM of attempt 1',
    run?.execution?.executor === 'smolvm' &&
      run.execution.vmName === `${config.prefix}-${run.id}-a1`,
    run?.execution?.vmName,
  );
  check(
    'changed files touch no protected path',
    (implementation?.changedFiles.length ?? 0) > 0 &&
      !implementation!.changedFiles.some((file) => isProtectedPath(file)),
    implementation?.changedFiles.join(', '),
  );
  const heads = execFileSync(
    'git',
    ['--git-dir', origin, 'for-each-ref', '--format=%(refname)', 'refs/heads'],
    { encoding: 'utf8' },
  ).trim();
  check('nothing was pushed to origin', heads === 'refs/heads/main', heads.replace(/\n/g, ', '));
  const leftovers = flowlyMachines();
  check('no flowly VMs remain', leftovers.length === 0, leftovers.join(', '));
  check(
    'the model key never appears in the output',
    !modelKey || !result.output.includes(modelKey),
  );
} finally {
  rmSync(policyPath, { force: true });
  for (const prefix of [config.prefix, `${config.prefix}-verify`]) {
    await new SmolvmExecutionAdapter({ ...config, prefix }, runner)
      .sweepOrphans(new Set())
      .catch(() => []);
  }
  if (process.env.KEEP_SMOLVM_E2E === '1') console.log(`kept ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}

console.log(failed === 0 ? 'smolvm e2e: all checks passed' : `smolvm e2e: ${failed} FAIL`);
process.exitCode = failed === 0 ? 0 : 1;

/** Runs the real factory entrypoint; its output streams to this terminal and is kept. */
function runFactory(env: Record<string, string>): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/run-factory.ts'], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const keep = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      process.stderr.write(chunk);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGTERM'), RUN_TIMEOUT_MS);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, output });
    });
  });
}

/** Every VM on the host whose name starts with the flowly prefix. */
function flowlyMachines(): string[] {
  const list = JSON.parse(
    execFileSync('smolvm', ['machine', 'ls', '--json'], { encoding: 'utf8' }),
  );
  return (list as Array<{ name: string }>)
    .map((machine) => machine.name)
    .filter((name) => name.startsWith(`${config.prefix}-`));
}
