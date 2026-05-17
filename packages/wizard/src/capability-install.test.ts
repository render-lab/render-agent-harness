import { describe, expect, it } from "vitest";
import {
  mutateCapabilityInstallYaml,
  mutateEnvExample,
  mutatePackageJsonAddDependency,
  planCapabilityInstall,
} from "./capability-install.js";

const YAML = `schemaVersion: 1
name: support-bot
description: Support bot
harnessVersion: "^0.1"
shared:
  model:
    provider: anthropic
    model: claude-sonnet-4-6
agents:
  - id: support-bot
    agent: { kind: builtin, ref: chat, systemPrompt: hi }
    runtimes:
      - kind: web
      - kind: worker
        queue: support-runs
`;

describe("capability install mutators", () => {
  it("adds Slack capability config and approval-gates write tools", () => {
    const plan = planCapabilityInstall({
      yamlText: YAML,
      install: {
        agentId: "support-bot",
        pack: "@render-harness/cap-slack",
        accessMode: "read_write",
      },
    });
    const out = mutateCapabilityInstallYaml({ yamlText: YAML, plan });
    expect(out).toContain('pack: "@render-harness/cap-slack"');
    expect(out).toContain("accessMode: read_write");
    expect(out).toContain("cap-slack__slack_get_thread");
    expect(out).toContain("cap-slack__slack_send_message");
    expect(out).toContain("requireApproval");
  });

  it("blocks connector installs without a worker runtime", () => {
    expect(() =>
      planCapabilityInstall({
        yamlText: YAML.replace(/ {6}- kind: worker\n {8}queue: support-runs\n/, ""),
        install: {
          agentId: "support-bot",
          pack: "@render-harness/cap-slack",
          accessMode: "read",
        },
      }),
    ).toThrow(/worker runtime/);
  });

  it("adds package dependencies", () => {
    const out = mutatePackageJsonAddDependency({
      jsonText: JSON.stringify({ dependencies: { foo: "1.0.0" } }),
      packageName: "@render-harness/cap-slack",
      versionRange: "^0.1.1",
    });
    expect(JSON.parse(out).dependencies["@render-harness/cap-slack"]).toBe("^0.1.1");
  });

  it("adds missing env vars without values", () => {
    const out = mutateEnvExample({
      text: "ANTHROPIC_API_KEY=\n",
      envVars: ["SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN"],
    });
    expect(out).toContain("SLACK_SIGNING_SECRET=");
    expect(out).toContain("SLACK_BOT_TOKEN=");
  });
});
