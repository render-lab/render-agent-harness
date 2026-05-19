/**
 * In-pack polling primitive for Granola.ai (no webhooks available
 * upstream as of 2026 Q2 — Granola docs explicitly say polling is
 * the only option for new-note detection).
 *
 * Per the wave-1 shipping plan Q3 = A: this stays in-pack for v1.
 * If a second consumer (cap-figma fallback, cap-email-inbound, etc.)
 * needs the same cron-list-diff-enqueue pattern, the Phase 8 retro
 * decides whether to extract `definePollingConnector` into
 * `@render-harness/registry`.
 *
 * Mechanism: agents call `granola.poll_recent({ since_minutes?, k? })`
 * from a recurring cron run. The tool:
 *
 *   1. Lists recent notes from Granola.
 *   2. For each note id, checks the `granola_seen_notes` table.
 *   3. INSERTs the new ones (idempotent on conflict).
 *   4. Returns the slice of new notes (id, title, attendees, summary)
 *      so the agent can act on each in the same run.
 *
 * Fan-out (one harness run per new note) is deferred — for now the
 * caller processes the returned list sequentially. With reasonable
 * cron cadence (e.g. every 15 min) the batch size stays small.
 */

import { getPool } from "@render-harness/core";
import { type GranolaApiError, granolaFetch } from "./lib.js";

export interface GranolaPollOpts {
  apiKey: string;
  /** Minutes back from now to query. Default 60. Capped at 7 * 24 * 60. */
  sinceMinutes?: number;
  /** Max notes to return. Default 25, max 50 (Granola's list page cap). */
  k?: number;
  signal?: AbortSignal;
}

export interface GranolaPollResult {
  newNotes: PolledNote[];
  totalSeen: number;
  totalNew: number;
}

export interface PolledNote {
  id: string;
  title?: string;
  summary?: string;
  startedAt?: string;
  endedAt?: string;
  attendees?: string[];
}

/**
 * Poll Granola for notes since `sinceMinutes` ago, mark new ones in
 * the `granola_seen_notes` table (created via the pack-level
 * migration runner), and return just the new notes for the agent to
 * act on.
 */
export async function pollRecentNotes(opts: GranolaPollOpts): Promise<GranolaPollResult> {
  const sinceMinutes = clampInt(opts.sinceMinutes ?? 60, 5, 7 * 24 * 60);
  const k = clampInt(opts.k ?? 25, 1, 50);
  const since = new Date(Date.now() - sinceMinutes * 60_000).toISOString();

  const listed = await listRecentNotes({
    apiKey: opts.apiKey,
    since,
    limit: k,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  if (listed.length === 0) {
    return { newNotes: [], totalSeen: 0, totalNew: 0 };
  }

  const pool = getPool();
  const ids = listed.map((n) => n.id);
  // One INSERT ... ON CONFLICT DO NOTHING per batch gets us the dedup
  // for free. The `xmax` trick from cap-memory-pg lets us figure out
  // which rows were freshly inserted.
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO granola_seen_notes (note_id)
     SELECT unnest($1::text[])
     ON CONFLICT (note_id) DO NOTHING
     RETURNING note_id AS id`,
    [ids],
  );
  const newIds = new Set(inserted.rows.map((r) => r.id));
  const newNotes = listed.filter((n) => newIds.has(n.id));

  return {
    newNotes,
    totalSeen: listed.length,
    totalNew: newNotes.length,
  };
}

interface GranolaListNotesArgs {
  apiKey: string;
  since?: string;
  limit?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

interface ListNotesResp {
  notes?: Array<{
    id?: string;
    title?: string;
    summary?: string;
    started_at?: string;
    ended_at?: string;
    attendees?: Array<{ name?: string; email?: string }>;
  }>;
}

export async function listRecentNotes(args: GranolaListNotesArgs): Promise<PolledNote[]> {
  try {
    const res = await granolaFetch<ListNotesResp>({
      apiKey: args.apiKey,
      path: "/notes",
      query: {
        ...(args.since ? { since: args.since } : {}),
        limit: args.limit ?? 25,
      },
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
    });
    return (res.notes ?? [])
      .filter((n): n is { id: string } & typeof n => typeof n?.id === "string")
      .map((n) => ({
        id: n.id,
        ...(n.title ? { title: n.title } : {}),
        ...(n.summary ? { summary: n.summary } : {}),
        ...(n.started_at ? { startedAt: n.started_at } : {}),
        ...(n.ended_at ? { endedAt: n.ended_at } : {}),
        ...(n.attendees
          ? {
              attendees: n.attendees
                .map((a) => a?.name ?? a?.email)
                .filter((s): s is string => typeof s === "string" && s.length > 0),
            }
          : {}),
      }));
  } catch (err) {
    // Don't translate to a tool-result here; pollRecentNotes is called
    // from the tool handler which does the format step.
    throw err as GranolaApiError;
  }
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.floor(v)));
}
