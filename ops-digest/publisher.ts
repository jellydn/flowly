import { checkWorkspace, readPages, type SlackCall } from './slack.ts';
import { DigestStore } from './store.ts';

/** Separate trusted process; the collector/drafter never receives this capability. */
export async function publish(
  store: DigestStore,
  id: string,
  destination: string,
  call: SlackCall,
): Promise<void> {
  const current = store.get(id);
  if (!current || current.snapshot.config.destination !== destination) {
    throw new Error('Publisher destination mismatch');
  }
  if (current.state === 'sent') return;
  if (current.state !== 'approved')
    throw new Error('Human approval required; ambiguous sends must reconcile');
  const user = await checkWorkspace(call, current.snapshot.config.workspace);
  // Durable intent BEFORE the side effect. Any error after claim remains sending, never retried.
  const run = store.claim(id, user);
  const result = await call('chat.postMessage', {
    channel: destination,
    text: run.text,
    mrkdwn: false,
    parse: 'none',
    link_names: false,
    unfurl_links: false,
    unfurl_media: false,
  });
  store.delivered(id, result.channel ?? '', result.ts ?? '', false);
}

export async function reconcile(
  store: DigestStore,
  id: string,
  destination: string,
  call: SlackCall,
): Promise<void> {
  const run = store.get(id);
  if (
    !run ||
    run.state !== 'sending' ||
    !run.sending ||
    run.snapshot.config.destination !== destination
  ) {
    throw new Error('No ambiguous delivery for this destination');
  }
  const user = await checkWorkspace(call, run.snapshot.config.workspace);
  if (user !== run.sending.user) throw new Error('Publisher identity changed');
  const page = await readPages(call, 'conversations.history', {
    channel: destination,
    oldest: String(Date.parse(run.sending.at) / 1000 - 60),
    inclusive: true,
  });
  const matches = page.messages.filter(
    (message) => message.user === user && message.text === run.text,
  );
  if (!page.complete || matches.length !== 1) {
    throw new Error('Delivery remains uncertain; inspect Slack manually. No automatic resend.');
  }
  store.delivered(id, destination, matches[0].ts, true);
}
