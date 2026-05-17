export interface GitHubFilterConfig {
  allowedRepositories?: string[];
  events?: string[];
  branches?: string[];
  labels?: string[];
  ignoredActors?: string[];
}

export interface NormalizedGitHubEvent {
  event: string;
  action?: string;
  repo: string;
  actor?: string;
  objectType: string;
  objectId?: string | number;
  number?: number;
  branch?: string;
  url?: string;
  summary: string;
}

const SUPPORTED_EVENTS = new Set([
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "push",
  "check_run",
  "check_suite",
  "workflow_run",
]);

export function normalizeGitHubEvent(
  event: string,
  body: unknown,
  cfg: GitHubFilterConfig = {},
): NormalizedGitHubEvent | null {
  if (!SUPPORTED_EVENTS.has(event)) return null;
  if (cfg.events?.length && !cfg.events.includes(event)) return null;
  if (!body || typeof body !== "object") return null;
  const payload = body as Record<string, unknown>;
  const repo = stringAt(payload, "repository.full_name");
  if (!repo) return null;
  if (cfg.allowedRepositories?.length && !cfg.allowedRepositories.includes(repo)) return null;
  const actor = stringAt(payload, "sender.login");
  if (actor && cfg.ignoredActors?.includes(actor)) return null;
  const branch = branchFor(event, payload);
  if (cfg.branches?.length && branch && !cfg.branches.includes(branch)) return null;
  if (cfg.labels?.length && !hasAllowedLabel(payload, cfg.labels)) return null;

  const action = stringValue(payload.action);
  const normalized = buildNormalized(event, payload, repo, actor, action, branch);
  return normalized;
}

function buildNormalized(
  event: string,
  payload: Record<string, unknown>,
  repo: string,
  actor: string | undefined,
  action: string | undefined,
  branch: string | undefined,
): NormalizedGitHubEvent {
  if (event === "issues") {
    const number = numberAt(payload, "issue.number");
    return {
      event,
      ...(action ? { action } : {}),
      repo,
      ...(actor ? { actor } : {}),
      objectType: "issue",
      objectId: number,
      ...(number !== undefined ? { number } : {}),
      url: stringAt(payload, "issue.html_url"),
      summary: `GitHub issue ${repo}#${number ?? "unknown"} ${action ?? "changed"}`,
    };
  }
  if (event === "pull_request") {
    const number = numberAt(payload, "pull_request.number");
    return {
      event,
      ...(action ? { action } : {}),
      repo,
      ...(actor ? { actor } : {}),
      objectType: "pull_request",
      objectId: number,
      ...(number !== undefined ? { number } : {}),
      ...(branch ? { branch } : {}),
      url: stringAt(payload, "pull_request.html_url"),
      summary: `GitHub PR ${repo}#${number ?? "unknown"} ${action ?? "changed"}`,
    };
  }
  if (event === "push") {
    return {
      event,
      repo,
      ...(actor ? { actor } : {}),
      objectType: "push",
      objectId: stringAt(payload, "after"),
      ...(branch ? { branch } : {}),
      url: stringAt(payload, "compare"),
      summary: `GitHub push to ${repo}${branch ? `:${branch}` : ""}`,
    };
  }
  const objectType = event.replace(/_/g, "-");
  return {
    event,
    ...(action ? { action } : {}),
    repo,
    ...(actor ? { actor } : {}),
    objectType,
    objectId:
      stringAt(payload, `${event}.id`) ??
      numberAt(payload, `${event}.id`) ??
      stringAt(payload, "check_run.id") ??
      numberAt(payload, "check_run.id"),
    ...(branch ? { branch } : {}),
    url: stringAt(payload, `${event}.html_url`) ?? stringAt(payload, `${event}.url`),
    summary: `GitHub ${objectType} event for ${repo}`,
  };
}

function branchFor(event: string, payload: Record<string, unknown>): string | undefined {
  if (event === "push") {
    const ref = stringValue(payload.ref);
    return ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
  }
  return (
    stringAt(payload, "pull_request.head.ref") ?? stringAt(payload, "workflow_run.head_branch")
  );
}

function hasAllowedLabel(payload: Record<string, unknown>, allowed: string[]): boolean {
  const issueLabels = arrayAt(payload, "issue.labels");
  const prLabels = arrayAt(payload, "pull_request.labels");
  const labels = [...issueLabels, ...prLabels]
    .map((label) =>
      label && typeof label === "object" ? stringValue((label as { name?: unknown }).name) : null,
    )
    .filter((label): label is string => !!label);
  return labels.some((label) => allowed.includes(label));
}

function stringAt(value: unknown, path: string): string | undefined {
  return stringValue(readPath(value, path));
}

function numberAt(value: unknown, path: string): number | undefined {
  const found = readPath(value, path);
  return typeof found === "number" ? found : undefined;
}

function arrayAt(value: unknown, path: string): unknown[] {
  const found = readPath(value, path);
  return Array.isArray(found) ? found : [];
}

function readPath(value: unknown, path: string): unknown {
  let cursor = value;
  for (const part of path.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
