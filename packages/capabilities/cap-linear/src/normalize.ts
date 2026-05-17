export interface LinearFilterConfig {
  allowedTeams?: string[];
  allowedProjects?: string[];
  states?: string[];
  labels?: string[];
  ignoredActors?: string[];
}

export interface NormalizedLinearEvent {
  type: string;
  action?: string;
  organizationId?: string;
  teamId?: string;
  teamKey?: string;
  projectId?: string;
  issueId?: string;
  issueIdentifier?: string;
  state?: string;
  actorId?: string;
  url?: string;
  summary: string;
}

export function normalizeLinearEvent(
  body: unknown,
  cfg: LinearFilterConfig = {},
): NormalizedLinearEvent | null {
  if (!body || typeof body !== "object") return null;
  const payload = body as Record<string, unknown>;
  const type = stringValue(payload.type);
  if (!type) return null;
  const action = stringValue(payload.action);
  const data = objectValue(payload.data);
  if (!data) return null;

  const actorId = stringAt(payload, "actor.id") ?? stringAt(payload, "actorId");
  if (actorId && cfg.ignoredActors?.includes(actorId)) return null;
  const teamId = stringAt(data, "team.id") ?? stringAt(data, "teamId");
  const teamKey = stringAt(data, "team.key");
  if (cfg.allowedTeams?.length && !matchesAny([teamId, teamKey], cfg.allowedTeams)) return null;
  const projectId = stringAt(data, "project.id") ?? stringAt(data, "projectId");
  const projectName = stringAt(data, "project.name");
  if (cfg.allowedProjects?.length && !matchesAny([projectId, projectName], cfg.allowedProjects)) {
    return null;
  }
  const state = stringAt(data, "state.name") ?? stringAt(data, "state");
  if (cfg.states?.length && state && !cfg.states.includes(state)) return null;
  if (cfg.labels?.length && !hasAllowedLabel(data, cfg.labels)) return null;

  const issueId = stringValue(data.id);
  const issueIdentifier = stringValue(data.identifier);
  return {
    type,
    ...(action ? { action } : {}),
    organizationId: stringValue(payload.organizationId),
    ...(teamId ? { teamId } : {}),
    ...(teamKey ? { teamKey } : {}),
    ...(projectId ? { projectId } : {}),
    ...(issueId ? { issueId } : {}),
    ...(issueIdentifier ? { issueIdentifier } : {}),
    ...(state ? { state } : {}),
    ...(actorId ? { actorId } : {}),
    url: stringValue(data.url),
    summary: `Linear ${type}${issueIdentifier ? ` ${issueIdentifier}` : ""} ${action ?? "changed"}`,
  };
}

function hasAllowedLabel(data: Record<string, unknown>, allowed: string[]): boolean {
  const labels = arrayValue(data.labels)
    .map((label) =>
      label && typeof label === "object" ? stringValue((label as { name?: unknown }).name) : null,
    )
    .filter((label): label is string => !!label);
  return labels.some((label) => allowed.includes(label));
}

function matchesAny(values: Array<string | undefined>, allowed: string[]): boolean {
  return values.some((value) => value !== undefined && allowed.includes(value));
}

function stringAt(value: unknown, path: string): string | undefined {
  let cursor = value;
  for (const part of path.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return stringValue(cursor);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
