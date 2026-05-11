import type { Gallery, ScaffoldResponse, WizardState } from "./types.js";

export async function fetchGallery(): Promise<Gallery> {
  const res = await fetch("/api/gallery");
  if (!res.ok) throw new Error(`gallery fetch failed: ${res.status}`);
  return (await res.json()) as Gallery;
}

export async function postScaffold(args: {
  state: WizardState;
  turnstileToken: string;
}): Promise<ScaffoldResponse> {
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
      turnstileToken: args.turnstileToken,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "unknown" }))) as {
      error: string;
      details?: string;
    };
    throw new Error(`${body.error}${body.details ? `: ${body.details}` : ""}`);
  }
  return (await res.json()) as ScaffoldResponse;
}
