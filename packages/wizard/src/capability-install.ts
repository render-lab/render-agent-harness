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
}

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
    versionRange: "^0.1.1",
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
    versionRange: "^0.1.1",
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
    versionRange: "^0.1.1",
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
    versionRange: "^0.1.1",
    envVars: ["WEBHOOK_SECRET"],
    connector: true,
    readTools: [],
    writeTools: [],
    defaultConfig: {
      secretEnv: "WEBHOOK_SECRET",
    },
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

  const tools = [
    ...args.plan.spec.readTools,
    ...(args.plan.install.accessMode === "read_write" ? args.plan.spec.writeTools : []),
  ];
  mergeStringSeq(doc, ["shared", "permissions", "allowedTools"], tools);
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
