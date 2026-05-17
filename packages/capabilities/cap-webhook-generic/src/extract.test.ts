import { describe, expect, it } from "vitest";
import { extractWebhookPayload, readPath } from "./extract.js";

describe("readPath", () => {
  it("reads dotted JSON paths", () => {
    expect(readPath({ payload: { issue: { body: "hello" } } }, "payload.issue.body")).toBe("hello");
  });

  it("returns undefined for missing paths", () => {
    expect(readPath({ payload: {} }, "payload.issue.body")).toBeUndefined();
  });
});

describe("extractWebhookPayload", () => {
  it("extracts text and metadata from configured paths", () => {
    const parsedBody = {
      payload: {
        message: "triage this",
        repository: { full_name: "render/render-harness" },
        issue: { number: 42 },
      },
    };
    const extracted = extractWebhookPayload({
      headers: new Headers(),
      parsedBody,
      rawBody: JSON.stringify(parsedBody),
      config: {
        textPath: "payload.message",
        metadataPaths: {
          repo: "payload.repository.full_name",
          issue_number: "payload.issue.number",
        },
      },
    });
    expect(extracted).toEqual({
      text: "triage this",
      metadata: { repo: "render/render-harness", issue_number: 42 },
    });
  });

  it("can use a header as the initial text", () => {
    const headers = new Headers({ "x-event-summary": "build failed" });
    const extracted = extractWebhookPayload({
      headers,
      parsedBody: {},
      rawBody: "{}",
      config: { textHeader: "x-event-summary" },
    });
    expect(extracted.text).toBe("build failed");
  });
});
