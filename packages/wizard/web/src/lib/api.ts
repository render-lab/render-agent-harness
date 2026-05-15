import type {
  Gallery,
  ScaffoldJobResponse,
  ScaffoldProgressEvent,
  ScaffoldResponse,
  WizardState,
} from "./types.js";

export async function fetchGallery(): Promise<Gallery> {
  const res = await fetch("/api/gallery");
  if (!res.ok) throw new Error(`gallery fetch failed: ${res.status}`);
  return (await res.json()) as Gallery;
}

export async function postScaffold(args: {
  state: WizardState;
  turnstileToken: string;
}): Promise<ScaffoldJobResponse> {
  const res = await fetch("/api/scaffold", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentName: args.state.agentName,
      description: args.state.description,
      systemPrompt: args.state.systemPrompt,
      model: args.state.model,
      runtimes: args.state.runtimes,
      capabilities: args.state.capabilities,
      ui: args.state.ui,
      templateSlug: args.state.templateSlug,
      bundleSlug: null,
      turnstileToken: args.turnstileToken,
    }),
  });
  return parseJsonResponse<ScaffoldJobResponse>(res);
}

export async function postBundleScaffold(args: {
  bundleSlug: string;
  agentName: string;
  description: string;
  turnstileToken: string;
}): Promise<ScaffoldJobResponse> {
  const res = await fetch("/api/scaffold", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentName: args.agentName,
      description: args.description,
      systemPrompt: "",
      // Server ignores model/runtimes/capabilities/ui in bundle mode,
      // but the request schema still requires the fields. Stable defaults.
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      runtimes: [],
      capabilities: [],
      ui: false,
      templateSlug: args.bundleSlug,
      bundleSlug: args.bundleSlug,
      turnstileToken: args.turnstileToken,
    }),
  });
  return parseJsonResponse<ScaffoldJobResponse>(res);
}

async function parseJsonResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "unknown" }))) as {
      error: string;
      details?: string;
    };
    throw new Error(`${body.error}${body.details ? `: ${body.details}` : ""}`);
  }
  return (await res.json()) as T;
}

export function watchScaffoldJob(
  jobId: string,
  onEvent: (event: ScaffoldProgressEvent) => void,
): Promise<ScaffoldResponse> {
  return new Promise((resolve, reject) => {
    const source = new EventSource(`/api/scaffold/${encodeURIComponent(jobId)}/stream`);

    source.addEventListener("progress", (event) => {
      const parsed = JSON.parse(event.data) as ScaffoldProgressEvent;
      onEvent(parsed);
    });
    source.addEventListener("done", (event) => {
      const parsed = JSON.parse(event.data) as Extract<ScaffoldProgressEvent, { type: "done" }>;
      onEvent(parsed);
      source.close();
      resolve(parsed.result);
    });
    source.addEventListener("error", (event) => {
      if ("data" in event && typeof event.data === "string" && event.data.length > 0) {
        const parsed = JSON.parse(event.data) as Extract<ScaffoldProgressEvent, { type: "error" }>;
        onEvent(parsed);
        source.close();
        reject(new Error(parsed.message));
        return;
      }
      source.close();
      reject(new Error("scaffold progress stream disconnected"));
    });
  });
}
