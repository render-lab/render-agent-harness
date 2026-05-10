/**
 * Tiny shared helpers.
 */

type StripUndefined<T> = { [K in keyof T]: Exclude<T[K], undefined> };

/**
 * Return a shallow copy of `obj` with all `undefined` values removed.
 * The return type strips `undefined` from every property union so it
 * satisfies `exactOptionalPropertyTypes: true` consumers downstream.
 *
 * Used to bridge Zod's "optional fields are T | undefined" inference
 * with @render-harness/core's strict-optional types.
 */
export function dropUndefined<T extends Record<string, unknown>>(obj: T): StripUndefined<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as StripUndefined<T>;
}
