import * as v from 'valibot';

const channel = v.pipe(v.string(), v.regex(/^[CG][A-Z0-9]{2,}$/));
export const configSchema = v.strictObject({
  workspace: v.pipe(v.string(), v.regex(/^T[A-Z0-9]{2,}$/)),
  channels: v.pipe(v.array(channel), v.minLength(1), v.maxLength(10)),
  destination: channel,
  timezone: v.string(),
  cutoff: v.pipe(v.string(), v.regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)),
  approvers: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
  audienceConfirmed: v.literal(true),
});
export type DigestConfig = v.InferOutput<typeof configSchema>;

export function parseConfig(input: unknown): DigestConfig {
  const config = v.parse(configSchema, input);
  new Intl.DateTimeFormat('en', { timeZone: config.timezone }).format();
  if (new Set(config.channels).size !== config.channels.length) {
    throw new Error('Duplicate source channels');
  }
  return config;
}

export interface Window {
  start: string;
  end: string;
}

/** Civil-time cutoffs, not 24-hour subtraction: Monday includes the weekend. */
export function digestWindow(config: DigestConfig, date: string): Window {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Expected YYYY-MM-DD');
  const day = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== date) {
    throw new Error('Invalid date');
  }
  if ([0, 6].includes(day.getUTCDay())) throw new Error('Digest date must be a weekday');
  const previous = new Date(day);
  do {
    previous.setUTCDate(previous.getUTCDate() - 1);
  } while ([0, 6].includes(previous.getUTCDay()));
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  function cutoff(civilDate: string): string {
    const target = `${civilDate} ${config.cutoff}`;
    const center = Date.parse(`${civilDate}T${config.cutoff}:00Z`);
    const matches: number[] = [];
    // IANA offsets fit within this bound. Reject ambiguous or missing local cutoffs.
    for (let ms = center - 18 * 3600_000; ms <= center + 18 * 3600_000; ms += 60_000) {
      if (formatter.format(ms) === target) matches.push(ms);
    }
    if (matches.length !== 1) throw new Error('Cutoff is ambiguous or missing in this timezone');
    return new Date(matches[0]).toISOString();
  }
  return { start: cutoff(previous.toISOString().slice(0, 10)), end: cutoff(date) };
}
