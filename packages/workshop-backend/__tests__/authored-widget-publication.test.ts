import { describe, expect, it } from "vitest";
import { compileAuthoredWidgetPublication } from "../src/authored-widget-publication.js";

const source = new Map([
  ["client.tsx", "export default function Widget(){ return <div/> }"],
  ["style.css", ".widget { color: red }"],
  ["blueprint.json", "{\"title\":\"kept\"}"],
]);

function harness(compile: (files: Readonly<Record<string, string>>) => Promise<{clientJs: string}>) {
  let written: { files: Map<string, string>; options: unknown } | undefined;
  let calls = 0;
  const gitStore = {
    readCommitFiles: async () => new Map(source),
    writeFilesAsCommit: async (files: Map<string, string>, options: unknown) => {
      written = { files: new Map(files), options };
      return "compiled-commit";
    },
  };
  const builds = {
    newUniqueId: () => "build-id",
    get: () => ({ compile: async (files: Readonly<Record<string, string>>) => {
      calls++;
      return compile(files);
    } }),
  };
  const run = (enabled = true, timeoutMs = 15_000) => compileAuthoredWidgetPublication({
    enabled, sourceCommitId: "source-commit", gitStore: gitStore as never,
    builds, author: async () => ({ name: "test", email: "test@example.com" }) as never,
    onFailure: () => {}, timeoutMs,
  });
  return { run, get written() { return written; }, get calls() { return calls; } };
}

describe("authored widget publication commit boundary", () => {
  it("keeps the source commit and makes no DO call when the flag is off", async () => {
    const test = harness(async () => ({ clientJs: "compiled" }));
    await expect(test.run(false)).resolves.toBe("source-commit");
    expect(test.calls).toBe(0);
    expect(test.written).toBeUndefined();
  });

  it.each([
    ["unapproved imports", { "client.tsx": 'import fs from "node:fs"; export default function Widget(){ return <div/> }' }],
    ["too many files", Object.fromEntries([
      ["client.tsx", "export default function Widget(){ return <div/> }"],
      ...Array.from({length: 100}, (_, index) => [`extra-${index}.tsx`, "export {};" ]),
    ])],
  ])("rejects %s before allocating or calling the build DO", async (_case, authoredFiles) => {
    let getCalls = 0;
    let compileCalls = 0;
    const run = () => compileAuthoredWidgetPublication({
      enabled: true,
      sourceCommitId: "source-commit",
      gitStore: {
        readCommitFiles: async () => new Map([
          ...Object.entries(authoredFiles), ["notes.json", "{}"],
        ]),
        writeFilesAsCommit: async () => { throw new Error("must not write"); },
      } as never,
      builds: {
        newUniqueId: () => "build-id",
        get: () => {
          getCalls++;
          return { compile: async () => { compileCalls++; return {clientJs: ""}; } };
        },
      },
      author: async () => ({ name: "test", email: "test@example.com" }) as never,
      onFailure: () => {},
    });
    await expect(run()).rejects.toThrow();
    expect(getCalls).toBe(0);
    expect(compileCalls).toBe(0);
  });

  it.each([
    ["throws", async () => { throw new Error("worker terminated"); }],
    ["resets", async () => { throw new Error("Durable Object reset"); }],
    ["misses the deadline", () => new Promise<{clientJs: string}>(() => {})],
  ])("refuses when the build DO %s and does not write a commit", async (_failure, compile) => {
    let refusalEvents = 0;
    let writes = 0;
    const run = () => compileAuthoredWidgetPublication({
      enabled: true, sourceCommitId: "source-commit",
      gitStore: { readCommitFiles: async () => new Map(source), writeFilesAsCommit: async () => {
        writes++;
        return "should-not-exist";
      } } as never,
      builds: { newUniqueId: () => "build-id", get: () => ({ compile }) },
      author: async () => ({ name: "test", email: "test@example.com" }) as never,
      onFailure: () => { refusalEvents++; }, timeoutMs: 5,
    });
    await expect(run()).rejects.toThrow("Build failed: it ran out of resources; try fewer or smaller files.");
    expect(refusalEvents).toBe(1);
    expect(writes).toBe(0);
  });

  it("stores original sources and compiled client.js in a child commit", async () => {
    const test = harness(async files => {
      expect(files).toEqual({
        "client.tsx": source.get("client.tsx"),
        "style.css": source.get("style.css"),
      });
      return { clientJs: "export default 1" };
    });
    await expect(test.run()).resolves.toBe("compiled-commit");
    expect(test.written?.files).toEqual(new Map([...source, ["client.js", "export default 1"]]));
    expect(test.written?.options).toMatchObject({
      parents: ["source-commit"], message: "Build authored widget for publication",
    });
  });
});
