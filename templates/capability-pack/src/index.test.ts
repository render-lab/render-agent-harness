import { describe, expect, it } from "vitest";
import pack from "./index.js";

describe("cap-example", () => {
  it("hides write tools in read mode", async () => {
    const tools = await pack.localTools?.({
      config: {},
      env: () => "test-key",
      entryName: "test",
    });
    expect(tools?.map((tool) => tool.definition.name)).toEqual(["example.read"]);
  });

  it("exposes write tools in read_write mode", async () => {
    const tools = await pack.localTools?.({
      config: { accessMode: "read_write" },
      env: () => "test-key",
      entryName: "test",
    });
    expect(tools?.map((tool) => tool.definition.name)).toEqual(["example.read", "example.write"]);
  });
});
