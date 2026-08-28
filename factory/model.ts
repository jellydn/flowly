import { createProviderClient, type ModelCallFn } from '../eval/bench/providers.ts';

/** Resolve the configured provider/model specifier used by every factory stage. */
export function createFactoryModelCall(
  model: string,
  env: Record<string, string | undefined>,
): ModelCallFn {
  const separator = model.indexOf('/');
  if (separator <= 0 || separator === model.length - 1) {
    throw new Error(`Factory model must include provider/model (got "${model}").`);
  }
  return createProviderClient(
    { provider: model.slice(0, separator), id: model.slice(separator + 1) },
    env,
  );
}
