import { isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from "yaml";

export type CapabilityAccessMode = "read" | "read_write";

export interface CapabilityInstallInput {
  agentId: string;
  pack: string;
  accessMode: CapabilityAccessMode;
  config?: Record<string, unknown>;
  requireApproval?: boolean;
}

export interface CapabilityInstallSpec {
  pack: string;
  versionRange: string;
  envVars: string[];
  connector: boolean;
  readTools: string[];
  writeTools: string[];
  defaultConfig: Record<string, unknown>;
  /** Display label for the catalog. Short, human-friendly. */
  label: string;
  /** One-line catalog description (matches the pack's README intent). */
  description: string;
  /**
   * Optional caveat surfaced in the catalog response so the modal can
   * warn users (e.g. "Exa's hosted MCP may expose tools beyond the
   * documented set; add their names manually if needed").
   */
  caveat?: string;
}

/**
 * The always-on Tier A builtin tools (see CLAUDE.md "Built-in tools").
 * When the wizard expands `shared.permissions.allowedTools` for a
 * capability install, it also ensures these names stay in the list so
 * the agent doesn't lose `load_skill` / `fetch_url` / `ask_user` / etc.
 * just because the user picked a capability.
 *
 * Mirrored from `buildBuiltinTools()` in @render-harness/core/builtins.
 * Out of sync = silent loss of agent functionality, so keep this list
 * aligned whenever the builtin set changes.
 */
export const TIER_A_BUILTIN_TOOLS = [
  "load_skill",
  "fetch_full_result",
  "fetch_url",
  "current_time",
  "ask_user",
  "todo",
] as const;

export interface CapabilityInstallPlan {
  install: CapabilityInstallInput;
  spec: CapabilityInstallSpec;
  warnings: string[];
}

export class CapabilityInstallError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "CapabilityInstallError";
  }
}

export const OFFICIAL_CAPABILITY_INSTALLS: Record<string, CapabilityInstallSpec> = {
  "@render-harness/cap-slack": {
    pack: "@render-harness/cap-slack",
    label: "Slack",
    description: "Slack connector + tools (read threads, reply, react, update messages).",
    versionRange: "^0.8.0",
    envVars: ["SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN"],
    connector: true,
    readTools: ["cap-slack__slack_get_thread", "cap-slack__slack_get_channel_history"],
    writeTools: [
      "cap-slack__slack_send_message",
      "cap-slack__slack_add_reaction",
      "cap-slack__slack_update_message",
    ],
    defaultConfig: {
      signingSecretEnv: "SLACK_SIGNING_SECRET",
      botTokenEnv: "SLACK_BOT_TOKEN",
    },
  },
  "@render-harness/cap-github": {
    pack: "@render-harness/cap-github",
    label: "GitHub",
    description:
      "GitHub connector + tools (issues, PRs, files, checks, workflow runs; comment/label/status writes).",
    versionRange: "^0.8.0",
    envVars: ["GITHUB_WEBHOOK_SECRET", "GITHUB_TOKEN"],
    connector: true,
    readTools: [
      "cap-github__github_get_issue",
      "cap-github__github_get_pull_request",
      "cap-github__github_list_pull_request_files",
      "cap-github__github_list_pull_request_reviews",
      "cap-github__github_list_pull_request_commits",
      "cap-github__github_list_issue_comments",
      "cap-github__github_get_content",
      "cap-github__github_list_checks",
      "cap-github__github_list_workflow_runs",
      "cap-github__github_get_workflow_run",
      "cap-github__github_list_workflow_run_jobs",
    ],
    writeTools: [
      "cap-github__github_create_issue_comment",
      "cap-github__github_create_pull_request_review_comment",
      "cap-github__github_update_issue",
      "cap-github__github_add_issue_labels",
      "cap-github__github_set_commit_status",
      "cap-github__github_rerun_workflow_run",
      "cap-github__github_cancel_workflow_run",
    ],
    defaultConfig: {
      webhookSecretEnv: "GITHUB_WEBHOOK_SECRET",
      tokenEnv: "GITHUB_TOKEN",
    },
  },
  "@render-harness/cap-linear": {
    pack: "@render-harness/cap-linear",
    label: "Linear",
    description:
      "Linear connector + tools (issues, comments, projects, teams; create/update/assign).",
    versionRange: "^0.8.0",
    envVars: ["LINEAR_WEBHOOK_SECRET", "LINEAR_API_KEY"],
    connector: true,
    readTools: [
      "cap-linear__linear_get_issue",
      "cap-linear__linear_search_issues",
      "cap-linear__linear_list_comments",
      "cap-linear__linear_list_teams",
      "cap-linear__linear_list_projects",
      "cap-linear__linear_list_workflow_states",
      "cap-linear__linear_list_users",
    ],
    writeTools: [
      "cap-linear__linear_create_issue",
      "cap-linear__linear_create_comment",
      "cap-linear__linear_update_issue",
      "cap-linear__linear_update_issue_status",
      "cap-linear__linear_assign_issue",
      "cap-linear__linear_link_related_issue",
    ],
    defaultConfig: {
      webhookSecretEnv: "LINEAR_WEBHOOK_SECRET",
      apiKeyEnv: "LINEAR_API_KEY",
    },
  },
  "@render-harness/cap-webhook-generic": {
    pack: "@render-harness/cap-webhook-generic",
    label: "Generic webhook",
    description: "Signed-HMAC inbound webhook that enqueues runs on the agent's queue.",
    versionRange: "^0.8.0",
    envVars: ["WEBHOOK_SECRET"],
    connector: true,
    readTools: [],
    writeTools: [],
    defaultConfig: {
      secretEnv: "WEBHOOK_SECRET",
    },
  },
  "@render-harness/cap-search-exa": {
    pack: "@render-harness/cap-search-exa",
    label: "Exa web search",
    description: "Exa hosted MCP for high-recall web search and full-page fetch.",
    versionRange: "^0.8.0",
    envVars: ["EXA_API_KEY"],
    connector: false,
    // Tools sourced from https://docs.exa.ai/reference/exa-mcp at time of writing.
    // The optional `web_search_advanced_exa` tool is included since Exa lists
    // it as commonly-enabled; if upstream adds new tools beyond this set, the
    // operator needs to expand `allowedTools` manually.
    readTools: [
      "cap-search-exa__web_search_exa",
      "cap-search-exa__web_fetch_exa",
      "cap-search-exa__web_search_advanced_exa",
    ],
    writeTools: [],
    defaultConfig: {},
    caveat:
      "Tools come from Exa's hosted MCP at mcp.exa.ai. If Exa adds tools beyond the documented set (web_search_exa, web_fetch_exa, web_search_advanced_exa), append them to allowedTools manually.",
  },
  "@render-harness/cap-search-tavily": {
    pack: "@render-harness/cap-search-tavily",
    label: "Tavily AI search",
    description: "Tavily MCP for citation-friendly AI search with concise summaries.",
    versionRange: "^0.8.0",
    envVars: ["TAVILY_API_KEY"],
    connector: false,
    readTools: ["cap-search-tavily__tavily-search", "cap-search-tavily__tavily-extract"],
    writeTools: [],
    defaultConfig: {},
    caveat:
      "Tools come from the tavily-mcp npm package. If newer versions add tools, append them to allowedTools manually.",
  },
  "@render-harness/cap-scrape-firecrawl": {
    pack: "@render-harness/cap-scrape-firecrawl",
    label: "Firecrawl scraping",
    description:
      "Firecrawl MCP for clean-markdown URL rendering + a local scrape_and_store tool that persists results to Postgres.",
    versionRange: "^0.8.0",
    envVars: ["FIRECRAWL_API_KEY"],
    connector: false,
    // Firecrawl MCP tool list per upstream README; the local
    // scrape_and_store tool is the one shipped by this pack directly.
    readTools: [
      "cap-scrape-firecrawl__firecrawl_scrape",
      "cap-scrape-firecrawl__firecrawl_crawl",
      "cap-scrape-firecrawl__firecrawl_map",
      "cap-scrape-firecrawl__firecrawl_search",
      "cap-scrape-firecrawl__firecrawl_extract",
      "cap-scrape-firecrawl__scrape_and_store",
    ],
    writeTools: [],
    defaultConfig: {},
    caveat:
      "Tools come from the firecrawl-mcp npm package. If newer versions add tools, append them to allowedTools manually.",
  },
  "@render-harness/cap-google": {
    pack: "@render-harness/cap-google",
    label: "Google (Gmail + Calendar)",
    description:
      "Per-user OAuth Gmail + Calendar tools. Requires Google Cloud OAuth client + CONNECTIONS_ENCRYPTION_KEY.",
    versionRange: "^0.8.0",
    envVars: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "CONNECTIONS_ENCRYPTION_KEY"],
    connector: false,
    // Tools enumerated from packages/capabilities/cap-google/src/tools/{gmail,calendar}.ts.
    // Namespacing rewrites `.` to `_` (see namespacedToolName), so
    // `gmail.search` → `cap-google__gmail_search`.
    readTools: [
      "cap-google__gmail_search",
      "cap-google__gmail_get_message",
      "cap-google__calendar_list_events",
      "cap-google__calendar_get_event",
      "cap-google__calendar_freebusy",
    ],
    writeTools: [
      "cap-google__gmail_send",
      "cap-google__gmail_modify_labels",
      "cap-google__calendar_create_event",
      "cap-google__calendar_update_event",
      "cap-google__calendar_delete_event",
    ],
    defaultConfig: {},
  },
  "@render-harness/cap-memory-pg": {
    pack: "@render-harness/cap-memory-pg",
    label: "Memory (Postgres)",
    description:
      "Long-term agent memory in Postgres with pg_trgm fuzzy search. Auto-bootstraps its table.",
    versionRange: "^0.8.0",
    envVars: [],
    connector: false,
    readTools: ["cap-memory-pg__search"],
    writeTools: ["cap-memory-pg__write"],
    defaultConfig: {},
  },
  "@render-harness/cap-filesystem": {
    pack: "@render-harness/cap-filesystem",
    label: "Filesystem",
    description:
      "Sandboxed file read/list/write/delete under a configured root. Set the `roots` config to a path under the deployed disk.",
    versionRange: "^0.8.0",
    envVars: [],
    connector: false,
    readTools: ["cap-filesystem__fs_read_file", "cap-filesystem__fs_list_dir"],
    writeTools: ["cap-filesystem__fs_write_file", "cap-filesystem__fs_delete_file"],
    defaultConfig: {},
    caveat:
      "Requires a `roots` config entry pointing at the deployed disk mount, e.g. `config: { roots: ['/var/data/agent'] }`.",
  },
  "@render-harness/cap-browser-browserbase": {
    pack: "@render-harness/cap-browser-browserbase",
    label: "Browser (Browserbase)",
    description: "Browserbase hosted browser MCP for JS-heavy pages, login flows, and screenshots.",
    versionRange: "^0.8.0",
    envVars: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"],
    connector: false,
    // @browserbasehq/mcp tool list per upstream README.
    readTools: [
      "cap-browser-browserbase__browserbase_create_session",
      "cap-browser-browserbase__browserbase_navigate",
      "cap-browser-browserbase__browserbase_screenshot",
      "cap-browser-browserbase__browserbase_get_text",
      "cap-browser-browserbase__browserbase_close_session",
    ],
    writeTools: [
      "cap-browser-browserbase__browserbase_click",
      "cap-browser-browserbase__browserbase_type",
      "cap-browser-browserbase__browserbase_evaluate",
    ],
    defaultConfig: {},
    caveat:
      "Tools come from the @browserbasehq/mcp npm package. The exact tool set evolves with Browserbase releases; expand allowedTools manually if upstream adds new tools.",
  },
  "@render-harness/cap-render": {
    pack: "@render-harness/cap-render",
    label: "Render (MCP)",
    description:
      "Wraps the hosted Render MCP for managing services, deploys, databases, env vars, and logs. Ships skills and a curated mutating-tool list for HITL gating.",
    versionRange: "^0.8.0",
    envVars: ["RENDER_API_KEY"],
    connector: false,
    // Render MCP tool names get sanitized to underscores by core/mcp.ts
    // (see AGENTS.md "MCP-discovered tool names get hyphens sanitized to
    // underscores"). Mutating tools mirror RENDER_MCP_MUTATING_TOOLS.
    readTools: [
      "cap_render__render__list_services",
      "cap_render__render__get_service",
      "cap_render__render__list_deploys",
      "cap_render__render__get_deploy",
      "cap_render__render__list_environment_variables",
      "cap_render__render__list_logs",
    ],
    writeTools: [
      "cap_render__render__create_web_service",
      "cap_render__render__update_web_service",
      "cap_render__render__delete_service",
      "cap_render__render__create_postgres",
      "cap_render__render__update_postgres",
      "cap_render__render__delete_postgres",
      "cap_render__render__create_keyvalue",
      "cap_render__render__update_keyvalue",
      "cap_render__render__delete_keyvalue",
      "cap_render__render__update_environment_variables",
      "cap_render__render__create_environment_variable",
      "cap_render__render__delete_environment_variable",
    ],
    defaultConfig: {},
    caveat:
      "Tools come from Render's hosted MCP at mcp.render.com. The exact read-tool set evolves with Render releases; expand allowedTools manually if upstream adds new tools. Use the writeTools list as `permissions.requireApproval` to gate destructive operations behind HITL.",
  },
  "@render-harness/cap-notion": {
    pack: "@render-harness/cap-notion",
    label: "Notion",
    description:
      "Notion pages, databases, and workspace search via per-end-user OAuth. 8 tools across pages, databases, and search.",
    versionRange: "^0.8.0",
    envVars: ["NOTION_OAUTH_CLIENT_ID", "NOTION_OAUTH_CLIENT_SECRET", "CONNECTIONS_ENCRYPTION_KEY"],
    connector: false,
    // Tools enumerated from packages/capabilities/cap-notion/src/tools/*.ts.
    readTools: ["cap-notion__search", "cap-notion__read_page", "cap-notion__query_database"],
    writeTools: [
      "cap-notion__create_page",
      "cap-notion__append_blocks",
      "cap-notion__update_page_properties",
      "cap-notion__create_database_row",
      "cap-notion__update_database_row",
    ],
    defaultConfig: {},
  },
  "@render-harness/cap-intercom": {
    pack: "@render-harness/cap-intercom",
    label: "Intercom",
    description:
      "Dual inbound+outbound pack: HMAC-verified webhook for conversation events plus per-end-user OAuth tools for reply, assign, tag, close, snooze.",
    versionRange: "^0.8.0",
    envVars: [
      "INTERCOM_OAUTH_CLIENT_ID",
      "INTERCOM_OAUTH_CLIENT_SECRET",
      "CONNECTIONS_ENCRYPTION_KEY",
    ],
    // Mounts POST /connectors/intercom for inbound webhooks; client
    // secret doubles as the HMAC key (no separate webhook secret env).
    connector: true,
    readTools: ["cap-intercom__read_conversation", "cap-intercom__list_recent_conversations"],
    writeTools: [
      "cap-intercom__reply",
      "cap-intercom__assign",
      "cap-intercom__add_tag",
      "cap-intercom__close",
      "cap-intercom__snooze",
    ],
    defaultConfig: {
      clientIdEnv: "INTERCOM_OAUTH_CLIENT_ID",
      clientSecretEnv: "INTERCOM_OAUTH_CLIENT_SECRET",
    },
  },
  "@render-harness/cap-granola": {
    pack: "@render-harness/cap-granola",
    label: "Granola",
    description:
      "API-key + polling pack — list/read Granola meeting notes and detect new ones via a recurring cron run. Owns a granola_seen_notes dedup table via the pack-migration runner.",
    versionRange: "^0.8.0",
    envVars: ["GRANOLA_API_KEY"],
    connector: false,
    readTools: ["cap-granola__list_notes", "cap-granola__read_note", "cap-granola__poll_recent"],
    writeTools: [],
    defaultConfig: {
      apiKeyEnv: "GRANOLA_API_KEY",
    },
  },
  "@render-harness/cap-figma": {
    pack: "@render-harness/cap-figma",
    label: "Figma",
    description:
      "Granular per-action OAuth scopes (post-Nov-2025 Figma update). 7 tools across files, projects/teams, and comments.",
    versionRange: "^0.8.0",
    envVars: ["FIGMA_OAUTH_CLIENT_ID", "FIGMA_OAUTH_CLIENT_SECRET", "CONNECTIONS_ENCRYPTION_KEY"],
    connector: false,
    readTools: [
      "cap-figma__read_file",
      "cap-figma__read_file_nodes",
      "cap-figma__read_file_metadata",
      "cap-figma__list_team_projects",
      "cap-figma__list_project_files",
      "cap-figma__read_comments",
    ],
    writeTools: ["cap-figma__post_comment"],
    defaultConfig: {},
  },
};

export function planCapabilityInstall(args: {
  yamlText: string;
  install: CapabilityInstallInput;
}): CapabilityInstallPlan {
  const spec = OFFICIAL_CAPABILITY_INSTALLS[args.install.pack];
  if (!spec)
    throw new CapabilityInstallError("unknown_capability", `unsupported pack ${args.install.pack}`);
  const doc = parseDocument(args.yamlText);
  if (doc.errors.length > 0) {
    throw new CapabilityInstallError(
      "invalid_manifest",
      `render-harness.yaml has parse errors: ${doc.errors.map((e) => e.message).join("; ")}`,
    );
  }
  const agents = doc.get("agents", true);
  if (!isSeq(agents))
    throw new CapabilityInstallError("invalid_manifest", "manifest must have agents[]");
  const agent = findAgent(agents, args.install.agentId);
  if (!agent)
    throw new CapabilityInstallError("agent_not_found", `agent ${args.install.agentId} not found`);
  const warnings: string[] = [];
  if (spec.connector && !agentHasRuntime(agent, "web")) {
    throw new CapabilityInstallError(
      "missing_web_runtime",
      "connector capabilities require a web runtime",
    );
  }
  if (spec.connector && !agentHasRuntime(agent, "worker")) {
    throw new CapabilityInstallError(
      "missing_worker_runtime",
      "connector capabilities require a worker runtime",
    );
  }
  warnings.push(
    "Run pnpm install and pnpm build:bp after merging to refresh lockfile and render.yaml.",
  );
  return { install: args.install, spec, warnings };
}

export function mutateCapabilityInstallYaml(args: {
  yamlText: string;
  plan: CapabilityInstallPlan;
}): string {
  const doc = parseDocument(args.yamlText);
  const capabilities = ensureSeq(doc, "capabilities");
  const existing = findCapability(capabilities, args.plan.install.pack);
  const config = {
    ...args.plan.spec.defaultConfig,
    agent: args.plan.install.agentId,
    accessMode: args.plan.install.accessMode,
    ...(args.plan.install.config ?? {}),
  };
  if (existing) {
    existing.set("config", doc.createNode({ ...mapToObject(existing.get("config")), ...config }));
  } else {
    capabilities.add(doc.createNode({ pack: args.plan.install.pack, config }));
  }

  const capTools = [
    ...args.plan.spec.readTools,
    ...(args.plan.install.accessMode === "read_write" ? args.plan.spec.writeTools : []),
  ];
  // Only expand allowedTools when the agent already has a non-empty
  // allowlist. Agents with no allowlist are unrestricted; introducing
  // one here would silently strip every MCP tool from other packs,
  // every Tier A builtin, and every yet-to-be-installed cap. When we
  // do expand, also include Tier A so we don't strip them either —
  // they're "always on" by core's design but a strict allowlist will
  // filter them out the next time the model talks to Anthropic.
  mergeAllowedToolsIfPresent(doc, capTools);
  if (
    args.plan.install.accessMode === "read_write" &&
    args.plan.install.requireApproval !== false
  ) {
    mergeStringSeq(doc, ["shared", "permissions", "requireApproval"], args.plan.spec.writeTools);
  }
  return doc.toString();
}

export function mutatePackageJsonAddDependency(args: {
  jsonText: string;
  packageName: string;
  versionRange: string;
}): string {
  const pkg = JSON.parse(args.jsonText) as { dependencies?: Record<string, string> };
  pkg.dependencies = { ...(pkg.dependencies ?? {}), [args.packageName]: args.versionRange };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

export interface ExpandAllowedToolsArgs {
  yamlText: string;
  /** Capability pack names being introduced by this mutation. */
  packs: string[];
  /**
   * Default access mode for the expansion. The agent-add flow uses
   * "read" (the bundle pulls the cap in implicitly; the operator
   * didn't pick an access mode). Callers wanting write tools should
   * pass "read_write" — write tools land in allowedTools then.
   */
  accessMode: CapabilityAccessMode;
}

export interface ExpandAllowedToolsResult {
  yamlText: string;
  /** Names of packs whose tools were actually merged into the allowlist. */
  expanded: string[];
  /**
   * Names of packs that *would* have been merged but were skipped
   * because the agent has no `allowedTools` allowlist (so it's already
   * open). Callers can surface these in warnings if useful.
   */
  skippedOpenAllowlist: string[];
  /** Packs not in OFFICIAL_CAPABILITY_INSTALLS — silently dropped. */
  skippedUnknown: string[];
}

/**
 * Expand `shared.permissions.allowedTools` to include the tools from
 * the listed capability packs (plus Tier A builtins) — but only when
 * the manifest already has a non-empty allowlist. Used by the
 * agent-add route to keep allowlist-style agents functional when a
 * new bundle pulls in fresh capabilities.
 *
 * No-op-safe when:
 *   - the manifest has no `shared.permissions.allowedTools` at all
 *   - the allowlist exists but is empty
 *   - no listed pack appears in `OFFICIAL_CAPABILITY_INSTALLS`
 */
export function expandAllowedToolsForPacks(args: ExpandAllowedToolsArgs): ExpandAllowedToolsResult {
  const doc = parseDocument(args.yamlText);
  if (doc.errors.length > 0) {
    throw new CapabilityInstallError(
      "invalid_manifest",
      `render-harness.yaml has parse errors: ${doc.errors.map((e) => e.message).join("; ")}`,
    );
  }
  const expanded: string[] = [];
  const skippedOpenAllowlist: string[] = [];
  const skippedUnknown: string[] = [];

  const path = ["shared", "permissions", "allowedTools"];
  const node = doc.getIn(path, true);
  // Probe once — the helper short-circuits the same way for every
  // pack when the allowlist is open, so we can categorize cleanly.
  // A malformed (non-sequence) node will throw downstream in
  // mergeAllowedToolsIfPresent, which is the right escalation.
  const isOpen = !node || (isSeq(node) && node.items.length === 0);
  for (const pack of args.packs) {
    const spec = OFFICIAL_CAPABILITY_INSTALLS[pack];
    if (!spec) {
      skippedUnknown.push(pack);
      continue;
    }
    if (isOpen) {
      skippedOpenAllowlist.push(pack);
      continue;
    }
    const capTools = [
      ...spec.readTools,
      ...(args.accessMode === "read_write" ? spec.writeTools : []),
    ];
    if (capTools.length === 0) continue;
    mergeAllowedToolsIfPresent(doc, capTools);
    expanded.push(pack);
  }
  return { yamlText: doc.toString(), expanded, skippedOpenAllowlist, skippedUnknown };
}

export function mutateEnvExample(args: { text: string; envVars: string[] }): string {
  let text = args.text.endsWith("\n") ? args.text : `${args.text}\n`;
  const missing = args.envVars.filter(
    (name) => !new RegExp(`^${escapeRegex(name)}=`, "m").test(text),
  );
  if (missing.length === 0) return text;
  text += "\n# Capability install: fill in after deploy.\n";
  for (const name of missing) text += `${name}=\n`;
  return text;
}

function ensureSeq(doc: ReturnType<typeof parseDocument>, key: string): YAMLSeq {
  let seq = doc.get(key, true);
  if (!seq) {
    seq = doc.createNode([]);
    doc.set(key, seq);
  }
  if (!isSeq(seq))
    throw new CapabilityInstallError("invalid_manifest", `${key} must be a sequence`);
  return seq;
}

function findAgent(agents: YAMLSeq, agentId: string): YAMLMap | null {
  for (const item of agents.items) {
    if (isMap(item) && readScalar(item.get("id")) === agentId) return item;
  }
  return null;
}

function findCapability(capabilities: YAMLSeq, pack: string): YAMLMap | null {
  for (const item of capabilities.items) {
    if (isMap(item) && readScalar(item.get("pack")) === pack) return item;
  }
  return null;
}

function agentHasRuntime(agent: YAMLMap, kind: string): boolean {
  const runtimes = agent.get("runtimes");
  return (
    isSeq(runtimes) &&
    runtimes.items.some((item) => isMap(item) && readScalar(item.get("kind")) === kind)
  );
}

function mergeStringSeq(
  doc: ReturnType<typeof parseDocument>,
  path: Array<string>,
  values: string[],
): void {
  if (values.length === 0) return;
  let node = doc.getIn(path, true);
  if (!node) {
    node = doc.createNode([]);
    doc.setIn(path, node);
  }
  if (!isSeq(node))
    throw new CapabilityInstallError("invalid_manifest", `${path.join(".")} must be a sequence`);
  const existing = new Set(
    node.items.map((item) => readScalar(item)).filter((v): v is string => !!v),
  );
  for (const value of values) {
    if (!existing.has(value)) node.add(value);
  }
}

/**
 * Merges new capability tools into `shared.permissions.allowedTools` —
 * but only when the agent already has a non-empty allowlist. Agents
 * with no `allowedTools` (or an empty array) are considered "open":
 * we leave them open instead of introducing a restriction that strips
 * Tier A builtins, MCP tools from other packs, and every other tool
 * the model would otherwise see.
 *
 * When the allowlist IS present, the merge also ensures the Tier A
 * builtin names are in it. Without that, every wizard-driven install
 * silently kills `load_skill`, `fetch_url`, etc. on the target agent.
 */
function mergeAllowedToolsIfPresent(
  doc: ReturnType<typeof parseDocument>,
  capTools: string[],
): void {
  const path = ["shared", "permissions", "allowedTools"];
  const node = doc.getIn(path, true);
  if (!node) return; // agent is open; don't introduce a restriction
  if (!isSeq(node)) {
    throw new CapabilityInstallError("invalid_manifest", `${path.join(".")} must be a sequence`);
  }
  if (node.items.length === 0) return; // explicit empty list = open
  if (capTools.length === 0) return;
  const existing = new Set(
    node.items.map((item) => readScalar(item)).filter((v): v is string => !!v),
  );
  for (const value of [...TIER_A_BUILTIN_TOOLS, ...capTools]) {
    if (!existing.has(value)) node.add(value);
  }
}

function mapToObject(value: unknown): Record<string, unknown> {
  if (!isMap(value)) return {};
  const out: Record<string, unknown> = {};
  for (const item of value.items) {
    const key = readScalar(item.key);
    if (key) out[key] = scalarToJson(item.value);
  }
  return out;
}

function scalarToJson(value: unknown): unknown {
  if (value && typeof value === "object" && "value" in value)
    return (value as { value: unknown }).value;
  return value;
}

function readScalar(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value: unknown }).value;
    return typeof inner === "string" ? inner : null;
  }
  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
