/**
 * Optional model-backed red-team scenarios. They are not imported by `npm test`
 * or `npm run check`. Deterministic enforcement tests live in
 * `tests/factory-safety.test.ts` and must remain provider-free.
 */
export const LIVE_FACTORY_RED_TEAM = {
  enabled: false,
  reason: 'Live adversarial model runs are slower and non-deterministic.',
} as const;
