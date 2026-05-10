/**
 * Tiny string interpolator. Replaces `${VAR}` and `${VAR:-default}` in a
 * string with values from a lookup function.
 *
 * Used for resolving env vars in YAML strings (MCP server headers,
 * stdio command env vars, etc.) without dragging in dotenv-expand.
 *
 * Behavior:
 *   - `${FOO}` → lookup("FOO"); throws if undefined.
 *   - `${FOO:-fallback}` → lookup("FOO") if defined, else "fallback".
 *   - `\${FOO}` → literal `${FOO}` (no expansion).
 */

export type EnvLookup = (name: string) => string | undefined;

const VAR_PATTERN = /(\\)?\$\{([A-Z][A-Z0-9_]*)(:-([^}]*))?\}/g;

export interface InterpolateOpts {
  /** Required vars that resolve to undefined throw with this prefix. */
  errorPrefix?: string;
}

export function interpolate(input: string, lookup: EnvLookup, opts: InterpolateOpts = {}): string {
  const errorPrefix = opts.errorPrefix ?? "interpolate";
  return input.replace(VAR_PATTERN, (match, escape, name, _maybe, fallback) => {
    if (escape === "\\") {
      // Strip the backslash and pass through literally.
      return match.slice(1);
    }
    const value = lookup(name);
    if (value !== undefined) return value;
    if (fallback !== undefined) return fallback;
    throw new Error(`${errorPrefix}: missing required env var ${name}`);
  });
}

/**
 * Recursively walks an object/array tree, calling `interpolate` on every
 * string. Returns a new tree; the input is not mutated. Records (plain
 * objects without prototypes) and arrays are traversed; everything else
 * is returned as-is.
 */
export function interpolateTree<T>(tree: T, lookup: EnvLookup, opts?: InterpolateOpts): T {
  return walk(tree, lookup, opts) as T;
}

function walk(value: unknown, lookup: EnvLookup, opts?: InterpolateOpts): unknown {
  if (typeof value === "string") return interpolate(value, lookup, opts);
  if (Array.isArray(value)) return value.map((v) => walk(v, lookup, opts));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, lookup, opts);
    return out;
  }
  return value;
}
