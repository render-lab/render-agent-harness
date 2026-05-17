/**
 * cap-filesystem — path-scoped filesystem tools for the agent.
 *
 * Provides four tools, all hard-scoped to a configured `root` directory:
 *
 *   - `fs.read_file({ path })`        — read a UTF-8 text file.
 *   - `fs.list_dir({ path })`         — list a directory's entries.
 *   - `fs.write_file({ path, content })` — write a file (creates parents).
 *   - `fs.delete_file({ path })`      — delete a file.
 *
 * Tool names get prefixed with the pack name on registration, so the
 * model sees them as `cap-filesystem.fs.read_file` etc.
 *
 * Why this is NOT a core builtin: the production worker pserv is
 * multi-tenant. Filesystem access on a process holding every tenant's
 * env vars and disk-mounted user data is unsafe by default. This pack
 * makes it explicit and per-agent: you opt in, you choose the root, and
 * you decide whether writes are allowed.
 *
 * Usage in render-harness.yaml:
 *
 *   capabilities:
 *     - pack: "@render-harness/cap-filesystem"
 *       config:
 *         root: "/var/data/agent-workspace"   # required; absolute path
 *         readOnly: false                     # optional; default false
 *         maxBytes: 1048576                   # optional read/write cap
 *
 * Path scoping enforces:
 *   - Inputs are joined to root and resolved.
 *   - The resolved path must remain under root (`..` traversal blocked).
 *   - Symlinks are followed via realpath and re-checked against root, so
 *     a symlink under root pointing at /etc/passwd cannot escape.
 */

import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep, dirname as urlDirname, join as urlJoin } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalToolHandler, SkillMetadata } from "@render-harness/core";
import { definePack, type PackContext } from "@render-harness/registry";
import pkg from "../package.json" with { type: "json" };

const HERE = urlDirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = urlJoin(HERE, "..", "skills");

interface FsConfig {
  root?: string;
  readOnly?: boolean;
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 1_048_576; // 1 MB

const pack = definePack({
  name: "cap-filesystem",
  version: pkg.version,
  envSchema: [],
  async localTools(ctx: PackContext): Promise<LocalToolHandler[]> {
    const cfg = (ctx.config ?? {}) as FsConfig;
    if (!cfg.root || typeof cfg.root !== "string") {
      throw new Error(
        "cap-filesystem: `config.root` is required (absolute path the agent can read/write).",
      );
    }
    // Resolve symlinks on the root once so subsequent realpath() checks of
    // children can be compared apples-to-apples. On macOS in particular,
    // /var → /private/var, and without this every legit path would look
    // like a symlink-escape.
    const resolvedRoot = resolve(cfg.root);
    let root: string;
    try {
      root = await realpath(resolvedRoot);
    } catch {
      // If the root doesn't exist yet, fall back to the literal path. The
      // tools will still try realpath on each access; once the dir gets
      // created the comparison will work.
      root = resolvedRoot;
    }
    const readOnly = cfg.readOnly === true;
    const maxBytes = clampPositive(cfg.maxBytes, DEFAULT_MAX_BYTES);

    const tools: LocalToolHandler[] = [readFileTool(root, maxBytes), listDirTool(root)];
    if (!readOnly) {
      tools.push(writeFileTool(root, maxBytes), deleteFileTool(root));
    }
    return tools;
  },
  skills(_ctx: PackContext): SkillMetadata[] {
    return [
      {
        name: "filesystem",
        description: "Use the path-scoped filesystem tools to read, list, write, and delete files.",
        whenToUse:
          "When the user asks you to inspect, edit, or save files. All paths are scoped to a configured root; you cannot escape it.",
        contentPath: urlJoin(SKILLS_DIR, "filesystem.md"),
      },
    ];
  },
});

export default pack;

// --------------------------------------------------------------------
// Path scoping
// --------------------------------------------------------------------

interface ResolveOk {
  ok: true;
  abs: string;
}
interface ResolveErr {
  ok: false;
  message: string;
}
type ResolveResult = ResolveOk | ResolveErr;

function resolveScoped(root: string, requested: string): ResolveResult {
  if (typeof requested !== "string" || requested.length === 0) {
    return { ok: false, message: "path must be a non-empty string" };
  }
  // Normalize and join. resolve() collapses `..` segments deterministically.
  const joined = resolve(root, requested);
  if (!isUnder(joined, root)) {
    return { ok: false, message: `path "${requested}" escapes the configured root` };
  }
  return { ok: true, abs: joined };
}

function isUnder(child: string, parent: string): boolean {
  const rel = parent.endsWith(sep) ? parent : parent + sep;
  return child === parent || child.startsWith(rel);
}

/**
 * Resolve symlinks and re-check the result is still under root. Used after
 * a successful read or before an existing-file write — a symlink under
 * root pointing at /etc/passwd otherwise escapes the scope.
 */
async function realpathScoped(root: string, abs: string): Promise<ResolveResult> {
  let real: string;
  try {
    real = await realpath(abs);
  } catch (err) {
    if (isNotFound(err)) {
      // For writes against new files, realpath fails — caller must check
      // the parent dir instead. Surface a sentinel.
      return { ok: false, message: "ENOENT" };
    }
    return { ok: false, message: (err as Error).message };
  }
  if (!isUnder(real, root)) {
    return { ok: false, message: `symlink target "${real}" escapes the configured root` };
  }
  return { ok: true, abs: real };
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

// --------------------------------------------------------------------
// Tools
// --------------------------------------------------------------------

function readFileTool(root: string, maxBytes: number): LocalToolHandler {
  return {
    definition: {
      name: "fs.read_file",
      description: `Read a UTF-8 text file under the configured root. Returns the file contents (capped at ${maxBytes} bytes).`,
      source: "pack:cap-filesystem",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            description: "Path relative to (or absolute under) the configured root.",
          },
        },
        required: ["path"],
      },
    },
    handler: async ({ input }) => {
      const path = (input as { path?: string } | null)?.path ?? "";
      const r = resolveScoped(root, path);
      if (!r.ok) return { content: `fs.read_file: ${r.message}`, isError: true };

      const real = await realpathScoped(root, r.abs);
      if (!real.ok) {
        if (real.message === "ENOENT") {
          return { content: `fs.read_file: file not found: ${path}`, isError: true };
        }
        return { content: `fs.read_file: ${real.message}`, isError: true };
      }

      try {
        const buf = await readFile(real.abs);
        if (buf.byteLength > maxBytes) {
          const truncated = buf.subarray(0, maxBytes).toString("utf8");
          return {
            content: `${truncated}\n\n[... truncated at ${maxBytes} bytes; full file was ${buf.byteLength} bytes ...]`,
          };
        }
        return { content: buf.toString("utf8") };
      } catch (err) {
        return {
          content: `fs.read_file: ${(err as Error).message}`,
          isError: true,
        };
      }
    },
  };
}

function listDirTool(root: string): LocalToolHandler {
  return {
    definition: {
      name: "fs.list_dir",
      description: "List entries in a directory under the configured root.",
      source: "pack:cap-filesystem",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            description: "Path relative to the configured root. Use '.' for root itself.",
          },
        },
      },
    },
    handler: async ({ input }) => {
      const path = (input as { path?: string } | null)?.path ?? ".";
      const r = resolveScoped(root, path);
      if (!r.ok) return { content: `fs.list_dir: ${r.message}`, isError: true };

      const real = await realpathScoped(root, r.abs);
      if (!real.ok) {
        if (real.message === "ENOENT") {
          return { content: `fs.list_dir: directory not found: ${path}`, isError: true };
        }
        return { content: `fs.list_dir: ${real.message}`, isError: true };
      }

      try {
        const entries = await readdir(real.abs, { withFileTypes: true });
        if (entries.length === 0) return { content: "(empty directory)" };
        const lines = await Promise.all(
          entries.map(async (e) => {
            const full = join(real.abs, e.name);
            const kind = e.isDirectory()
              ? "dir"
              : e.isSymbolicLink()
                ? "link"
                : e.isFile()
                  ? "file"
                  : "other";
            if (kind === "file") {
              try {
                const s = await stat(full);
                return `${kind}\t${e.name}\t${s.size}b`;
              } catch {
                return `${kind}\t${e.name}`;
              }
            }
            return `${kind}\t${e.name}`;
          }),
        );
        return { content: lines.join("\n") };
      } catch (err) {
        return { content: `fs.list_dir: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

function writeFileTool(root: string, maxBytes: number): LocalToolHandler {
  return {
    definition: {
      name: "fs.write_file",
      description: `Write a UTF-8 text file under the configured root. Creates parent directories. Cap: ${maxBytes} bytes.`,
      source: "pack:cap-filesystem",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Path relative to the configured root." },
          content: { type: "string", description: "File content (UTF-8)." },
        },
        required: ["path", "content"],
      },
    },
    handler: async ({ input }) => {
      const args = (input ?? {}) as { path?: string; content?: string };
      if (!args.path || typeof args.path !== "string") {
        return { content: "fs.write_file: missing `path`", isError: true };
      }
      if (typeof args.content !== "string") {
        return { content: "fs.write_file: missing `content` (must be a string)", isError: true };
      }
      if (Buffer.byteLength(args.content, "utf8") > maxBytes) {
        return {
          content: `fs.write_file: content exceeds cap of ${maxBytes} bytes`,
          isError: true,
        };
      }

      const r = resolveScoped(root, args.path);
      if (!r.ok) return { content: `fs.write_file: ${r.message}`, isError: true };

      // If the file already exists, follow symlinks and re-check.
      // For new files, check the parent directory.
      const existing = await realpathScoped(root, r.abs);
      let target = r.abs;
      if (existing.ok) {
        target = existing.abs;
      } else if (existing.message !== "ENOENT") {
        return { content: `fs.write_file: ${existing.message}`, isError: true };
      } else {
        const parent = await realpathScoped(root, dirname(r.abs));
        if (!parent.ok && parent.message !== "ENOENT") {
          return { content: `fs.write_file: ${parent.message}`, isError: true };
        }
      }

      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, args.content, "utf8");
        return {
          content: `fs.write_file: wrote ${Buffer.byteLength(args.content, "utf8")} bytes to ${args.path}`,
        };
      } catch (err) {
        return { content: `fs.write_file: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

function deleteFileTool(root: string): LocalToolHandler {
  return {
    definition: {
      name: "fs.delete_file",
      description: "Delete a file under the configured root. Refuses to delete directories.",
      source: "pack:cap-filesystem",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Path relative to the configured root." },
        },
        required: ["path"],
      },
    },
    handler: async ({ input }) => {
      const path = (input as { path?: string } | null)?.path ?? "";
      const r = resolveScoped(root, path);
      if (!r.ok) return { content: `fs.delete_file: ${r.message}`, isError: true };

      const real = await realpathScoped(root, r.abs);
      if (!real.ok) {
        if (real.message === "ENOENT") {
          return { content: `fs.delete_file: file not found: ${path}`, isError: true };
        }
        return { content: `fs.delete_file: ${real.message}`, isError: true };
      }

      try {
        const s = await stat(real.abs);
        if (s.isDirectory()) {
          return {
            content: `fs.delete_file: refusing to delete directory: ${path}`,
            isError: true,
          };
        }
        await rm(real.abs);
        return { content: `fs.delete_file: deleted ${path}` };
      } catch (err) {
        return { content: `fs.delete_file: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

function clampPositive(raw: number | undefined, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.floor(raw);
}
