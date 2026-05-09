---
name: summary-format
description: How to format the final cron-run summary message.
when_to_use: At the very end of the run, after every tracked query has been audited and recorded.
---

# Summary format

Produce a single Markdown message in this exact shape. The team reads it directly out of the agent's final assistant message in Postgres; consistency matters more than prose.

```
## Citations summary — <ISO date, UTC>

- Audited **N** queries against **<engine>**.
- **M of N** mentioned the target brand (cite rate: P%).
- **K of N** errored or were skipped (list them under "Skipped" below).

### Cited queries

- *<query text>* — short note about how the brand was framed (positive / neutral / hedged).

### Not cited

- *<query text>* — what the engine recommended instead (1 line).

### Skipped

- *<query text>* — reason.

### Notable competitors mentioned

- **<competitor>** — N times across the audited responses.
```

Rules:

- Use UTC for the date. The cron runs in UTC; reporting in any other zone confuses the dataset.
- "Cite rate" is `(cited / (audited - skipped)) * 100`, rounded to the nearest whole percent. If `audited - skipped` is zero, write "n/a" instead of dividing.
- Sort each list alphabetically by the query's first 40 chars to make week-over-week diffs easy to read.
- "Notable competitors" is the union of distinct brand names you saw across all audited responses, with counts. Only include brands that appeared in at least 2 different queries' answers — single mentions are noise.
- If everything was cited, the "Not cited" section becomes a single line: `- (none)`. Same for "Skipped" and "Notable competitors" when empty.
