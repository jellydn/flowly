#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { collect } from '../ops-digest/collect.ts';
import { digestWindow, parseConfig } from '../ops-digest/config.ts';
import { slackClient } from '../ops-digest/slack.ts';
import { DigestStore, runId } from '../ops-digest/store.ts';

process.umask(0o077);
const [command, configPath, dbPath, target, hash] = process.argv.slice(2);
if (!command || !configPath || !dbPath || !target) {
  throw new Error(
    'Usage: ops-digest <collect|show|approve|track|resolve> <config.json> <db> <date|channel> [hash|thread-ts]',
  );
}
const config = parseConfig(JSON.parse(readFileSync(configPath, 'utf8')));
const store = new DigestStore(dbPath);
try {
  const id = runId(config.workspace, target);
  if (command === 'collect') {
    const window = digestWindow(config, target);
    if (Date.parse(window.end) > Date.now()) throw new Error('Cutoff has not occurred yet');
    const existing = store.get(id);
    const run =
      existing ??
      store.freeze(
        id,
        await collect(
          config,
          window,
          store.threads(config.workspace),
          slackClient(process.env.OPS_SLACK_READ_TOKEN ?? '', 'reader'),
        ),
      );
    console.log(JSON.stringify({ id: run.id, hash: run.hash, state: run.state }));
  } else if (command === 'show') {
    const run = store.get(id);
    if (!run) throw new Error('Run not found');
    console.log(JSON.stringify(run, null, 2));
  } else if (command === 'approve') {
    if (!hash) throw new Error('Reviewed hash required');
    store.approve(id, userInfo().username, hash);
    console.log('Approved frozen content and destination');
  } else if (command === 'track' || command === 'resolve') {
    if (!config.channels.includes(target) || !hash)
      throw new Error('Allowlisted channel and thread timestamp required');
    store[command](config.workspace, { channel: target, ts: hash });
    console.log('Thread tracking updated');
  } else throw new Error('Unknown command');
} finally {
  store.close();
}
