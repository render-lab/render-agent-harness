/**
 * Google Calendar tool set (Calendar API v3).
 *
 * Tools are namespaced under `calendar.`. The registry rewrites tool
 * names to `cap-google__calendar_<name>` when the agent loads.
 *
 * Read mode: `calendar.list_events`, `calendar.get_event`, `calendar.freebusy`
 * Read-write adds: `calendar.create_event`, `calendar.update_event`,
 *                  `calendar.delete_event`
 */

import type { LocalToolHandler } from "@render-harness/core";
import { defineGoogleTool, googleFetch, objectSchema } from "../lib.js";
import type { GoogleAccessMode } from "../oauth.js";

const CAL_BASE = "https://www.googleapis.com/calendar/v3";

export function calendarTools(args: { accessMode: GoogleAccessMode }): LocalToolHandler[] {
  const tools: LocalToolHandler[] = [
    // ----------------------------------------------------------------
    // calendar.list_events
    // ----------------------------------------------------------------
    defineGoogleTool<{
      calendar_id?: string;
      time_min?: string;
      time_max?: string;
      query?: string;
      max_results?: number;
    }>({
      name: "calendar.list_events",
      description:
        "List events from a Google Calendar within a time range. `calendar_id` defaults to the primary calendar. `time_min` / `time_max` are ISO-8601 (RFC 3339) timestamps. `query` filters by free-text match against summary, description, location, attendees.",
      inputSchema: objectSchema({
        calendar_id: {
          type: "string",
          description: 'Calendar ID. Defaults to "primary".',
          optional: true,
        },
        time_min: {
          type: "string",
          description: "Lower bound (RFC 3339). Defaults to now.",
          optional: true,
        },
        time_max: {
          type: "string",
          description: "Upper bound (RFC 3339). Defaults to time_min + 7 days.",
          optional: true,
        },
        query: { type: "string", description: "Free-text filter.", optional: true },
        max_results: {
          type: "number",
          description: "Max events to return (1-250). Default 50.",
          optional: true,
        },
      }),
      call: async ({ input, accessToken, signal }) => {
        const calendarId = input.calendar_id ?? "primary";
        const timeMin = input.time_min ?? new Date().toISOString();
        const timeMax = input.time_max ?? new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
        return googleFetch(`${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events`, {
          accessToken,
          query: {
            timeMin,
            timeMax,
            singleEvents: true,
            orderBy: "startTime",
            maxResults: clampInt(input.max_results, 1, 250, 50),
            q: input.query,
          },
          signal,
        });
      },
    }),

    // ----------------------------------------------------------------
    // calendar.get_event
    // ----------------------------------------------------------------
    defineGoogleTool<{ event_id: string; calendar_id?: string }>({
      name: "calendar.get_event",
      description: "Fetch a single calendar event by id.",
      inputSchema: objectSchema({
        event_id: { type: "string", description: "Event id." },
        calendar_id: {
          type: "string",
          description: 'Calendar ID. Defaults to "primary".',
          optional: true,
        },
      }),
      call: async ({ input, accessToken, signal }) => {
        const calendarId = input.calendar_id ?? "primary";
        return googleFetch(
          `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.event_id)}`,
          { accessToken, signal },
        );
      },
    }),

    // ----------------------------------------------------------------
    // calendar.freebusy
    // ----------------------------------------------------------------
    defineGoogleTool<{
      time_min: string;
      time_max: string;
      calendar_ids?: string[];
    }>({
      name: "calendar.freebusy",
      description:
        "Query free/busy windows across one or more calendars (default: just the primary calendar). Returns blocks of [start, end] times during which the calendar is busy.",
      inputSchema: objectSchema({
        time_min: { type: "string", description: "Range start (RFC 3339)." },
        time_max: { type: "string", description: "Range end (RFC 3339)." },
        calendar_ids: {
          type: "array",
          description: 'Calendar IDs to query. Defaults to ["primary"].',
          optional: true,
        },
      }),
      call: async ({ input, accessToken, signal }) => {
        const ids = input.calendar_ids?.length ? input.calendar_ids : ["primary"];
        return googleFetch(`${CAL_BASE}/freeBusy`, {
          accessToken,
          method: "POST",
          body: {
            timeMin: input.time_min,
            timeMax: input.time_max,
            items: ids.map((id) => ({ id })),
          },
          signal,
        });
      },
    }),
  ];

  if (args.accessMode !== "read_write") return tools;

  tools.push(
    // ----------------------------------------------------------------
    // calendar.create_event
    // ----------------------------------------------------------------
    defineGoogleTool<{
      summary: string;
      start: string;
      end: string;
      calendar_id?: string;
      description?: string;
      location?: string;
      attendees?: string[];
      send_updates?: "all" | "externalOnly" | "none";
    }>({
      name: "calendar.create_event",
      description:
        'Create a new calendar event. `start` and `end` are RFC 3339 timestamps with timezone (e.g. "2026-06-01T14:00:00-07:00"). Use `send_updates: "all"` to email invitations to attendees.',
      inputSchema: objectSchema({
        summary: { type: "string", description: "Event title." },
        start: { type: "string", description: "Start time (RFC 3339)." },
        end: { type: "string", description: "End time (RFC 3339)." },
        calendar_id: {
          type: "string",
          description: 'Calendar ID. Defaults to "primary".',
          optional: true,
        },
        description: { type: "string", optional: true },
        location: { type: "string", optional: true },
        attendees: {
          type: "array",
          description: "Attendee email addresses.",
          optional: true,
        },
        send_updates: {
          type: "string",
          description: "Who to email about the new event: all | externalOnly | none.",
          optional: true,
        },
      }),
      call: async ({ input, accessToken, signal }) => {
        const calendarId = input.calendar_id ?? "primary";
        const body: Record<string, unknown> = {
          summary: input.summary,
          start: { dateTime: input.start },
          end: { dateTime: input.end },
        };
        if (input.description) body.description = input.description;
        if (input.location) body.location = input.location;
        if (input.attendees?.length) {
          body.attendees = input.attendees.map((email) => ({ email }));
        }
        return googleFetch(`${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events`, {
          accessToken,
          method: "POST",
          body,
          query: { sendUpdates: input.send_updates ?? "none" },
          signal,
        });
      },
    }),

    // ----------------------------------------------------------------
    // calendar.update_event
    // ----------------------------------------------------------------
    defineGoogleTool<{
      event_id: string;
      calendar_id?: string;
      summary?: string;
      start?: string;
      end?: string;
      description?: string;
      location?: string;
      attendees?: string[];
      send_updates?: "all" | "externalOnly" | "none";
    }>({
      name: "calendar.update_event",
      description:
        "Patch fields on an existing calendar event. Only fields you pass get updated; omit fields to leave them alone.",
      inputSchema: objectSchema({
        event_id: { type: "string" },
        calendar_id: { type: "string", optional: true },
        summary: { type: "string", optional: true },
        start: { type: "string", description: "RFC 3339 start.", optional: true },
        end: { type: "string", description: "RFC 3339 end.", optional: true },
        description: { type: "string", optional: true },
        location: { type: "string", optional: true },
        attendees: { type: "array", optional: true },
        send_updates: { type: "string", optional: true },
      }),
      call: async ({ input, accessToken, signal }) => {
        const calendarId = input.calendar_id ?? "primary";
        const body: Record<string, unknown> = {};
        if (input.summary !== undefined) body.summary = input.summary;
        if (input.description !== undefined) body.description = input.description;
        if (input.location !== undefined) body.location = input.location;
        if (input.start) body.start = { dateTime: input.start };
        if (input.end) body.end = { dateTime: input.end };
        if (input.attendees) body.attendees = input.attendees.map((email) => ({ email }));
        return googleFetch(
          `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.event_id)}`,
          {
            accessToken,
            method: "PATCH",
            body,
            query: { sendUpdates: input.send_updates ?? "none" },
            signal,
          },
        );
      },
    }),

    // ----------------------------------------------------------------
    // calendar.delete_event
    // ----------------------------------------------------------------
    defineGoogleTool<{
      event_id: string;
      calendar_id?: string;
      send_updates?: "all" | "externalOnly" | "none";
    }>({
      name: "calendar.delete_event",
      description: "Delete a calendar event by id.",
      inputSchema: objectSchema({
        event_id: { type: "string" },
        calendar_id: { type: "string", optional: true },
        send_updates: { type: "string", optional: true },
      }),
      call: async ({ input, accessToken, signal }) => {
        const calendarId = input.calendar_id ?? "primary";
        await googleFetch(
          `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.event_id)}`,
          {
            accessToken,
            method: "DELETE",
            query: { sendUpdates: input.send_updates ?? "none" },
            signal,
          },
        );
        return { ok: true, event_id: input.event_id, calendar_id: calendarId };
      },
    }),
  );

  return tools;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
