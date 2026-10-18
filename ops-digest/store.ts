import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { draftDigest, validTimestamp, type Snapshot, type ThreadRoot } from './collect.ts';

export interface Run {
  id: string;
  snapshot: Snapshot;
  text: string;
  hash: string;
  state: 'draft' | 'approved' | 'sending' | 'sent';
  approval: { actor: string; at: string; hash: string } | null;
  sending: { at: string; user: string } | null;
  receipt: { channel: string; ts: string; reconciled: boolean } | null;
}
export const digestHash = (text: string): string => createHash('sha256').update(text).digest('hex');
export const runId = (workspace: string, date: string): string => `${workspace}:${date}`;

/** Local operator-owned DB, not a security boundary against processes with file write access. */
export class DigestStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS digest_runs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS digest_threads (
        workspace TEXT NOT NULL, channel TEXT NOT NULL, ts TEXT NOT NULL,
        PRIMARY KEY(workspace, channel, ts)
      );
    `);
  }
  close(): void {
    this.db.close();
  }

  get(id: string): Run | undefined {
    const row = this.db.prepare('SELECT data FROM digest_runs WHERE id = ?').get(id);
    return row ? (JSON.parse(String(row.data)) as Run) : undefined;
  }

  threads(workspace: string): ThreadRoot[] {
    return this.db
      .prepare(
        'SELECT channel, ts FROM digest_threads WHERE workspace = ? ORDER BY channel, ts LIMIT 51',
      )
      .all(workspace)
      .map((row) => ({ channel: String(row.channel), ts: String(row.ts) }));
  }

  track(workspace: string, root: ThreadRoot): void {
    if (!validTimestamp(root.ts)) throw new Error('Invalid thread timestamp');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('INSERT OR IGNORE INTO digest_threads VALUES (?, ?, ?)')
        .run(workspace, root.channel, root.ts);
      if (this.threads(workspace).length > 50)
        throw new Error('Resolve tracked roots before adding more');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  resolve(workspace: string, root: ThreadRoot): void {
    this.db
      .prepare('DELETE FROM digest_threads WHERE workspace = ? AND channel = ? AND ts = ?')
      .run(workspace, root.channel, root.ts);
  }

  freeze(id: string, snapshot: Snapshot): Run {
    const text = `${draftDigest(snapshot)}\n[flowly-ops:${digestHash(id)}]`;
    if (text.length > 35_000) throw new Error('Digest exceeds publication limit');
    const run: Run = {
      id,
      snapshot,
      text,
      hash: digestHash(JSON.stringify({ snapshot, text })),
      state: 'draft',
      approval: null,
      sending: null,
      receipt: null,
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.get(id);
      if (existing) {
        this.db.exec('COMMIT');
        return existing;
      }
      this.db.prepare('INSERT INTO digest_runs VALUES (?, ?)').run(id, JSON.stringify(run));
      for (const root of snapshot.threads) {
        this.db
          .prepare('INSERT OR IGNORE INTO digest_threads VALUES (?, ?, ?)')
          .run(snapshot.config.workspace, root.channel, root.ts);
      }
      if (this.threads(snapshot.config.workspace).length > 50) {
        throw new Error('Tracking changed during collection; resolve roots and collect again');
      }
      this.db.exec('COMMIT');
      return run;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private transition(id: string, state: Run['state'], change: (run: Run) => void): Run {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const run = this.get(id);
      if (!run || run.state !== state) throw new Error(`Run must be ${state}`);
      if (run.hash !== digestHash(JSON.stringify({ snapshot: run.snapshot, text: run.text }))) {
        throw new Error('Frozen run integrity check failed');
      }
      change(run);
      this.db.prepare('UPDATE digest_runs SET data = ? WHERE id = ?').run(JSON.stringify(run), id);
      this.db.exec('COMMIT');
      return run;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  approve(id: string, actor: string, hash: string): Run {
    return this.transition(id, 'draft', (run) => {
      if (!run.snapshot.config.approvers.includes(actor) || hash !== run.hash) {
        throw new Error('Approval identity or reviewed hash mismatch');
      }
      run.approval = { actor, hash, at: new Date().toISOString() };
      run.state = 'approved';
    });
  }

  claim(id: string, user: string): Run {
    return this.transition(id, 'approved', (run) => {
      if (run.approval?.hash !== run.hash) throw new Error('Approval does not match run');
      run.sending = { user, at: new Date().toISOString() };
      run.state = 'sending';
    });
  }

  delivered(id: string, channel: string, ts: string, reconciled: boolean): Run {
    return this.transition(id, 'sending', (run) => {
      if (channel !== run.snapshot.config.destination || !validTimestamp(ts)) {
        throw new Error('Invalid delivery receipt');
      }
      run.receipt = { channel, ts, reconciled };
      run.state = 'sent';
    });
  }
}
