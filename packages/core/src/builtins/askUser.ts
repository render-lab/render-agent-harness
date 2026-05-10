import type { LocalToolHandler } from "../types.js";
import type { BuiltinFactory } from "./types.js";

/**
 * `ask_user({ question, options? })` — pause the run, request input from
 * the caller, resume when they reply.
 *
 * Pausing is signaled by throwing `AwaitingInputError` from the handler.
 * The agent loop (see [loop.ts](../loop.ts)) catches that specific error,
 * sets the run to `paused` with `pauseReason: "awaiting_input"`, and
 * returns `{ status: "paused", reason: "awaiting_input", payload }` to
 * the runtime.
 *
 * The caller resumes via the existing `POST /runs/:id/input` endpoint —
 * the appended user message becomes the next turn's input, the loop
 * re-prompts the model, and the model usually now answers without asking
 * again.
 */
export const askUserFactory: BuiltinFactory = () => ({
  registered: true,
  handler: HANDLER,
});

interface Input {
  question?: string;
  options?: string[];
}

/**
 * Sentinel thrown by `ask_user`. The agent loop must catch this and
 * convert it into a `paused: awaiting_input` run step result.
 */
export class AwaitingInputError extends Error {
  readonly code = "awaiting_input";
  readonly payload: { question: string; options?: string[]; tool_use_id?: string };

  constructor(payload: { question: string; options?: string[] }) {
    super(`ask_user: awaiting input for "${payload.question}"`);
    this.name = "AwaitingInputError";
    this.payload = payload;
  }
}

const HANDLER: LocalToolHandler = {
  definition: {
    name: "ask_user",
    description:
      "Pause and ask the operator a question when you genuinely need input or a decision before proceeding. Use sparingly — never to confirm low-stakes guesses. The run pauses; the operator's reply arrives as the next user message and you resume from there.",
    source: "builtin",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        question: {
          type: "string",
          description: "The question to ask, in plain language.",
          minLength: 1,
        },
        options: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description:
            "Optional 2-6 multiple-choice options. The operator can reply with one of these or with free-form text.",
          minItems: 2,
          maxItems: 6,
        },
      },
      required: ["question"],
    },
  },
  handler: async ({ input }) => {
    const args = (input ?? {}) as Input;
    const question = (args.question ?? "").trim();
    if (!question) {
      return { content: "ask_user: missing `question`", isError: true };
    }
    const options = Array.isArray(args.options)
      ? args.options.filter((o) => typeof o === "string" && o.length > 0)
      : undefined;
    throw new AwaitingInputError(
      options && options.length > 0 ? { question, options } : { question },
    );
  },
};
