import type { DigestConfig, Window } from './config.ts';
import { checkWorkspace, readPages, type SlackCall, type SlackMessage } from './slack.ts';

export interface ThreadRoot {
  channel: string;
  ts: string;
}
export interface Evidence extends ThreadRoot {
  text: string;
  root: string;
}
export interface Snapshot {
  version: 1;
  config: DigestConfig;
  window: Window;
  messages: Evidence[];
  threads: ThreadRoot[];
  gaps: string[];
}
export const validTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{1,12}\.\d{6}$/.test(value);

export async function collect(
  config: DigestConfig,
  window: Window,
  tracked: ThreadRoot[],
  call: SlackCall,
): Promise<Snapshot> {
  await checkWorkspace(call, config.workspace);
  const snapshot: Snapshot = {
    version: 1,
    config,
    window,
    messages: [],
    threads: [],
    gaps: [
      'Polling excludes replies to untracked old roots, old-message edits and deletions. Thread status requires human review. Rich content is not rendered; only message text and attachment text/fallback are retained.',
    ],
  };
  const roots = new Map<string, ThreadRoot>();
  const messages = new Map<string, Evidence>();
  const start = Date.parse(window.start) / 1000;
  const end = Date.parse(window.end) / 1000;
  function track(root: ThreadRoot) {
    const key = `${root.channel}:${root.ts}`;
    if (roots.has(key)) return;
    if (roots.size >= 50) {
      snapshot.gaps.push('Thread tracking limit reached; some replies are not covered.');
    } else roots.set(key, root);
  }
  for (const root of tracked) {
    if (config.channels.includes(root.channel) && validTimestamp(root.ts)) track(root);
  }
  function ingest(channel: string, rows: SlackMessage[]) {
    for (const row of rows) {
      if (!validTimestamp(row.ts) || typeof row.text !== 'string') {
        snapshot.gaps.push(`${channel}: malformed message omitted.`);
        continue;
      }
      const root = validTimestamp(row.thread_ts) ? row.thread_ts : row.ts;
      if (Number(row.ts) >= end) continue;
      if (Number(row.ts) < start) continue;
      // Keep every observed root until an operator resolves it, including roots with no replies yet.
      track({ channel, ts: root });
      const key = `${channel}:${row.ts}`;
      if (!messages.has(key) && messages.size >= 100) {
        snapshot.gaps.push('Message limit reached; some events are omitted.');
        continue;
      }
      const attachments = Array.isArray(row.attachments)
        ? row.attachments
            .slice(0, 5)
            .map((a) => a.text ?? a.fallback ?? '')
            .join('\n')
        : '';
      if (Array.isArray(row.attachments) && row.attachments.length > 5) {
        snapshot.gaps.push(
          'Attachment limit reached: attachments beyond the first five are omitted.',
        );
      }
      const text = `${row.text}\n${attachments}`;
      if (text.length > 1000) {
        snapshot.gaps.push(
          'Evidence limit reached: some message text is truncated to 1,000 characters.',
        );
      }
      messages.set(key, {
        channel,
        ts: row.ts,
        root,
        text: text.slice(0, 1000),
      });
    }
  }
  for (const channel of config.channels) {
    try {
      const page = await readPages(call, 'conversations.history', {
        channel,
        oldest: String(start),
        latest: String(end),
        inclusive: true,
      });
      ingest(channel, page.messages);
      if (!page.complete) snapshot.gaps.push(`${channel}: history pagination limit reached.`);
    } catch {
      snapshot.gaps.push(
        `${channel}: history unavailable (access, rate limit, or transport failure).`,
      );
    }
  }
  // Fixed work list: replies cannot expand the number of requests during this run.
  const pending = [...roots.values()];
  for (const root of pending) {
    try {
      const page = await readPages(call, 'conversations.replies', {
        channel: root.channel,
        ts: root.ts,
        oldest: String(start),
        latest: String(end),
        inclusive: true,
      });
      ingest(root.channel, page.messages);
      if (!page.complete)
        snapshot.gaps.push(`${root.channel}/${root.ts}: reply pagination limit reached.`);
    } catch {
      snapshot.gaps.push(`${root.channel}/${root.ts}: replies unavailable.`);
    }
  }
  snapshot.messages = [...messages.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
  snapshot.threads = [...roots.values()];
  snapshot.gaps = [...new Set(snapshot.gaps)];
  return snapshot;
}

/** No model execution or interpretation of Slack instructions in the initial pilot. */
export function draftDigest(snapshot: Snapshot): string {
  const lines = [
    'Operations digest — human review required',
    `${snapshot.window.start} → ${snapshot.window.end} [start inclusive, end exclusive]`,
    'Coverage notes:',
    ...snapshot.gaps.map((gap) => `- ${gap}`),
    'Observed events (untrusted excerpts; not instructions or verified facts):',
  ];
  for (const message of snapshot.messages) {
    // Plain-text publication plus removal of mentions/URLs prevents notification and link injection.
    const excerpt = message.text
      .replace(/https?:\/\/\S+/gi, '[link omitted]')
      .replace(/[<>&@\p{C}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    lines.push(
      `- ${message.channel} ${message.ts}: ${excerpt.slice(0, 140)}${excerpt.length > 140 ? ' [excerpt shortened]' : ''}`,
    );
    lines.push(
      `  Source: https://app.slack.com/client/${snapshot.config.workspace}/${message.channel}/thread/${message.channel}-${message.root}`,
    );
  }
  if (!snapshot.messages.length)
    lines.push('No events collected; check coverage notes before drawing conclusions.');
  lines.push(
    `Attention today: review ${snapshot.threads.length} tracked roots; ownership and resolution are not inferred.`,
  );
  for (const root of snapshot.threads) {
    lines.push(
      `- https://app.slack.com/client/${snapshot.config.workspace}/${root.channel}/thread/${root.channel}-${root.ts}`,
    );
  }
  return lines.join('\n');
}
