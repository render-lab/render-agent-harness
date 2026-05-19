---
name: figma-comments
description: Read and post comments on Figma files (replies, pin coordinates).
when_to_use: When the user asks you to leave feedback on a design, reply to a comment thread, or summarize comments on a file.
---

# Working with Figma comments

The cap-figma pack exposes two comment tools:

- `figma.read_comments({ file_key, as_md? })` — list comments on a file. Pass `as_md: true` for a markdown-style thread instead of raw JSON.
- `figma.post_comment({ file_key, message, comment_id?, client_meta? })` — post a new comment OR reply to an existing thread. Requires `accessMode: "read_write_comments"` on the pack config.

## When to read comments

`read_comments` is much cheaper than `read_file` for "what's everyone talking about on this design?" Typical pattern:

1. `read_comments({ file_key, as_md: true })` to get the thread overview.
2. If a comment references a node by id, `read_file_nodes({ file_key, ids: ["..."] })` to pull just that subtree.
3. Summarize / respond.

Top-level comments have `parent_id: null`. Replies have `parent_id` set to the thread root's id. Resolved comments have `resolved_at` set; you can usually skip them when summarizing what's still actionable.

## Posting a new comment

Three pinning modes:

**Free-floating comment** (default — no `client_meta`):

```
figma.post_comment({ file_key, message: "..." })
```

**Pinned to coordinates** on the page (rarely useful — Figma's UI pins are usually attached to a node):

```
figma.post_comment({
  file_key,
  message: "...",
  client_meta: { x: 100, y: 200 }
})
```

**Pinned to a node** (most useful — the comment travels with the node when the design changes):

```
figma.post_comment({
  file_key,
  message: "...",
  client_meta: {
    node_id: "123:456",
    node_offset: { x: 20, y: 10 }   // relative to the node's top-left
  }
})
```

## Replying to a thread

Pass the parent's comment id:

```
figma.post_comment({
  file_key,
  message: "Replying to your point about contrast...",
  comment_id: "<parent-comment-id>"
})
```

Replies inherit the parent's pin location automatically.

## Tone

Customer comments on Figma files are usually short, action-oriented, and signed (Figma shows your handle automatically). Match that — don't write essays in a comment. If you need to say more, post a short comment with a link to a longer doc.

## When `post_comment` returns 403

The connected access token doesn't include `file_comments:write`. This means the pack is configured with `accessMode: "read"` (the read mode only has `file_comments:read`). The operator needs to:

1. Edit `render-harness.yaml`: set `accessMode: "read_write_comments"` on cap-figma.
2. Redeploy.
3. Open the operator UI → Connections tab → Disconnect Figma → Reconnect (so the new scope set lands in the user's grant).

The pack's tool error spells this out — pass the message through to the user verbatim.

## What this skill doesn't cover

- **Resolving / unresolving comments.** Figma's REST API doesn't expose the resolve toggle; it's a Plugin API call only. The user can do it in the Figma UI directly.
- **Reactions.** Same — not in REST.
- **@mentions.** Figma's comment body accepts Figma's `@user` syntax but resolving it to a user requires knowing their email — out of scope for v1.
