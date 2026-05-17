# `@render-harness/cap-webhook-generic`

Generic inbound webhook connector for agents in the Render harness.

Use this pack when an agent should receive webhook events from a service that does not have a dedicated capability pack yet.

## Configuration

Drop the pack into `render-harness.yaml`:

```yaml
capabilities:
  - pack: "@render-harness/cap-webhook-generic"
    config:
      secretEnv: "WEBHOOK_SECRET"
      signatureHeader: "X-Signature-256"
      requireSignature: true
      textPath: "message.text"
      metadataPaths:
        sourceId: "id"
```

Set `WEBHOOK_SECRET` on the entry that loads the agent when signature verification is required.

## Connector

The pack mounts the `webhook-generic` connector at `/connectors/webhook-generic`.

Each accepted webhook delivery enqueues one harness run. The run's initial text comes from `textHeader`, `textPath`, the parsed body, or the raw body, in that order.

## Signatures

By default, the connector requires an HMAC signature:

- Secret env var: `WEBHOOK_SECRET`
- Signature header: `X-Signature-256`
- Algorithm: `sha256`

Set `requireSignature: false` only for trusted internal sources or local development.

## Config Keys

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `agent` | string | default agent | Agent name to enqueue runs for. |
| `userId` | string | `cap-webhook-generic` | User ID stored on enqueued runs. |
| `secretEnv` | string | `WEBHOOK_SECRET` | Env var that contains the HMAC secret. |
| `signatureHeader` | string | `X-Signature-256` | Header that contains the request signature. |
| `signaturePrefix` | string | none | Optional prefix to strip or match, such as `sha256=`. |
| `algorithm` | string | `sha256` | HMAC algorithm used for signature verification. |
| `idHeader` | string | none | Header used as the provider delivery ID and run ID seed. |
| `requireSignature` | boolean | `true` | Verifies signatures before enqueueing runs. |
| `textPath` | string | none | Dot path in the JSON body to use as the run text. |
| `textHeader` | string | none | Header to use as the run text. |
| `metadataPaths` | object | none | Map of metadata keys to dot paths in the JSON body. |

## Tools

This pack contributes a connector only. It does not register local tools.

## Test Commands

```sh
pnpm --filter @render-harness/cap-webhook-generic build
pnpm --filter @render-harness/cap-webhook-generic test
```
