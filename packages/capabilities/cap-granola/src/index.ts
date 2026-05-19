/**
 * @render-harness/cap-granola
 *
 * Granola.ai meeting-notes pack. First **API-key + polling** pack
 * in the wave-1 family — no OAuth in v1 (Granola's official auth is
 * bearer API keys; their OAuth flow via WorkOS is documented only
 * via reverse-engineering and not stable). No webhooks either —
 * Granola explicitly says polling is the only option for new-note
 * detection.
 *
 * Three tools, all read-only against the user's Granola account:
 *
 *   - `granola.list_notes`   — paginated list by date range
 *   - `granola.read_note`    — full transcript + summary + action items
 *   - `granola.poll_recent`  — list-and-dedup against granola_seen_notes,
 *                              returns just the new notes so a recurring
 *                              cron run can process meetings as they land
 *
 * The seen-notes table is created via the pack's `migrations` slot
 * (the second real consumer of the boot-time runner from
 * @render-harness/core@0.6.0). Pack authors don't need to apply this
 * by hand — the runtime adapter does it at boot.
 *
 * Usage in render-harness.yaml:
 *
 *   capabilities:
 *     - pack: "@render-harness/cap-granola"
 *       config:
 *         keyType: personal       # or "enterprise"
 *         apiKeyEnv: GRANOLA_API_KEY
 *
 *   agents:
 *     - id: meeting-notes-cron
 *       runtimes:
 *         - kind: cron
 *           schedule: "*\/15 * * * *"   # poll every 15 minutes
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalToolHandler, MigrationFile, SkillMetadata } from "@render-harness/core";
import { definePack, type PackContext } from "@render-harness/registry";
import pkg from "../package.json" with { type: "json" };
import { granolaTools } from "./tools.js";

export { formatGranolaError, granolaFetch } from "./lib.js";
export { listRecentNotes, pollRecentNotes } from "./poll.js";

type KeyType = "personal" | "enterprise";

interface ResolvedGranolaConfig {
  apiKeyEnv: string;
  keyType: KeyType;
}

const DEFAULT_API_KEY_ENV = "GRANOLA_API_KEY";

const SEEN_NOTES_SQL = `
CREATE TABLE IF NOT EXISTS granola_seen_notes (
  note_id text PRIMARY KEY,
  first_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS granola_seen_notes_first_seen_idx
  ON granola_seen_notes (first_seen_at);
`;

const pack = definePack({
  name: "cap-granola",
  version: pkg.version,
  envSchema: [
    {
      name: DEFAULT_API_KEY_ENV,
      required: true,
      secret: true,
      description:
        "Granola API key. Personal API keys are Beta — get one at https://app.granola.ai/settings/api-keys (Business or Enterprise plan required). Enterprise API keys are minted by workspace admins for org-wide access.",
    },
    {
      name: "GRANOLA_KEY_TYPE",
      required: false,
      secret: false,
      description:
        "personal | enterprise — affects which notes are accessible. Default personal. Override per-pack via the `keyType` config key.",
    },
  ],
  migrations(_ctx: PackContext): MigrationFile[] {
    return [{ id: "0001_seen_notes", sql: SEEN_NOTES_SQL }];
  },
  localTools(ctx: PackContext): LocalToolHandler[] {
    const cfg = readConfig(ctx.config);
    const apiKey = ctx.env(cfg.apiKeyEnv);
    if (!apiKey) {
      // Skip tool registration when the key is unset — matches
      // cap-search-exa's safe default. The warn surfaces the issue
      // without crashing every agent in the bundle.
      console.warn(
        `cap-granola: env var ${cfg.apiKeyEnv} is not set; skipping tool registration. Set it to enable Granola tools.`,
      );
      return [];
    }
    return granolaTools({ apiKey });
  },
  skills(_ctx: PackContext): SkillMetadata[] {
    const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
    return [
      {
        name: "granola-notes",
        description:
          "List and read Granola meeting notes; use poll_recent on a cron schedule to detect new meetings.",
        whenToUse:
          "When the user asks about a meeting, asks you to summarize recent meetings, or when this run was kicked off by a recurring cron to ingest new notes.",
        contentPath: join(SKILLS_DIR, "granola-notes.md"),
      },
    ];
  },
});

export default pack;

function readConfig(raw: Record<string, unknown>): ResolvedGranolaConfig {
  const apiKeyEnv =
    typeof raw.apiKeyEnv === "string" && raw.apiKeyEnv.length > 0
      ? raw.apiKeyEnv
      : DEFAULT_API_KEY_ENV;
  const keyType: KeyType = raw.keyType === "enterprise" ? "enterprise" : "personal";
  return { apiKeyEnv, keyType };
}
