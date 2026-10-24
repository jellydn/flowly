import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { computeSummary, evaluateBenchmarkRegression } from './metrics.ts';
import type { BenchmarkStore } from './store.ts';
import type { BenchmarkReport } from './types.ts';

/** Project fields explicitly: model configuration and future report fields stay private. */
export function dashboardReport(report: BenchmarkReport, secrets: string[] = []) {
  const clean = (value: string): string => {
    let text = value.replace(/(?:sk-|gh[pousr]_|github_pat_)[\w-]+/g, '[redacted]');
    for (const secret of secrets)
      if (secret.length >= 8) text = text.split(secret).join('[redacted]');
    return text;
  };
  return {
    runId: clean(report.runId),
    suiteId: clean(report.suiteId),
    model: clean(report.model.id),
    ranAt: clean(report.ranAt),
    mode: report.mode,
    judge: clean(report.judge ?? 'keyword'),
    lineage:
      report.lineage &&
      /^[a-f0-9]{64}$/.test(report.lineage.suiteDigest) &&
      /^[a-f0-9]{64}$/.test(report.lineage.repositoryDigest)
        ? {
            suiteDigest: report.lineage.suiteDigest,
            repositoryDigest: report.lineage.repositoryDigest,
          }
        : undefined,
    failed: report.results.filter((result) => !result.passed).length,
    summary: computeSummary(report.results),
    results: report.results.map((result) => ({
      id: clean(result.id),
      workload: result.workloadType ?? 'repository-question',
      passed: result.passed,
      quality: result.metrics.qualityScore,
      latency: result.metrics.latencyMs,
      tokens: result.metrics.tokensIn + result.metrics.tokensOut,
      cost: result.metrics.costUsd,
      tools: result.metrics.toolSuccess.passed,
      patch: result.metrics.patchApplicability?.passed ?? null,
      human: result.metrics.humanAccepted ?? null,
      evidence: clean(
        JSON.stringify(
          {
            answer: result.answer,
            sources: result.citedSources,
            tools: result.toolsUsed,
            errors: result.errors,
            rationale: result.judgeRationale,
          },
          null,
          2,
        ),
      ),
    })),
  };
}

export function createEvaluationDashboard(
  store: BenchmarkStore,
  options: { secrets?: string[]; allowedHost?: string } = {},
): Server {
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    const host = request.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) && host !== options.allowedHost) {
      response.writeHead(403).end('Host not allowed');
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' }).end('Read-only dashboard');
      return;
    }
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/api/reports') {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify(
            (await store.list()).map((report) => dashboardReport(report, options.secrets)),
          ),
        );
      } else if (url.pathname === '/api/regression') {
        const baseline = await store.load(url.searchParams.get('baseline') ?? '');
        const candidate = await store.load(url.searchParams.get('candidate') ?? '');
        if (!baseline || !candidate) {
          response.writeHead(404).end('Report not found');
          return;
        }
        try {
          const result = evaluateBenchmarkRegression(baseline, candidate);
          response.setHeader('Content-Type', 'application/json');
          response.end(
            JSON.stringify({
              passed: result.passed,
              regressedScenarioIds: dashboardReport(candidate, options.secrets)
                .results.filter((_, index) =>
                  result.regressedScenarioIds.includes(candidate.results[index].id),
                )
                .map((scenario) => scenario.id),
            }),
          );
        } catch {
          response
            .writeHead(409)
            .end('Not comparable: suite, corpus, mode, judge, and scenarios must match.');
        }
      } else {
        const assets: Record<string, string> = {
          '/': 'dashboard.html',
          '/dashboard.js': 'dashboard.js',
          '/dashboard.css': 'dashboard.css',
        };
        const asset = assets[url.pathname];
        if (!asset) {
          response.writeHead(404).end('Not found');
          return;
        }
        const mime = asset.endsWith('.js')
          ? 'text/javascript'
          : asset.endsWith('.css')
            ? 'text/css'
            : 'text/html';
        response.setHeader('Content-Type', `${mime}; charset=utf-8`);
        response.end(await readFile(new URL(`./${asset}`, import.meta.url)));
      }
    } catch {
      response.writeHead(500).end('Could not read evaluation reports');
    }
  });
}
