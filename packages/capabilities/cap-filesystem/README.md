# `@render-harness/cap-filesystem`

Path-scoped filesystem tools for agents in the Render harness. Opt-in per agent.

## Why this isn't a core builtin

The production worker pserv is multi-tenant: one Node process holds every tenant's env vars and runs every tenant's agent against a shared filesystem. A core-default filesystem tool would let any prompt-injected agent exfiltrate secrets from `/proc/self/environ` or read another tenant's files off a mounted disk.

This pack makes filesystem access an explicit per-agent decision: you opt in, you choose the root path, and you decide whether writes are allowed.

When a future per-run sandboxed runtime exists, an unscoped filesystem tool becomes safe by default. Until then, every agent that needs files uses this pack.

## Tools

All paths are joined to the configured `root` and rejected if they escape it (including via `..` traversal or symlinks pointing outside).

| Tool | Description |
|---|---|
| `fs.read_file({ path })` | Read a UTF-8 text file. Output capped at `maxBytes`; full body recoverable via `fetch_full_result`. |
| `fs.list_dir({ path })` | List directory entries with type (`dir` / `file` / `link` / `other`) and file sizes. |
| `fs.write_file({ path, content })` | Write a UTF-8 file. Auto-creates parent directories. Disabled when `readOnly: true`. |
| `fs.delete_file({ path })` | Delete a file. Refuses to delete directories. Disabled when `readOnly: true`. |

## Configuration

```yaml
capabilities:
  - pack: "@render-harness/cap-filesystem"
    config:
      root: "/var/data/agent-workspace"   # required, absolute path
      readOnly: false                     # optional, default false
      maxBytes: 1048576                   # optional, default 1 MB
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `root` | string | — | **Required.** Absolute path the agent can read/write under. |
| `readOnly` | boolean | `false` | When true, only `fs.read_file` and `fs.list_dir` register. |
| `maxBytes` | integer | `1048576` | Cap for read truncation and write rejection. |

## On Render

On Render, point `root` at a [persistent disk](https://render.com/docs/disks) mount (e.g. `/var/data`) so the files survive across deploys. Without a disk, `root` must point at the container's ephemeral filesystem, which is wiped on every redeploy.

## Multi-tenant safety

This pack alone does NOT make the worker multi-tenant safe — it scopes the *path*, not the *tenant*. If you run a multi-tenant agent and want each tenant to see only their own files, set the root per tenant at agent-definition time:

```ts
defineAgent({
  // ...
  capabilities: [
    {
      pack: "@render-harness/cap-filesystem",
      config: { root: `/var/data/tenants/${tenantId}` },
    },
  ],
});
```

The harness runs one `defineAgent()` call per tenant in this shape; the pack instances don't share scopes.

## Test commands

```sh
pnpm --filter @render-harness/cap-filesystem build
pnpm --filter @render-harness/cap-filesystem test
```
