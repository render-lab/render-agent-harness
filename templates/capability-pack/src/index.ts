import type { LocalToolHandler } from "@render-harness/core";
import { type ConnectorContribution, definePack, type PackContext } from "@render-harness/registry";

interface ExampleConfig {
  accessMode?: "read" | "read_write";
  apiKeyEnv?: string;
  webhookSecretEnv?: string;
}

const pack = definePack({
  name: "cap-example",
  version: "0.1.0",
  envSchema: [
    {
      name: "EXAMPLE_API_KEY",
      required: true,
      secret: true,
      description: "API key for the example provider.",
    },
    {
      name: "EXAMPLE_WEBHOOK_SECRET",
      required: false,
      secret: true,
      description: "Secret used to verify example webhooks.",
    },
  ],
  localTools(ctx: PackContext): LocalToolHandler[] {
    const cfg = readConfig(ctx.config);
    const apiKey = ctx.env(cfg.apiKeyEnv);
    if (!apiKey) throw new Error(`cap-example: ${cfg.apiKeyEnv} is not set`);

    const tools: LocalToolHandler[] = [
      {
        definition: {
          name: "example.read",
          description: "Read example provider state.",
          source: "pack:cap-example",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
            },
            required: ["id"],
          },
        },
        handler: async ({ input }) => ({
          content: JSON.stringify({ ok: true, input }, null, 2),
        }),
      },
    ];

    if (cfg.accessMode === "read_write") {
      tools.push({
        definition: {
          name: "example.write",
          description: "Mutate example provider state. Exposed only in read_write mode.",
          source: "pack:cap-example",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              value: { type: "string" },
            },
            required: ["id", "value"],
          },
        },
        handler: async ({ input }) => ({
          content: JSON.stringify({ ok: true, input }, null, 2),
        }),
      });
    }

    return tools;
  },
  connectors(ctx: PackContext): ConnectorContribution[] {
    const cfg = readConfig(ctx.config);
    return [
      {
        key: "example",
        webhook: async (req, webCtx) => {
          // Always read the raw body before parsing if your provider signs
          // webhook payloads. Verify cfg.webhookSecretEnv here.
          const rawBody = await req.text();
          const agent = webCtx.resolveAgent();
          const result = await webCtx.enqueueRun({
            agentName: agent.name,
            agentVersion: agent.version,
            userId: "cap-example",
            initialContent: [{ type: "text", text: `Example event: ${rawBody}` }],
            metadata: { connector: "cap-example", webhookSecretEnv: cfg.webhookSecretEnv },
          });
          return Response.json(result, { status: result.status === "enqueued" ? 202 : 200 });
        },
      },
    ];
  },
});

export default pack;

function readConfig(config: Record<string, unknown>): Required<ExampleConfig> {
  return {
    accessMode: config.accessMode === "read_write" ? "read_write" : "read",
    apiKeyEnv: typeof config.apiKeyEnv === "string" ? config.apiKeyEnv : "EXAMPLE_API_KEY",
    webhookSecretEnv:
      typeof config.webhookSecretEnv === "string"
        ? config.webhookSecretEnv
        : "EXAMPLE_WEBHOOK_SECRET",
  };
}
