/**
 * Benchmark report persistence. Reports are stored as JSON files so results
 * can survive across runs, power leaderboards and regression checks.
 *
 * A store is pluggable: in-memory for tests and single CLI invocations, or
 * file-backed for persistent leaderboards. The file store names reports
 * `<suiteId>/<runId>.json` inside a results directory.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BenchmarkReport, LeaderboardEntry } from './types.ts';

export interface BenchmarkStore {
  save(report: BenchmarkReport): Promise<void>;
  load(runId: string): Promise<BenchmarkReport | null>;
  /** All saved reports, newest first. */
  list(): Promise<BenchmarkReport[]>;
  /** Leaderboard rows across all saved reports, best quality first. */
  leaderboard(suiteId?: string): Promise<LeaderboardEntry[]>;
}

/** In-memory store. Sufficient for tests and one-shot CLI runs. */
export function createMemoryBenchmarkStore(): BenchmarkStore {
  const reports = new Map<string, BenchmarkReport>();
  return {
    async save(report: BenchmarkReport): Promise<void> {
      reports.set(report.runId, report);
    },
    async load(runId: string): Promise<BenchmarkReport | null> {
      return reports.get(runId) ?? null;
    },
    async list(): Promise<BenchmarkReport[]> {
      return [...reports.values()].sort((a, b) => b.ranAt.localeCompare(a.ranAt));
    },
    async leaderboard(suiteId?: string): Promise<LeaderboardEntry[]> {
      return toLeaderboard(await this.list(), suiteId);
    },
  };
}

/**
 * File-backed store that persists reports as JSON under a results directory.
 * Creating a new store instance re-reads the directory, so a restarted
 * process sees previously saved reports.
 */
export function createFileBenchmarkStore(resultsDir: string): BenchmarkStore {
  async function reportPath(runId: string, suiteId: string): Promise<string> {
    const dir = path.join(resultsDir, suiteId);
    await mkdir(dir, { recursive: true });
    return path.join(dir, `${runId}.json`);
  }

  return {
    async save(report: BenchmarkReport): Promise<void> {
      const file = await reportPath(report.runId, report.suiteId);
      await writeFile(file, JSON.stringify(report, null, 2), 'utf8');
    },
    async load(runId: string): Promise<BenchmarkReport | null> {
      const matches = await this.list();
      return matches.find((r) => r.runId === runId) ?? null;
    },
    async list(): Promise<BenchmarkReport[]> {
      let suiteDirs: string[] = [];
      try {
        suiteDirs = await readdir(resultsDir, { withFileTypes: true })
          .then((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name));
      } catch {
        return []; // Missing results dir: no reports yet.
      }
      const reports: BenchmarkReport[] = [];
      for (const suiteDir of suiteDirs) {
        let files: string[] = [];
        try {
          files = await readdir(path.join(resultsDir, suiteDir));
        } catch {
          continue;
        }
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          try {
            const text = await readFile(path.join(resultsDir, suiteDir, file), 'utf8');
            reports.push(JSON.parse(text) as BenchmarkReport);
          } catch {
            // Corrupt report file: skip rather than fail the whole listing.
          }
        }
      }
      return reports.sort((a, b) => b.ranAt.localeCompare(a.ranAt));
    },
    async leaderboard(suiteId?: string): Promise<LeaderboardEntry[]> {
      return toLeaderboard(await this.list(), suiteId);
    },
  };
}

function toLeaderboard(reports: BenchmarkReport[], suiteId?: string): LeaderboardEntry[] {
  const rows: LeaderboardEntry[] = [];
  for (const report of reports) {
    if (suiteId && report.suiteId !== suiteId) continue;
    rows.push({
      modelId: report.model.id,
      modelLabel: report.model.label,
      provider: report.model.provider,
      suiteId: report.suiteId,
      runId: report.runId,
      ranAt: report.ranAt,
      qualityScore: report.summary.qualityScore,
      avgLatencyMs: report.summary.avgLatencyMs,
      totalTokens: report.summary.totalTokens,
      costUsd: report.summary.costUsd,
      toolSuccessRate: report.summary.toolSuccessRate,
    });
  }
  return rows.sort((a, b) => b.qualityScore - a.qualityScore);
}
