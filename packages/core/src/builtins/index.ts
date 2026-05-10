/**
 * Built-in tool registry.
 *
 * Every agent gets the output of {@link buildBuiltinTools} concatenated
 * with their own `localTools`. Each builtin is a {@link BuiltinFactory}
 * that decides at registration time whether its preconditions are met.
 *
 * Tier A — always-on, zero credentials:
 *   - `load_skill`, `fetch_full_result` (infrastructural, predate this file)
 *   - `fetch_url`, `current_time`, `ask_user`, `todo`
 *
 * Tier B — register only when the right env var is set:
 *   - `web_search`        (EXA_API_KEY → TAVILY_API_KEY → BRAVE_API_KEY)
 *   - `web_extract`       (FIRECRAWL_API_KEY → EXA_API_KEY)
 *   - `image_generate`    (OPENAI_API_KEY → FAL_KEY)
 *
 * Tier C — auto-on when harness primitives are present:
 *   - `list_my_runs` (Postgres pool, scoped to caller userId)
 *
 * Filesystem / terminal tools live OUTSIDE core (`cap-filesystem` pack)
 * because the worker pserv is multi-tenant and filesystem access is
 * unsafe by default. See `docs/architecture.md`.
 */

import type { LocalToolHandler } from "../types.js";
import { askUserFactory } from "./askUser.js";
import { currentTimeFactory } from "./currentTime.js";
import { fetchFullResultFactory } from "./fetchFullResult.js";
import { fetchUrlFactory } from "./fetchUrl.js";
import { imageGenerateFactory } from "./imageGenerate.js";
import { listMyRunsFactory } from "./listMyRuns.js";
import { loadSkillFactory } from "./loadSkill.js";
import { todoFactory } from "./todo.js";
import type {
  BuildBuiltinsResult,
  BuiltinContext,
  BuiltinFactory,
  SkippedBuiltin,
} from "./types.js";
import { webExtractFactory } from "./webExtract.js";
import { webSearchFactory } from "./webSearch.js";

export type {
  BuildBuiltinsResult,
  BuiltinContext,
  BuiltinFactory,
  BuiltinRegistration,
  SkippedBuiltin,
} from "./types.js";
export { AwaitingInputError } from "./askUser.js";

const FACTORIES: BuiltinFactory[] = [
  loadSkillFactory,
  fetchFullResultFactory,
  fetchUrlFactory,
  currentTimeFactory,
  askUserFactory,
  todoFactory,
  listMyRunsFactory,
  webSearchFactory,
  webExtractFactory,
  imageGenerateFactory,
];

/**
 * Build the active builtin tool set for one run.
 *
 * Returns both the live handlers AND the list of skipped tools (with
 * reasons) so the loop can stash them in `agent_runs.metadata` and the
 * operator UI can surface "image_generate (skipped: OPENAI_API_KEY not
 * set)" without the operator having to grep logs.
 */
export function buildBuiltinTools(ctx: BuiltinContext): BuildBuiltinsResult {
  const tools: LocalToolHandler[] = [];
  const skipped: SkippedBuiltin[] = [];
  for (const factory of FACTORIES) {
    const reg = factory(ctx);
    if (reg.registered) {
      tools.push(reg.handler);
    } else {
      skipped.push({ name: reg.name, reason: reg.reason });
    }
  }
  return { tools, skipped };
}

export interface BuiltinPreview {
  registered: string[];
  skipped: SkippedBuiltin[];
}

/**
 * Boot-time preview of which builtins would register, given the process
 * env. Used by `GET /agents` to surface the active toolset to operators
 * without spinning up a real run. Pool / runId / userId aren't available
 * at preview time so any factory that needs them registers anyway and
 * the per-run gate (`list_my_runs` empty when userId is null) handles
 * the rest.
 */
export function previewBuiltins(env: NodeJS.ProcessEnv): BuiltinPreview {
  const stubLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => stubLogger,
  } as unknown as BuiltinContext["logger"];
  const ctx: BuiltinContext = {
    pool: {} as BuiltinContext["pool"],
    skills: [],
    runId: "preview",
    userId: null,
    agentName: "preview",
    logger: stubLogger,
    env,
  };
  const registered: string[] = [];
  const skipped: SkippedBuiltin[] = [];
  for (const factory of FACTORIES) {
    const reg = factory(ctx);
    if (reg.registered) {
      registered.push(reg.handler.definition.name);
    } else {
      skipped.push({ name: reg.name, reason: reg.reason });
    }
  }
  return { registered, skipped };
}
