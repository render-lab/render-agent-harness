import type { LocalToolHandler } from "@render-harness/core";
import { formatGranolaError, granolaFetch } from "./lib.js";
import { pollRecentNotes } from "./poll.js";

export function granolaTools(opts: { apiKey: string }): LocalToolHandler[] {
  return [listNotes(opts), readNote(opts), pollRecent(opts)];
}

function listNotes(opts: { apiKey: string }): LocalToolHandler {
  return {
    definition: {
      name: "list_notes",
      description:
        "List accessible Granola meeting notes, optionally filtered by date range. Returns id, title, started_at, ended_at, attendees, and a short summary per note. Use read_note to fetch the full transcript + summary for a specific note.",
      source: "pack:cap-granola",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          since: {
            type: "string",
            description: "ISO-8601 timestamp; only notes started_at >= since are returned.",
          },
          until: {
            type: "string",
            description: "ISO-8601 timestamp; only notes started_at <= until are returned.",
          },
          limit: {
            type: "integer",
            description: "Max notes to return. Default 25, max 50.",
            minimum: 1,
            maximum: 50,
          },
          page_token: {
            type: "string",
            description: "Pagination cursor from a previous response.",
          },
        },
      },
    },
    async handler({ input, signal }) {
      const args = (input ?? {}) as {
        since?: string;
        until?: string;
        limit?: number;
        page_token?: string;
      };
      try {
        const res = await granolaFetch<{
          notes?: Array<{
            id?: string;
            title?: string;
            summary?: string;
            started_at?: string;
            ended_at?: string;
            attendees?: Array<{ name?: string; email?: string }>;
          }>;
          next_page_token?: string;
        }>({
          apiKey: opts.apiKey,
          path: "/notes",
          query: {
            ...(args.since ? { since: args.since } : {}),
            ...(args.until ? { until: args.until } : {}),
            limit: args.limit ?? 25,
            ...(args.page_token ? { page_token: args.page_token } : {}),
          },
          ...(signal ? { signal } : {}),
        });
        const notes = res.notes ?? [];
        if (notes.length === 0) {
          return { content: "granola.list_notes: no notes in this range" };
        }
        const lines = notes.map((n, i) => {
          const attendees = (n.attendees ?? [])
            .map((a) => a?.name ?? a?.email)
            .filter((s): s is string => typeof s === "string" && s.length > 0)
            .join(", ");
          return `${i + 1}. id=${n.id}  ${n.title ?? "(untitled)"}\n   when: ${n.started_at ?? "?"} → ${n.ended_at ?? "?"}\n   attendees: ${attendees || "(none)"}\n   summary: ${(n.summary ?? "").slice(0, 240)}`;
        });
        const footer = res.next_page_token
          ? `\n\n(more available; pass page_token=${res.next_page_token})`
          : "";
        return { content: lines.join("\n\n") + footer };
      } catch (err) {
        return formatGranolaError("granola.list_notes", err);
      }
    },
  };
}

function readNote(opts: { apiKey: string }): LocalToolHandler {
  return {
    definition: {
      name: "read_note",
      description:
        "Fetch one Granola meeting note by id and return the title, full transcript, summary, action items, and attendee list. Set include_transcript: false to skip the (often long) transcript and just get the structured summary.",
      source: "pack:cap-granola",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          note_id: { type: "string", description: "Granola note id.", minLength: 1 },
          include_transcript: {
            type: "boolean",
            description: "Include the full transcript text. Default true.",
          },
        },
        required: ["note_id"],
      },
    },
    async handler({ input, signal }) {
      const args = (input ?? {}) as { note_id?: string; include_transcript?: boolean };
      if (!args.note_id) {
        return { content: "granola.read_note: note_id is required", isError: true };
      }
      try {
        const note = await granolaFetch<{
          id?: string;
          title?: string;
          summary?: string;
          transcript?: string;
          action_items?: Array<{ text?: string; assignee?: string; done?: boolean }>;
          attendees?: Array<{ name?: string; email?: string }>;
          started_at?: string;
          ended_at?: string;
        }>({
          apiKey: opts.apiKey,
          path: `/notes/${encodeURIComponent(args.note_id)}`,
          ...(signal ? { signal } : {}),
        });
        const parts: string[] = [];
        parts.push(`# ${note.title ?? "(untitled)"}`);
        if (note.started_at) parts.push(`when: ${note.started_at} → ${note.ended_at ?? "?"}`);
        const attendees = (note.attendees ?? [])
          .map((a) => a?.name ?? a?.email)
          .filter((s): s is string => typeof s === "string" && s.length > 0);
        if (attendees.length) parts.push(`attendees: ${attendees.join(", ")}`);
        if (note.summary) {
          parts.push("");
          parts.push("## summary");
          parts.push(note.summary);
        }
        if (note.action_items && note.action_items.length > 0) {
          parts.push("");
          parts.push("## action items");
          for (const a of note.action_items) {
            const tick = a.done ? "[x]" : "[ ]";
            const owner = a.assignee ? ` (${a.assignee})` : "";
            parts.push(`${tick} ${a.text ?? "(empty)"}${owner}`);
          }
        }
        if (note.transcript && args.include_transcript !== false) {
          parts.push("");
          parts.push("## transcript");
          parts.push(note.transcript);
        }
        return { content: parts.join("\n") };
      } catch (err) {
        return formatGranolaError("granola.read_note", err);
      }
    },
  };
}

function pollRecent(opts: { apiKey: string }): LocalToolHandler {
  return {
    definition: {
      name: "poll_recent",
      description:
        "Poll Granola for meeting notes finished in the last `since_minutes` and return only the ones the harness hasn't seen before. Diffs against the granola_seen_notes table (created by the pack's boot-time migration). Use this from a recurring cron run to detect new meetings without re-processing old ones. Returns the new notes with their summaries; call read_note for each id to get the full transcript.",
      source: "pack:cap-granola",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          since_minutes: {
            type: "integer",
            description: "How far back to query (minutes). Default 60, max 7 days.",
            minimum: 5,
            maximum: 10080,
          },
          k: {
            type: "integer",
            description: "Max notes to list per poll. Default 25, max 50.",
            minimum: 1,
            maximum: 50,
          },
        },
      },
    },
    async handler({ input, signal }) {
      const args = (input ?? {}) as { since_minutes?: number; k?: number };
      try {
        const result = await pollRecentNotes({
          apiKey: opts.apiKey,
          ...(args.since_minutes !== undefined ? { sinceMinutes: args.since_minutes } : {}),
          ...(args.k !== undefined ? { k: args.k } : {}),
          ...(signal ? { signal } : {}),
        });
        if (result.totalNew === 0) {
          return {
            content: `granola.poll_recent: no new notes in the last window (saw ${result.totalSeen} total notes, all previously processed).`,
          };
        }
        const lines = result.newNotes.map((n, i) => {
          const attendees = (n.attendees ?? []).join(", ");
          return `${i + 1}. id=${n.id}  ${n.title ?? "(untitled)"}\n   when: ${n.startedAt ?? "?"} → ${n.endedAt ?? "?"}\n   attendees: ${attendees || "(none)"}\n   summary: ${(n.summary ?? "").slice(0, 240)}`;
        });
        return {
          content: `granola.poll_recent: ${result.totalNew} new note(s) out of ${result.totalSeen} total in window.\n\n${lines.join("\n\n")}`,
        };
      } catch (err) {
        return formatGranolaError("granola.poll_recent", err);
      }
    },
  };
}
