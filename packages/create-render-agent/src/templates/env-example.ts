import { type Answers, scriptRunner } from "../types.js";

/**
 * `.env.example` for the scaffolded project. Always lists the model API
 * key and DATABASE_URL. Adds operator-UI env vars when the UI is enabled.
 * Capability-contributed env vars are *not* enumerated here — those land
 * in render.yaml via the build bin (which reads the pack's contributed
 * envSchema at build time).
 */
export function envExample(answers: Answers): string {
  const run = scriptRunner(answers.packageManager);
  const uiBlock = answers.ui
    ? `
# Required when the operator UI is mounted: bearer token end users log in with.
WEB_API_KEY=

# Required when the operator UI is mounted: signing secret for session cookies.
# Generate with: openssl rand -hex 32
UI_COOKIE_SECRET=
`
    : "";
  return `# Required: model API key.
ANTHROPIC_API_KEY=

# Local datastore stack (\`${run} db:up\`). Override in production.
DATABASE_URL=postgres://harness:harness@127.0.0.1:55432/harness
KV_URL=redis://127.0.0.1:56379
${uiBlock}
# Optional: Render API key, only if you wire the Render MCP.
# RENDER_API_KEY=
`;
}
