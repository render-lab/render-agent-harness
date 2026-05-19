---
"create-render-agent": patch
---

`npx create-render-agent deploy-key --repo owner/name` now auto-registers the public key on the repo via the [GitHub CLI](https://cli.github.com/) when `gh` is installed and `gh auth status` succeeds. The "paste public key into GitHub" step is replaced with a confirmation line; you only have to set the two Render env vars yourself.

- When `gh` isn't installed or you aren't logged in, the same command prints the manual paste instructions plus an actionable hint (install `gh`, or run `gh auth login`).
- Pass `--no-gh` to opt out and always print the manual instructions (useful for testing, scripts, or when you don't want the CLI to mutate the repo).
- When the key is already registered on the repo (re-running), the call short-circuits to a friendly "already registered" message instead of erroring.

The keypair generator is unchanged; only the orchestration around it is additive. Existing scripts that parse the printed output should still work — the paste blocks are removed only when registration succeeds.
