import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SkillMetadata } from "./types.js";

/**
 * Skills follow Anthropic's pattern: SKILL.md files live in a directory; the
 * frontmatter (or first paragraph fallback) provides the name, description,
 * and a "when to use" hint. Metadata always lives in the system prompt; the
 * full content is loaded on demand via the {@link loadSkillContent} tool when
 * the model decides it needs it.
 *
 * Frontmatter shape:
 *
 *   ---
 *   name: my-skill
 *   description: One-liner about what this skill does.
 *   when_to_use: When the user asks about X or wants to do Y.
 *   ---
 *
 *   # Body of the skill...
 */

interface ParsedSkill {
  metadata: Omit<SkillMetadata, "contentPath">;
  body: string;
}

export async function loadSkillsFromDirectory(dir: string): Promise<SkillMetadata[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const skills: SkillMetadata[] = [];
  for (const entry of entries) {
    const candidate = join(dir, entry);
    const s = await stat(candidate).catch(() => null);
    if (!s) continue;
    if (s.isDirectory()) {
      const skill = await tryLoadSkillFile(join(candidate, "SKILL.md"));
      if (skill) skills.push(skill);
      continue;
    }
    if (s.isFile() && entry.toLowerCase() === "skill.md") {
      const skill = await tryLoadSkillFile(candidate);
      if (skill) skills.push(skill);
    }
  }
  return skills;
}

async function tryLoadSkillFile(path: string): Promise<SkillMetadata | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const parsed = parseSkill(raw, path);
  if (!parsed) return null;
  return { ...parsed.metadata, contentPath: path };
}

export function parseSkill(raw: string, path: string): ParsedSkill | null {
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (fmMatch) {
    const fm = parseFrontmatter(fmMatch[1] ?? "");
    const body = fmMatch[2] ?? "";
    const name = fm.name ?? deriveNameFromPath(path);
    const description = fm.description ?? extractFirstParagraph(body) ?? name;
    const whenToUse = fm.when_to_use ?? fm["when-to-use"] ?? description;
    return {
      metadata: { name, description, whenToUse },
      body,
    };
  }
  // No frontmatter; fall back to the first heading + first paragraph.
  const lines = raw.split(/\r?\n/);
  const heading = lines
    .find((l) => l.startsWith("# "))
    ?.slice(2)
    .trim();
  const name = heading ?? deriveNameFromPath(path);
  const description = extractFirstParagraph(raw) ?? name;
  return {
    metadata: { name, description, whenToUse: description },
    body: raw,
  };
}

function parseFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (!key) continue;
    out[key] = stripQuotes((value ?? "").trim());
  }
  return out;
}

function stripQuotes(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function extractFirstParagraph(body: string): string | null {
  const stripped = body.replace(/^#.*\r?\n/gm, "").trim();
  const para = stripped.split(/\r?\n\r?\n/)[0];
  return para?.trim() || null;
}

function deriveNameFromPath(path: string): string {
  const segs = path.split(/[\\/]/);
  const file = segs[segs.length - 1];
  if (file && file.toLowerCase() !== "skill.md") {
    return file.replace(/\.[^.]+$/, "");
  }
  const parent = segs[segs.length - 2];
  return parent ?? "skill";
}

/** Read the body of a previously-discovered skill. */
export async function loadSkillContent(skill: SkillMetadata): Promise<string> {
  const raw = await readFile(skill.contentPath, "utf8");
  const parsed = parseSkill(raw, skill.contentPath);
  return parsed?.body ?? raw;
}
