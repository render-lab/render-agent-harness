# Plan: Pluggable sandbox execution providers

## Context

The harness intentionally does not expose terminal, arbitrary filesystem, or code execution tools from core. That boundary matters because the production worker can be multi-tenant: one Node process may hold credentials for many users and agents. At the same time, agent products increasingly need a place to try code, mutate a checkout, run tests, inspect generated artifacts, or delegate work to an isolated environment.

Render-native sandboxes are not available yet. This plan defines the capability boundary now so deployments can use interim providers such as Modal, Daytona, E2B, CodeSandbox, Fly Machines, or Kubernetes jobs without making any of them part of the core runtime. When Render sandboxes become available, they should be another provider behind the same interface.

## Goals

- Add an opt-in sandbox capability for code execution and workspace mutation.
- Keep core free of terminal and arbitrary filesystem tools.
- Support external sandbox backends through adapters, not hard-coded provider logic.
- Make the security story explicit: scoped tools, read-only context, approval gates, resource limits, network policy, and audit logs.
- Preserve a path to first-party Render sandboxes without forcing a later API rewrite.

## Non-goals

- Do not claim that policy controls alone are a secure code sandbox.
- Do not add shell or filesystem builtins to `@render-harness/core`.
- Do not operate a hosted arbitrary-code execution backend before there is an isolation boundary we trust.
- Do not make Modal, Daytona, or any other interim provider a required dependency.

## Product shape

Sandbox support should be described as graduated isolation:

1. **Default:** no arbitrary execution. Agents use typed builtins, MCP tools, SSRF-protected URL fetches, Workflows, and capability packs.
2. **Policy sandbox:** per-agent tool allowlists, approval gates, scoped secrets, network allowlists, rate limits, and audit logs.
3. **Context sandbox:** `@url`, `@file`, `@run`, and `@deployment` attachments are read-only by default. Filesystem access requires `@render-harness/cap-filesystem` with a path allowlist.
4. **Deployment sandbox:** preview environments, throwaway services, or Workflow-backed jobs provide an isolated blast radius for trusted code paths.
5. **Execution sandbox:** an optional capability provisions an isolated workspace through a provider adapter, runs commands, returns artifacts, and tears the workspace down.

Only the fifth layer should be called a sandbox without qualification.

## Provider strategy

Use a provider interface and adapter packages:

- `@render-harness/cap-sandbox` defines the user-facing tools, config schema, and provider contract.
- `@render-harness/sandbox-modal`, `@render-harness/sandbox-daytona`, and similar packages implement the contract.
- A future `@render-harness/sandbox-render` package implements the same contract for Render-native sandboxes.

Provider fit:

| Provider type | Best fit | Cautions |
|---|---|---|
| Modal | Ephemeral Python or container jobs, batch execution, data tasks, possible GPU paths | Less natural for long-lived repo workspaces or interactive development |
| Daytona | Per-agent development environments, cloned repos, filesystem mutation, longer-lived sessions | Workspace lifecycle, cost, and cleanup need clear controls |
| E2B or CodeSandbox | Notebook-like execution, generated app previews, browser-visible artifacts | Provider-specific packaging and network behavior can leak into UX |
| Fly Machines or Kubernetes jobs | Infra-native container isolation for teams already operating those platforms | More operational burden for users |
| Render sandboxes | Future first-party default for Render deployments | Not available yet; design the interface now and defer the adapter |

Do not pick a default interim provider for all users. Let deployments opt in based on their workload and risk tolerance.

## Capability contract

The provider contract should express workspace lifecycle, command execution, file exchange, resource policy, and cleanup:

```ts
export interface SandboxProvider {
  createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRef>;
  uploadFiles(workspace: WorkspaceRef, files: SandboxFile[]): Promise<void>;
  runCommand(
    workspace: WorkspaceRef,
    command: SandboxCommand,
    options?: SandboxRunOptions,
  ): Promise<SandboxExecutionResult>;
  readFiles(workspace: WorkspaceRef, paths: string[]): Promise<SandboxFileResult[]>;
  destroyWorkspace(workspace: WorkspaceRef): Promise<void>;
}
```

The v1 provider contract should avoid exposing raw provider SDK objects to agents. Provider-specific details belong in adapter config and execution metadata.

## Agent tools

`cap-sandbox` should expose a small tool surface:

- `sandbox.create_workspace` creates an ephemeral workspace from optional repo, branch, image, and initial files.
- `sandbox.run_command` runs one command with timeout, output limits, and an optional approval requirement.
- `sandbox.read_files` returns selected files or artifacts from the workspace.
- `sandbox.destroy_workspace` tears down a workspace early.

Avoid a general interactive terminal in v1. Commands should be discrete, logged, bounded, and replayable from run history.

## Configuration

Example deployment config:

```yaml
capabilities:
  - pack: "@render-harness/cap-sandbox"
    config:
      provider: "modal"
      providerPackage: "@render-harness/sandbox-modal"
      maxDurationSeconds: 600
      maxOutputBytes: 200000
      network: "allowlist"
      allowedHosts:
        - "registry.npmjs.org"
        - "pypi.org"
      secrets:
        mode: "explicit-only"
        allow:
          - "NPM_TOKEN"
      approvals:
        runCommand: "required"
        networkFullAccess: "required"
```

Supported network modes:

- `disabled`: no outbound network.
- `allowlist`: outbound network only to configured hosts.
- `full`: unrestricted outbound network, approval-gated by default.

Secrets should be explicit-only. No adapter should inherit the worker process environment by default.

## Safety requirements

Every provider adapter must support:

- Workspace TTL and best-effort cleanup on run completion or cancellation.
- Hard timeout for each command.
- Output truncation before model context injection, with full output stored as an artifact when possible.
- No default access to application secrets.
- Network policy config, even if the adapter can only enforce some modes.
- Structured execution logs: command, cwd, exit code, duration, output references, provider workspace id, and cleanup status.
- Per-agent tool allowlists through existing permissions.

If a provider cannot enforce a requested safety control, it should fail at startup instead of silently weakening isolation.

## Storage and audit trail

Store sandbox activity alongside normal tool traces:

- Tool calls and tool results remain in `agent_tool_calls` and `agent_tool_results`.
- Large stdout, stderr, generated files, and archives become sandbox artifacts referenced from the tool result.
- `agent_runs.metadata` can include active workspace ids during execution, but cleanup must not depend only on metadata being present.

Add a small artifact abstraction only when the first provider needs it. Until then, adapters can return text summaries and selected files through `sandbox.read_files`.

## UI

The operator UI should show:

- Active and completed workspaces for a run.
- Commands, status, duration, and exit code.
- Truncated stdout and stderr with a way to fetch full output.
- Generated artifacts and files selected by the agent.
- Approval prompts for risky commands, full network access, long-running jobs, and secret exposure.

The UI should not present the sandbox as a local terminal. The mental model is "bounded execution step with artifacts."

## Rollout

1. Document the sandbox capability contract and config shape.
2. Implement `cap-sandbox` with a mock provider for local tests.
3. Add one real adapter only after a concrete user or demo requires it. Daytona is the better first adapter for repo-mutating coding agents; Modal is the better first adapter for ephemeral command or data jobs.
4. Add UI panels for sandbox activity and approval prompts.
5. Add provider conformance tests that verify timeout, cleanup, output limits, and secret isolation.
6. Add the Render-native adapter when Render sandboxes are available.

## Open questions

- Should sandbox workspaces be attached to a run only, or can a reviewed operator promote one to a longer-lived project workspace?
- What artifact store should back large outputs: Postgres, object storage, provider-native storage, or a capability-provided blob interface?
- Which network controls can each provider enforce, and how should adapters report partial support?
- Should `sandbox.run_command` always require human approval in hosted demo mode?
- How should Workflows checkpoint a long-running sandbox task without keeping a provider workspace alive longer than necessary?
