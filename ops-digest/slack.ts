export interface SlackMessage {
  ts: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
  user?: string;
  attachments?: { text?: string; fallback?: string }[];
}
export interface SlackResult {
  ok: boolean;
  error?: string;
  team_id?: string;
  user_id?: string;
  channel?: string;
  ts?: string;
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}
export type SlackCall = (method: string, args: Record<string, unknown>) => Promise<SlackResult>;

/** Credentials stay in trusted transport code; no model or Slack text selects methods. */
export function slackClient(
  token: string,
  role: 'reader' | 'publisher',
  fetcher: typeof fetch = fetch,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
): SlackCall {
  if (!token) throw new Error('Slack token required');
  const deadline = Date.now() + 10 * 60_000;
  const allowed =
    role === 'reader'
      ? ['auth.test', 'conversations.history', 'conversations.replies']
      : ['auth.test', 'conversations.history', 'chat.postMessage'];
  return async (method, args) => {
    if (!allowed.includes(method)) throw new Error('Slack method denied');
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Slack job deadline exceeded');
      const response = await fetcher(`https://slack.com/api/${method}`, {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(Math.min(10_000, remaining)),
      });
      if (response.status === 429 && method !== 'chat.postMessage' && attempt < 2) {
        const seconds = Number(response.headers.get('retry-after'));
        await response.body?.cancel();
        if (
          !Number.isFinite(seconds) ||
          seconds < 0 ||
          seconds > 60 ||
          Date.now() + Math.max(1, seconds) * 1000 >= deadline
        ) {
          throw new Error('Slack rate limit exceeds retry budget');
        }
        await sleep(Math.max(1, seconds) * 1000);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Slack HTTP ${response.status}`);
      }
      // Bound decoded response size, including chunked responses without Content-Length.
      let body = '';
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Slack response missing');
      const decoder = new TextDecoder();
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 2_000_000) throw new Error('Slack response exceeds limit');
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
      } finally {
        await reader.cancel();
      }
      const result = JSON.parse(body) as SlackResult;
      if (result.ok !== true) {
        // Do not echo server-controlled error text or response bodies into logs/drafts.
        const known = ['missing_scope', 'not_in_channel', 'channel_not_found', 'invalid_auth'];
        throw new Error(known.includes(result.error ?? '') ? result.error : 'Slack API failure');
      }
      return result;
    }
    throw new Error('Slack retry budget exhausted');
  };
}

export async function checkWorkspace(call: SlackCall, workspace: string): Promise<string> {
  const auth = await call('auth.test', {});
  if (auth.team_id !== workspace || !auth.user_id) throw new Error('Slack workspace mismatch');
  return auth.user_id;
}

export async function readPages(
  call: SlackCall,
  method: 'conversations.history' | 'conversations.replies',
  args: Record<string, unknown>,
): Promise<{ messages: SlackMessage[]; complete: boolean }> {
  const messages: SlackMessage[] = [];
  let cursor = '';
  const seen = new Set<string>();
  for (let page = 0; page < 3; page++) {
    const result = await call(method, { ...args, limit: 100, cursor });
    if (!Array.isArray(result.messages) || result.messages.length > 100) {
      throw new Error('Invalid Slack page');
    }
    messages.push(...result.messages);
    cursor = result.response_metadata?.next_cursor?.trim() ?? '';
    if (!cursor) return { messages, complete: result.has_more !== true };
    if (seen.has(cursor)) return { messages, complete: false };
    seen.add(cursor);
  }
  return { messages, complete: false };
}
