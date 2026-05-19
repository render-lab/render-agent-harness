import { describe, expect, it } from "vitest";
import {
  mutateCapabilityInstallYaml,
  mutateEnvExample,
  mutatePackageJsonAddDependency,
  planCapabilityInstall,
} from "./capability-install.js";

// support-bot ships with a strict `shared.permissions.allowedTools`
// allowlist in its gallery template. The capability install mutator
// must grow it (and pull Tier A builtins in alongside) so the agent
// doesn't silently lose load_skill / fetch_url / etc.
const YAML_RESTRICTIVE = `schemaVersion: 1
name: support-bot
description: Support bot
harnessVersion: "^0.1"
shared:
  model:
    provider: anthropic
    model: claude-sonnet-4-6
  permissions:
    allowedTools:
      - cap-slack__slack_get_thread
      - cap-slack__slack_get_channel_history
agents:
  - id: support-bot
    agent: { kind: builtin, ref: chat, systemPrompt: hi }
    runtimes:
      - kind: web
      - kind: worker
        queue: support-runs
`;

// chat-agent style: no allowedTools at all. The install should NOT
// introduce a restriction (otherwise it strips every other tool the
// agent had).
const YAML_OPEN = `schemaVersion: 1
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
  it("adds Slack capability config, approval-gates write tools, and grows the existing allowlist (read+write+Tier A)", () => {
    const plan = planCapabilityInstall({
      yamlText: YAML_RESTRICTIVE,
      install: {
        agentId: "support-bot",
        pack: "@render-harness/cap-slack",
        accessMode: "read_write",
      },
    });
    const out = mutateCapabilityInstallYaml({ yamlText: YAML_RESTRICTIVE, plan });
    expect(out).toContain('pack: "@render-harness/cap-slack"');
    expect(out).toContain("accessMode: read_write");
    // Slack write tools land in allowedTools because the allowlist was
    // already non-empty.
    expect(out).toContain("cap-slack__slack_send_message");
    expect(out).toContain("requireApproval");
    // Tier A builtins must be added alongside, otherwise installing a
    // capability silently strips load_skill / fetch_url / etc.
    expect(out).toContain("load_skill");
    expect(out).toContain("fetch_url");
    expect(out).toContain("ask_user");
  });

  it("leaves an open agent (no allowedTools) open instead of introducing a restriction", () => {
    const plan = planCapabilityInstall({
      yamlText: YAML_OPEN,
      install: {
        agentId: "support-bot",
        pack: "@render-harness/cap-slack",
        accessMode: "read_write",
      },
    });
    const out = mutateCapabilityInstallYaml({ yamlText: YAML_OPEN, plan });
    expect(out).toContain('pack: "@render-harness/cap-slack"');
    // requireApproval is fine to introduce — it's a deny-by-default
    // list, not an allowlist — but allowedTools must stay absent so we
    // don't accidentally restrict every other tool the agent had.
    expect(out).toContain("requireApproval");
    expect(out).not.toMatch(/^\s*allowedTools:/m);
  });

  it("does not add write tools when accessMode is read", () => {
    const plan = planCapabilityInstall({
      yamlText: YAML_RESTRICTIVE,
      install: {
        agentId: "support-bot",
        pack: "@render-harness/cap-slack",
        accessMode: "read",
      },
    });
    const out = mutateCapabilityInstallYaml({ yamlText: YAML_RESTRICTIVE, plan });
    expect(out).toContain("cap-slack__slack_get_thread");
    expect(out).not.toContain("cap-slack__slack_send_message");
  });

  it("accepts newly-registered packs (e.g. cap-search-exa) and adds MCP tool names + Tier A to a restrictive allowlist", () => {
    const plan = planCapabilityInstall({
      yamlText: YAML_RESTRICTIVE,
      install: {
        agentId: "support-bot",
        pack: "@render-harness/cap-search-exa",
        accessMode: "read",
      },
    });
    const out = mutateCapabilityInstallYaml({ yamlText: YAML_RESTRICTIVE, plan });
    expect(out).toContain('pack: "@render-harness/cap-search-exa"');
    expect(out).toContain("cap-search-exa__web_search_exa");
    expect(out).toContain("cap-search-exa__web_fetch_exa");
    expect(out).toContain("load_skill");
  });

  it("blocks connector installs without a worker runtime", () => {
    expect(() =>
      planCapabilityInstall({
        yamlText: YAML_OPEN.replace(/ {6}- kind: worker\n {8}queue: support-runs\n/, ""),
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
