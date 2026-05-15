import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pack from "./index.js";

const noopArgs = {
  runId: "r",
  toolCallId: "c",
  signal: new AbortController().signal,
  logger: {} as never,
};

describe("cap-filesystem", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cap-fs-test-"));
  });

  afterEach(async () => {
    // mkdtemp dirs go away when tmp gets cleaned; nothing to do.
  });

  it("registers four tools when readOnly: false", async () => {
    const tools = await pack.localTools?.({
      config: { root },
      env: () => undefined,
      entryName: "x",
    });
    const names = tools.map((t) => t.definition.name).sort();
    expect(names).toEqual(["fs.delete_file", "fs.list_dir", "fs.read_file", "fs.write_file"]);
  });

  it("registers two tools when readOnly: true", async () => {
    const tools = await pack.localTools?.({
      config: { root, readOnly: true },
      env: () => undefined,
      entryName: "x",
    });
    const names = tools.map((t) => t.definition.name).sort();
    expect(names).toEqual(["fs.list_dir", "fs.read_file"]);
  });

  it("throws if config.root is missing", async () => {
    await expect(
      pack.localTools?.({ config: {}, env: () => undefined, entryName: "x" }),
    ).rejects.toThrow(/`config.root` is required/);
  });

  it("reads a file under the root", async () => {
    await writeFile(join(root, "hi.txt"), "hello world", "utf8");
    const tools = await pack.localTools?.({
      config: { root },
      env: () => undefined,
      entryName: "x",
    });
    const read = tools.find((t) => t.definition.name === "fs.read_file");
    if (!read) throw new Error("expected fs.read_file");
    const out = await read.handler({ input: { path: "hi.txt" }, ...noopArgs });
    expect(out.content).toBe("hello world");
  });

  it("rejects path traversal", async () => {
    const tools = await pack.localTools?.({
      config: { root },
      env: () => undefined,
      entryName: "x",
    });
    const read = tools.find((t) => t.definition.name === "fs.read_file");
    if (!read) throw new Error("expected fs.read_file");
    const out = await read.handler({ input: { path: "../../etc/passwd" }, ...noopArgs });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/escapes the configured root/);
  });

  it("rejects absolute paths outside root", async () => {
    const tools = await pack.localTools?.({
      config: { root },
      env: () => undefined,
      entryName: "x",
    });
    const read = tools.find((t) => t.definition.name === "fs.read_file");
    if (!read) throw new Error("expected fs.read_file");
    const out = await read.handler({ input: { path: "/etc/passwd" }, ...noopArgs });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/escapes the configured root/);
  });

  it("rejects symlinks pointing outside root", async () => {
    // Stage an escape target outside the scoped root that actually exists,
    // so realpath resolves rather than ENOENTing.
    const escapeRoot = await mkdtemp(join(tmpdir(), "cap-fs-escape-"));
    const escapeTarget = join(escapeRoot, "secret.txt");
    await writeFile(escapeTarget, "shh", "utf8");
    await symlink(escapeTarget, join(root, "escape"));
    const tools = await pack.localTools?.({
      config: { root },
      env: () => undefined,
      entryName: "x",
    });
    const read = tools.find((t) => t.definition.name === "fs.read_file");
    if (!read) throw new Error("expected fs.read_file");
    const out = await read.handler({ input: { path: "escape" }, ...noopArgs });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/escapes the configured root/);
  });

  it("lists directory entries", async () => {
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "a.txt"), "a", "utf8");
    const tools = await pack.localTools?.({
      config: { root },
      env: () => undefined,
      entryName: "x",
    });
    const ls = tools.find((t) => t.definition.name === "fs.list_dir");
    if (!ls) throw new Error("expected fs.list_dir");
    const out = await ls.handler({ input: { path: "." }, ...noopArgs });
    expect(out.content).toContain("file\ta.txt");
    expect(out.content).toContain("dir\tsub");
  });

  it("writes a new file and creates parent directories", async () => {
    const tools = await pack.localTools?.({
      config: { root },
      env: () => undefined,
      entryName: "x",
    });
    const write = tools.find((t) => t.definition.name === "fs.write_file");
    if (!write) throw new Error("expected fs.write_file");
    const out = await write.handler({
      input: { path: "nested/dir/file.txt", content: "hi" },
      ...noopArgs,
    });
    expect(out.isError).toBeFalsy();
    const persisted = await readFile(join(root, "nested/dir/file.txt"), "utf8");
    expect(persisted).toBe("hi");
  });

  it("rejects writes that exceed maxBytes", async () => {
    const tools = await pack.localTools?.({
      config: { root, maxBytes: 4 },
      env: () => undefined,
      entryName: "x",
    });
    const write = tools.find((t) => t.definition.name === "fs.write_file");
    if (!write) throw new Error("expected fs.write_file");
    const out = await write.handler({
      input: { path: "x.txt", content: "12345" },
      ...noopArgs,
    });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/exceeds cap of 4 bytes/);
  });

  it("truncates reads larger than maxBytes", async () => {
    await writeFile(join(root, "big.txt"), "x".repeat(100), "utf8");
    const tools = await pack.localTools?.({
      config: { root, maxBytes: 10 },
      env: () => undefined,
      entryName: "x",
    });
    const read = tools.find((t) => t.definition.name === "fs.read_file");
    if (!read) throw new Error("expected fs.read_file");
    const out = await read.handler({ input: { path: "big.txt" }, ...noopArgs });
    expect(out.content).toMatch(/truncated at 10 bytes/);
  });

  it("deletes a file", async () => {
    await writeFile(join(root, "gone.txt"), "x", "utf8");
    const tools = await pack.localTools?.({
      config: { root },
      env: () => undefined,
      entryName: "x",
    });
    const del = tools.find((t) => t.definition.name === "fs.delete_file");
    if (!del) throw new Error("expected fs.delete_file");
    const out = await del.handler({ input: { path: "gone.txt" }, ...noopArgs });
    expect(out.isError).toBeFalsy();
    await expect(readFile(join(root, "gone.txt"))).rejects.toThrow();
  });

  it("refuses to delete directories", async () => {
    await mkdir(join(root, "keep"));
    const tools = await pack.localTools?.({
      config: { root },
      env: () => undefined,
      entryName: "x",
    });
    const del = tools.find((t) => t.definition.name === "fs.delete_file");
    if (!del) throw new Error("expected fs.delete_file");
    const out = await del.handler({ input: { path: "keep" }, ...noopArgs });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/refusing to delete directory/);
  });
});
