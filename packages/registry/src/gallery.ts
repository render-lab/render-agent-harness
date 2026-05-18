/**
 * Gallery: curated agents + capabilities the CLI (and future UI scaffolder)
 * offer as starting points.
 *
 * Two layers:
 *
 *   1. **Raw index** (`gallery/index.yaml`) — author-edited list of agent
 *      entries with relative paths. Validated by {@link GalleryIndexSchema}.
 *      Capabilities are *not* listed here; they're discovered by walking
 *      `packages/capabilities/*` (see {@link loadGalleryFromSource}).
 *
 *   2. **Resolved gallery** — each agent entry has its `render-harness.yaml`
 *      pre-parsed against {@link HarnessConfigSchema} and its README
 *      embedded, alongside the capability list. This is the shape both
 *      loaders return and the shape the bundle script serializes for
 *      distribution with the CLI.
 *
 * Two loaders share the resolved shape:
 *
 *   - {@link loadGalleryFromSource} — reads the live harness repo. Used by
 *     tests, the bundle script, and developers running the CLI with
 *     `--gallery <path>` against a checkout.
 *
 *   - {@link loadGalleryFromBundle} — reads a single pre-computed
 *     `gallery.json` produced by the bundle script. Used by the published
 *     CLI so `npx create-render-agent` works without cloning anything.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  flattenRuntimeKinds,
  type HarnessConfig,
  HarnessConfigSchema,
  SemverRangeSchema,
} from "./schema.js";

// ----------------------------------------------------------------------
// Raw index schema (gallery/index.yaml)
// ----------------------------------------------------------------------

const slugSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must match [a-z0-9][a-z0-9-]*");

const runtimeKindSchema = z.enum(["web", "worker", "cron", "workflows"]);
export type GalleryRuntimeKind = z.infer<typeof runtimeKindSchema>;

export const GalleryAgentEntrySchema = z
  .object({
    slug: slugSchema,
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(280),
    /** POSIX path relative to the gallery root, e.g. `./agents/support-bot`. */
    path: z
      .string()
      .min(1)
      .max(256)
      .regex(/^\.\/[\w./@-]+$/, "must be a relative POSIX path"),
    categories: z.array(slugSchema).max(20).optional(),
    /** Runtime kinds declared by the entry's render-harness.yaml. Cross-checked at load time. */
    runtimeKinds: z.array(runtimeKindSchema).min(1).max(4),
    /** Harness version range required by this gallery entry. */
    requiresHarness: SemverRangeSchema.optional(),
    /** npm package names of capability packs the entry pre-selects. */
    capabilities: z.array(z.string().min(1)).max(20).optional(),
    author: z.string().min(1).max(128).optional(),
  })
  .strict();

export type GalleryAgentEntryInput = z.infer<typeof GalleryAgentEntrySchema>;

export const GalleryIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    agents: z.array(GalleryAgentEntrySchema).superRefine((agents, ctx) => {
      const seen = new Map<string, number>();
      for (let i = 0; i < agents.length; i += 1) {
        const a = agents[i];
        if (!a) continue;
        if (seen.has(a.slug)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, "slug"],
            message: `duplicate gallery agent slug "${a.slug}" (first seen at index ${seen.get(a.slug)})`,
          });
        } else {
          seen.set(a.slug, i);
        }
      }
    }),
  })
  .strict();

export type GalleryIndex = z.infer<typeof GalleryIndexSchema>;

// ----------------------------------------------------------------------
// Resolved gallery (the shape callers actually consume)
// ----------------------------------------------------------------------

const galleryEntryKindSchema = z.enum(["agent", "bundle"]);
export type GalleryEntryKind = z.infer<typeof galleryEntryKindSchema>;

const ResolvedAgentEntrySchema = z
  .object({
    slug: slugSchema,
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(280),
    categories: z.array(slugSchema).max(20),
    runtimeKinds: z.array(runtimeKindSchema).min(1).max(4),
    requiresHarness: SemverRangeSchema.nullable(),
    capabilities: z.array(z.string().min(1)).max(20),
    author: z.string().min(1).max(128).nullable(),
    /**
     * Discriminator: "agent" for single-agent templates (wizard seeds
     * Answers, user customizes); "bundle" for sealed multi-agent
     * templates (wizard short-circuits, files materialize verbatim).
     */
    kind: galleryEntryKindSchema,
    /** Inlined render-harness.yaml (parsed + normalized to V2). */
    manifest: z.unknown(), // typed below
    /** README markdown for wizard preview, or null. */
    readme: z.string().nullable(),
    /**
     * Verbatim source files shipped with bundle templates. Keys are
     * relative POSIX paths under the entry root (e.g. `src/chat.ts`).
     * Empty for `kind: "agent"` entries — those generate sources via
     * the wizard's templated emit instead.
     */
    sourceFiles: z.record(z.string(), z.string()),
  })
  .strict();

const ResolvedCapabilityEntrySchema = z
  .object({
    /** npm package name. */
    pack: z.string().min(1),
    description: z.string().min(1),
    /** Display label for the wizard. */
    label: z.string().min(1),
    /** Hint shown next to the option, e.g. "EXA_API_KEY". */
    envHint: z.string().nullable(),
    /** npm version range to install for this capability. */
    versionRange: SemverRangeSchema.nullable(),
  })
  .strict();

export const ResolvedGallerySchema = z
  .object({
    schemaVersion: z.literal(1),
    agents: z.array(ResolvedAgentEntrySchema),
    capabilities: z.array(ResolvedCapabilityEntrySchema),
  })
  .strict();

export interface ResolvedAgentEntry {
  slug: string;
  name: string;
  description: string;
  categories: string[];
  runtimeKinds: GalleryRuntimeKind[];
  requiresHarness: string | null;
  capabilities: string[];
  author: string | null;
  kind: GalleryEntryKind;
  manifest: HarnessConfig;
  readme: string | null;
  sourceFiles: Record<string, string>;
}

export interface ResolvedCapabilityEntry {
  pack: string;
  description: string;
  label: string;
  envHint: string | null;
  versionRange: string | null;
}

export interface ResolvedGallery {
  schemaVersion: 1;
  agents: ResolvedAgentEntry[];
  capabilities: ResolvedCapabilityEntry[];
}

// ----------------------------------------------------------------------
// loadGalleryFromSource: walk a live harness checkout
// ----------------------------------------------------------------------

export interface LoadGalleryFromSourceOpts {
  /** Repo root containing `gallery/` and `packages/capabilities/`. */
  root: string;
  /** Override the capabilities directory. Defaults to `<root>/packages/capabilities`. */
  capabilitiesDir?: string;
}

export async function loadGalleryFromSource(
  opts: LoadGalleryFromSourceOpts,
): Promise<ResolvedGallery> {
  const galleryDir = join(opts.root, "gallery");
  const capabilitiesDir = opts.capabilitiesDir ?? join(opts.root, "packages", "capabilities");

  const indexText = await readFile(join(galleryDir, "index.yaml"), "utf8");
  const indexRaw = parseYaml(indexText);
  const index = GalleryIndexSchema.parse(indexRaw);

  const agents: ResolvedAgentEntry[] = [];
  for (const entry of index.agents) {
    const absPath = join(galleryDir, normalizeRelPath(entry.path));
    const manifestText = await readFile(join(absPath, "render-harness.yaml"), "utf8");
    const manifest = HarnessConfigSchema.parse(parseYaml(manifestText));

    // Cross-check: declared runtimeKinds must match the union across
    // all agents declared in the manifest.
    const manifestKinds = new Set(flattenRuntimeKinds(manifest));
    const declaredKinds = new Set(entry.runtimeKinds);
    if (
      manifestKinds.size !== declaredKinds.size ||
      [...manifestKinds].some((k) => !declaredKinds.has(k as GalleryRuntimeKind))
    ) {
      throw new Error(
        `gallery entry "${entry.slug}": runtimeKinds in index.yaml [${entry.runtimeKinds.join(", ")}] do not match render-harness.yaml union [${[...manifestKinds].join(", ")}]`,
      );
    }

    const readme = await readFileSafe(join(absPath, "README.md"));
    const kind = deriveEntryKind(manifest);
    // Single-agent gallery entries don't typically ship a src/ tree (they're
    // seed-templates around a builtin agent), but they CAN — kind: custom
    // agents reference a `./src/<id>.ts` entrypoint. Walking unconditionally
    // returns `{}` when there's no src/ directory, so it's safe either way.
    const sourceFiles = await collectEntrySources(absPath);

    agents.push({
      slug: entry.slug,
      name: entry.name,
      description: entry.description,
      categories: entry.categories ?? [],
      runtimeKinds: entry.runtimeKinds,
      requiresHarness: entry.requiresHarness ?? null,
      capabilities: entry.capabilities ?? [],
      author: entry.author ?? null,
      kind,
      manifest,
      readme,
      sourceFiles,
    });
  }

  const capabilities = await discoverCapabilities(capabilitiesDir);

  return { schemaVersion: 1, agents, capabilities };
}

// ----------------------------------------------------------------------
// loadGalleryFromBundle: read a pre-computed gallery.json
// ----------------------------------------------------------------------

export interface LoadGalleryFromBundleOpts {
  /** Absolute path to the bundled `gallery.json`. */
  path: string;
}

export async function loadGalleryFromBundle(
  opts: LoadGalleryFromBundleOpts,
): Promise<ResolvedGallery> {
  const text = await readFile(opts.path, "utf8");
  const raw = JSON.parse(text);
  const parsed = ResolvedGallerySchema.parse(raw);

  // The schema uses z.unknown() for manifest; coerce + validate via the
  // V2 schema. Bundled snapshots store V2-normalized manifests so this
  // is always a no-op pass-through for valid bundles.
  const agents = parsed.agents.map((a) => ({
    ...a,
    manifest: HarnessConfigSchema.parse(a.manifest),
  })) satisfies ResolvedAgentEntry[];

  return {
    schemaVersion: parsed.schemaVersion,
    agents,
    capabilities: parsed.capabilities,
  };
}

/**
 * Serialize a resolved gallery to the JSON shape `loadGalleryFromBundle`
 * reads. Used by the bundle script.
 */
export function serializeGallery(gallery: ResolvedGallery): string {
  return `${JSON.stringify(gallery, null, 2)}\n`;
}

// ----------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------

function normalizeRelPath(p: string): string {
  return p.replace(/^\.\//, "");
}

/**
 * "agent" when the entry has exactly one agent whose id matches the
 * bundle name (the wizard seeds Answers and the user customizes).
 * "bundle" otherwise: multiple agents or a renamed single agent that
 * the wizard should treat as a sealed template.
 */
function deriveEntryKind(manifest: HarnessConfig): GalleryEntryKind {
  if (manifest.agents.length !== 1) return "bundle";
  return manifest.agents[0]?.id === manifest.name ? "agent" : "bundle";
}

/**
 * Walk an entry directory and collect every file under `src/`. Used
 * by both `kind: "bundle"` entries (where the scaffolder copies sources
 * verbatim) and by `kind: "agent"` entries that happen to ship custom
 * source (rare; most reference a builtin). Skips dot-files, build
 * artifacts, and `node_modules` defensively. Returns `{}` when the
 * entry has no `src/` tree.
 */
async function collectEntrySources(absPath: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const srcRoot = join(absPath, "src");
  await walkDirectory(srcRoot, async (filePath) => {
    const relPosix = relative(absPath, filePath).split(sep).join("/");
    if (relPosix.startsWith("node_modules/")) return;
    if (relPosix.includes("/.")) return;
    out[relPosix] = await readFile(filePath, "utf8");
  });
  return out;
}

async function walkDirectory(
  dir: string,
  visit: (filePath: string) => Promise<void>,
): Promise<void> {
  let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === "dist") continue;
      await walkDirectory(full, visit);
    } else if (ent.isFile()) {
      await visit(full);
    }
  }
}

async function readFileSafe(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

interface CapabilityPackageJson {
  name?: string;
  description?: string;
  keywords?: string[];
  renderHarness?: {
    gallery?: {
      label?: string;
      envHint?: string;
    };
  };
}

async function discoverCapabilities(dir: string): Promise<ResolvedCapabilityEntry[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const caps: ResolvedCapabilityEntry[] = [];
  for (const name of entries.sort()) {
    const pkgPath = join(dir, name, "package.json");
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(pkgPath);
    } catch {
      continue;
    }
    if (!s.isFile()) continue;

    const text = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(text) as CapabilityPackageJson;
    if (!pkg.name || !pkg.keywords?.includes("render-harness-cap")) continue;

    caps.push({
      pack: pkg.name,
      description: pkg.description ?? "",
      label: pkg.renderHarness?.gallery?.label ?? deriveLabel(pkg.name),
      envHint: pkg.renderHarness?.gallery?.envHint ?? null,
      versionRange: null,
    });
  }
  return caps;
}

function deriveLabel(pkgName: string): string {
  // "@render-harness/cap-search-exa" → "Search exa"
  const tail = pkgName.split("/").pop() ?? pkgName;
  const trimmed = tail.replace(/^cap-/, "").replace(/-/g, " ");
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}
