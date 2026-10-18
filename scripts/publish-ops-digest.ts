#!/usr/bin/env node
import { DigestStore } from '../ops-digest/store.ts';
import { publish, reconcile } from '../ops-digest/publisher.ts';
import { slackClient } from '../ops-digest/slack.ts';

process.umask(0o077);
const [command, dbPath, id] = process.argv.slice(2);
if (!['publish', 'reconcile'].includes(command) || !dbPath || !id) {
  throw new Error('Usage: publish-ops-digest <publish|reconcile> <db> <run-id>');
}
const destination = process.env.OPS_SLACK_DESTINATION;
if (!destination || !/^[CG][A-Z0-9]{2,}$/.test(destination)) {
  throw new Error('Fixed OPS_SLACK_DESTINATION required');
}
const store = new DigestStore(dbPath);
try {
  const call = slackClient(process.env.OPS_SLACK_PUBLISH_TOKEN ?? '', 'publisher');
  await (command === 'publish' ? publish : reconcile)(store, id, destination, call);
  console.log(JSON.stringify({ id, state: store.get(id)?.state, receipt: store.get(id)?.receipt }));
} finally {
  store.close();
}
