---
name: auditing-protocol
description: How to determine whether the target brand was cited in an AI search engine response.
when_to_use: When you have a raw response from `query_search_engine` and need to decide what to record.
---

# Auditing protocol

You're checking whether a brand (`target_brand`, default "Render") shows up in an AI search engine's answer to a tracked query. Apply this protocol consistently so the data is comparable across runs.

## What counts as a citation

Mark `was_cited = true` if **any** of these hold:

- The brand name appears in the body of the answer, attached to a recommendation, comparison, or example. Example: "platforms like Render, Railway, and Fly.io" counts.
- The brand appears as a linked source, even if not named in body text. Example: a "Sources" list including `render.com/docs/...`.
- The answer paraphrases content clearly from the brand's docs, blog, or guides, even if the brand isn't named.

Mark `was_cited = false` if:

- The brand name doesn't appear and no linked sources point to brand-owned domains.
- The brand is mentioned only in a competing context that doesn't reflect product fit. Example: "I tried Render once and didn't like it" with no further detail. Note the negative mention in `response_excerpt`.

## What to put in `response_excerpt`

A 1–3 sentence quote that shows the actual relevant context. Aim for the smallest excerpt that conveys the citation (or lack of it). Don't paraphrase; copy the exact wording so the team can grep audits later.

If the response was long and the brand wasn't cited at all, summarize the recommended alternatives in one sentence. Example: "Recommended Vercel, Netlify, and Cloudflare Pages; Render not mentioned."

## What to put in `sources`

Pass the structured sources array from the search engine response, if available. Each item should have a `url` and optional `title`. Empty array if the engine didn't surface sources.

## Edge cases

- If `query_search_engine` errors or returns an empty response, **do not** record an audit. Move on to the next query and call this out in the final summary.
- If the engine returns a refusal ("I can't recommend specific brands"), record `was_cited = false`, set `response_excerpt` to a short paraphrase of the refusal, and put `[]` for sources.
- Treat brand variants as the same brand: `Render`, `Render.com`, `render.com`, and `Render Inc.` all count.
