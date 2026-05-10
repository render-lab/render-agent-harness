import { DateTime } from "luxon";
import type { LocalToolHandler } from "../types.js";
import type { BuiltinFactory } from "./types.js";

/**
 * `current_time({ timezone? })` — wall-clock time in UTC, plus optional
 * IANA-zone conversion.
 *
 * Always registers; needs no env. Eliminates the most common
 * wrong-answer trap in chat agents (model trained months ago, asked
 * "what's today's date").
 *
 * Uses Luxon for tz arithmetic — it handles every IANA edge case
 * (DST, half-hour zones like Asia/Kolkata, Pacific/Chatham at +12:45,
 * historical offset changes) correctly.
 */
export const currentTimeFactory: BuiltinFactory = () => ({
  registered: true,
  handler: HANDLER,
});

const HANDLER: LocalToolHandler = {
  definition: {
    name: "current_time",
    description:
      "Return the current wall-clock time. Always returns UTC; pass an IANA timezone string (e.g. 'America/New_York', 'Asia/Tokyo') to also get the local time in that zone.",
    source: "builtin",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        timezone: {
          type: "string",
          description: "Optional IANA timezone identifier (e.g. 'Europe/Paris').",
        },
      },
    },
  },
  handler: async ({ input }) => {
    const now = DateTime.utc();
    const utc = now.toISO() ?? new Date().toISOString();
    const tz = (input as { timezone?: string } | null)?.timezone;
    if (!tz) {
      return { content: JSON.stringify({ utc }) };
    }
    if (typeof tz !== "string") {
      return {
        content: 'current_time: "timezone" must be a string',
        isError: true,
      };
    }
    const local = now.setZone(tz);
    if (!local.isValid) {
      return {
        content: `current_time: "${tz}" is not a valid IANA timezone (try e.g. "America/New_York", "Asia/Tokyo", "UTC")`,
        isError: true,
      };
    }
    return {
      content: JSON.stringify({
        utc,
        timezone: tz,
        local: local.toISO({ suppressMilliseconds: true }),
      }),
    };
  },
};
