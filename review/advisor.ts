import * as v from 'valibot';
import { findingSchema, type Finding } from './schema.ts';

export const advisorDecisionSchema = v.object({
  decision: v.picklist(['accept', 'revise', 'reject']),
  reason: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  finding: v.optional(findingSchema),
});

export type AdvisorDecision = v.InferOutput<typeof advisorDecisionSchema>;
export type AdvisorRunner = (finding: Finding, signal: AbortSignal) => Promise<unknown>;

/** A fail-closed gate: no candidate reaches publication without an accepted decision. */
export async function adviseFindings(options: {
  findings: Finding[];
  runner: AdvisorRunner;
  timeoutMs: number;
}): Promise<{ findings: Finding[]; decisions: AdvisorDecision[]; errors: string[] }> {
  const results = await Promise.all(
    options.findings.map(async (finding) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const raw = await Promise.race([
          options.runner(finding, controller.signal),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(new Error('advisor timed out')), {
              once: true,
            });
          }),
        ]);
        const parsed = v.safeParse(advisorDecisionSchema, raw);
        if (!parsed.success) return { finding: null, decision: null, error: 'advisor returned malformed output' };
        const decision = parsed.output;
        if (decision.decision === 'reject') return { finding: null, decision };
        return { finding: decision.finding ?? finding, decision };
      } catch {
        return { finding: null, decision: null, error: 'advisor failed or timed out' };
      } finally {
        clearTimeout(timeout);
      }
    }),
  );
  return {
    findings: results.flatMap((result) => (result.finding ? [result.finding] : [])),
    decisions: results.flatMap((result) => (result.decision ? [result.decision] : [])),
    errors: results.flatMap((result) => (result.error ? [result.error] : [])),
  };
}
