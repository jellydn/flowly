import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { computeSummary } from './metrics.ts';
import type { BenchmarkReport } from './types.ts';

const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex');
const digest = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const finite = v.pipe(v.number(), v.finite(), v.minValue(0));
const rate = v.pipe(finite, v.maxValue(1));
const summarySchema = v.strictObject({
  qualityScore: rate,
  avgLatencyMs: finite,
  totalTokens: finite,
  costUsd: v.nullable(finite),
  toolSuccessRate: rate,
  patchApplicabilityRate: v.nullable(rate),
  humanAcceptanceRate: v.nullable(rate),
});
const snapshotSchema = v.strictObject({
  version: v.literal(1),
  runFingerprint: digest,
  suiteFingerprint: digest,
  modelFingerprint: digest,
  judgeFingerprint: digest,
  mode: v.picklist(['live', 'deterministic']),
  ranAt: v.pipe(v.string(), v.isoTimestamp()),
  lineage: v.strictObject({ suiteDigest: digest, repositoryDigest: digest }),
  summary: summarySchema,
  scenarios: v.pipe(
    v.array(
      v.strictObject({
        fingerprint: digest,
        workload: v.picklist([
          'repository-question',
          'github-issue',
          'pull-request-review',
          'coding-task',
        ]),
        passed: v.boolean(),
        quality: rate,
        latencyMs: finite,
        tokens: finite,
        costUsd: v.nullable(finite),
        toolSuccess: v.boolean(),
        patchApplicable: v.nullable(v.boolean()),
        humanAccepted: v.nullable(v.boolean()),
      }),
    ),
    v.minLength(1),
    v.maxLength(1000),
  ),
});
export type SharedSnapshot = v.InferOutput<typeof snapshotSchema>;

/** No free text crosses this boundary, including identifiers that can hide local paths or secrets. */
export function createSharedSnapshot(report: BenchmarkReport): SharedSnapshot {
  const metrics = computeSummary(report.results);
  const optional = (value: number): number | null => (Number.isFinite(value) ? value : null);
  return v.parse(snapshotSchema, {
    version: 1,
    runFingerprint: fingerprint(report.runId),
    suiteFingerprint: fingerprint(report.suiteId),
    modelFingerprint: fingerprint(report.model.id),
    judgeFingerprint: fingerprint(report.judge ?? 'keyword'),
    mode: report.mode,
    ranAt: new Date(report.ranAt).toISOString(),
    lineage: report.lineage,
    summary: {
      qualityScore: metrics.qualityScore,
      avgLatencyMs: metrics.avgLatencyMs,
      totalTokens: metrics.totalTokens,
      costUsd: optional(metrics.costUsd),
      toolSuccessRate: metrics.toolSuccessRate,
      patchApplicabilityRate: optional(metrics.patchApplicabilityRate),
      humanAcceptanceRate: optional(metrics.humanAcceptanceRate),
    },
    scenarios: report.results.map((result) => ({
      fingerprint: fingerprint(result.id),
      workload: result.workloadType ?? 'repository-question',
      passed: result.passed,
      quality: result.metrics.qualityScore,
      latencyMs: result.metrics.latencyMs,
      tokens: result.metrics.tokensIn + result.metrics.tokensOut,
      costUsd: optional(result.metrics.costUsd),
      toolSuccess: result.metrics.toolSuccess.passed,
      patchApplicable: result.metrics.patchApplicability?.passed ?? null,
      humanAccepted: result.metrics.humanAccepted ?? null,
    })),
  });
}

/** Durable single-host store. Snapshot rows are inserted, read, or deleted, never updated. */
export class EvaluationShareStore {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS evaluation_shares (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, expires INTEGER NOT NULL, snapshot TEXT NOT NULL
      )`);
  }
  close(): void {
    this.db.close();
  }
  publish(snapshot: SharedSnapshot, ttlSeconds: number, now = Date.now()) {
    const safe = v.parse(snapshotSchema, snapshot);
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 30 * 86400)
      throw new Error('Expiry must be 60–2592000 seconds');
    const id = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('base64url');
    const json = JSON.stringify(safe);
    const expires = now + ttlSeconds * 1000;
    this.db
      .prepare('INSERT INTO evaluation_shares VALUES (?, ?, ?, ?)')
      .run(id, fingerprint(token), expires, json);
    return {
      id,
      token,
      expiresAt: new Date(expires).toISOString(),
      snapshotDigest: fingerprint(json),
      visibility: 'bearer-link' as const,
    };
  }
  read(id: string, token: string, now = Date.now()) {
    const row = this.db.prepare('SELECT * FROM evaluation_shares WHERE id = ?').get(id);
    if (
      !row ||
      Number(row.expires) <= now ||
      !timingSafeEqual(
        Buffer.from(String(row.token_hash), 'hex'),
        Buffer.from(fingerprint(token), 'hex'),
      )
    )
      return null;
    const json = String(row.snapshot);
    return {
      id,
      expiresAt: new Date(Number(row.expires)).toISOString(),
      visibility: 'bearer-link',
      snapshotDigest: fingerprint(json),
      snapshot: JSON.parse(json) as SharedSnapshot,
    };
  }
  revoke(id: string): void {
    this.db.prepare('DELETE FROM evaluation_shares WHERE id = ?').run(id);
  }
}

export function createEvaluationShareServer(store: EvaluationShareStore, adminToken: string) {
  if (adminToken.length < 32)
    throw new Error('Sharing requires an admin token of at least 32 characters');
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    const token = (request.headers.authorization ?? '').replace(/^Bearer /, '');
    const admin = timingSafeEqual(
      Buffer.from(fingerprint(token), 'hex'),
      Buffer.from(fingerprint(adminToken), 'hex'),
    );
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'POST' && url.pathname === '/api/shares') {
        if (!admin) {
          response.writeHead(401).end('Unauthorized');
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 256 * 1024) {
            response.writeHead(413).end('Snapshot too large');
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        const body = v.parse(
          v.strictObject({ snapshot: snapshotSchema, ttlSeconds: finite }),
          JSON.parse(Buffer.concat(chunks).toString()),
        );
        const published = store.publish(body.snapshot, body.ttlSeconds);
        response
          .writeHead(201, { 'Content-Type': 'application/json' })
          .end(JSON.stringify(published));
      } else if (/^\/api\/shares\/[a-f0-9]{32}$/.test(url.pathname)) {
        const id = url.pathname.split('/').at(-1)!;
        if (request.method === 'DELETE') {
          if (!admin) {
            response.writeHead(401).end('Unauthorized');
            return;
          }
          store.revoke(id);
          response.writeHead(204).end();
        } else if (request.method === 'GET') {
          const shared = store.read(id, token);
          if (!shared) {
            response.writeHead(404).end('Link unavailable, expired, or revoked');
            return;
          }
          response
            .writeHead(200, { 'Content-Type': 'application/json' })
            .end(JSON.stringify(shared));
        } else response.writeHead(405).end('Method not allowed');
      } else if (
        request.method === 'GET' &&
        (/^\/s\/[a-f0-9]{32}$/.test(url.pathname) ||
          url.pathname === '/shared.js' ||
          url.pathname === '/dashboard.css')
      ) {
        const asset = url.pathname.startsWith('/s/') ? 'shared.html' : url.pathname.slice(1);
        response.setHeader(
          'Content-Type',
          asset.endsWith('.js')
            ? 'text/javascript'
            : asset.endsWith('.css')
              ? 'text/css'
              : 'text/html',
        );
        response.end(await readFile(new URL(`./${asset}`, import.meta.url)));
      } else response.writeHead(404).end('Not found');
    } catch {
      response.writeHead(400).end('Invalid sharing request');
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
