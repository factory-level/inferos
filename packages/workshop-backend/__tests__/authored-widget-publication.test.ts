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
    ["overlong source paths", {
      "client.tsx": "export default function Widget(){ return <div/> }",
      [`${"a".repeat(509)}.tsx`]: "export {};",
    }],
    ["overlong multibyte source paths", {
      "client.tsx": "export default function Widget(){ return <div/> }",
      [`${"é".repeat(300)}.tsx`]: "export {};",
    }],
    ...["\0", "\x01", "\x1f", "\x7f", "\u0080", "\u009f"].map((control, index) => [
      `control character ${index}`,
      {
        "client.tsx": "export default function Widget(){ return <div/> }",
        [`bad${control}name.tsx`]: "export {};",
      },
    ]),
    ...[
      ["backslash", "folder\\widget.tsx"],
      ["absolute path", "/widget.tsx"],
      ["Windows drive path", "C:/widget.tsx"],
      ["parent traversal", "../widget.tsx"],
      ["double dot in name", "release..tsx"],
      ["current-directory segment", "folder/./widget.tsx"],
      ["parent-directory segment", "folder/../widget.tsx"],
      ["empty path segment", "folder//widget.tsx"],
      ["fullwidth slash", "folder／widget.tsx"],
      ["division slash", "folder∕widget.tsx"],
      ["fraction slash", "folder⁄widget.tsx"],
      ["bidi override", "folder\u202Ewidget.tsx"],
      ["zero-width space", "folder\u200Bwidget.tsx"],
      // QA at e910f6b4: paths outside the source suffixes used to skip validation entirely.
      ["trailing slash", "a/"],
      ["trailing dot", "a.tsx."],
      ["trailing space", "a.tsx "],
    ].map(([label, path]) => [
      `${label} path`,
      {
        "client.tsx": "export default function Widget(){ return <div/> }",
        [path]: "export {};",
      },
    ]),
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
    const refusal = expect(run()).rejects;
    if (String(_case).includes("path") || String(_case).includes("character")) {
      await refusal.toThrow("Invalid source path.");
    } else await refusal.toThrow();
    expect(getCalls).toBe(0);
    expect(compileCalls).toBe(0);
  });

  it.each([
    ["fails to compile", async () => { throw new Error("worker terminated"); }],
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
    if (_failure === "fails to compile") {
      await expect(run()).rejects.toThrow("Build failed: the widget could not be compiled.");
    } else {
      await expect(run()).rejects.toThrow("Build failed: it ran out of resources; try fewer or smaller files.");
    }
    expect(refusalEvents).toBe(1);
    expect(writes).toBe(0);
  });

  it.each([
    "Invalid TypeScript syntax.",
    "Unapproved package import.",
    "Denied global.",
    "Dynamic import refused.",
    "Dynamic code loading refused.",
    "import.meta refused.",
    "Missing default component export.",
    "External CSS resources are not allowed.",
    "Invalid source path.",
  ]) (
    "preserves the fixed, source-free validation refusal %s", async message => {
      const run = compileAuthoredWidgetPublication({
        enabled: true, sourceCommitId: "source-commit",
        gitStore: { readCommitFiles: async () => new Map(source), writeFilesAsCommit: async () => "unused" } as never,
        builds: { newUniqueId: () => "build-id", get: () => ({ compile: async () => { throw new Error(message); } }) },
        author: async () => ({ name: "test", email: "test@example.com" }) as never,
        onFailure: () => {},
      });
      await expect(run).rejects.toThrow(message);
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

  it("accepts a multibyte source path at the 512 UTF-8 byte boundary", async () => {
    let calls = 0;
    const run = compileAuthoredWidgetPublication({
      enabled: true, sourceCommitId: "source-commit",
      gitStore: {
        readCommitFiles: async () => new Map([
          ["client.tsx", "export default function Widget(){ return <div/> }"],
          [`${"é".repeat(254)}.tsx`, "export {};"],
        ]),
        writeFilesAsCommit: async () => "compiled-commit",
      } as never,
      builds: { newUniqueId: () => "build-id", get: () => ({ compile: async () => {
        calls++;
        return {clientJs: "compiled", durationMs: 1, clientBytes: 8};
      } }) },
      author: async () => ({ name: "test", email: "test@example.com" }) as never,
      onFailure: () => {},
    });
    await expect(run).resolves.toBe("compiled-commit");
    expect(calls).toBe(1);
  });

  it("keeps safe companion files and sends only the .tsx and .css sources to the build", async () => {
    let sent: Readonly<Record<string, string>> | undefined;
    let written: Map<string, string> | undefined;
    const files = new Map([
      ["client.tsx", "export default function Widget(){ return <div/> }"],
      ["styles/main.css", ".widget { color: red }"],
      ["blueprint.json", "{}"], ["states.json", "{}"], ["tools.json", "[]"], ["notes.json", "{}"],
      ["package.json", "{\"name\":\"ignored-by-compiler\"}"], ["lib/package.json", "{}"],
      ["server.js", "export default {}"], ["server.ts", "export default {}"],
      ["lib/util.ts", "export const value = 1"], ["README.md", "Widget notes"],
      ["icon.svg", "<svg/>"], ["LICENSE", "license"], ["payload.exe", "ignored"], ["metadata", "plain companion"],
      ["client.js", "stale"],
    ]);
    const result = await compileAuthoredWidgetPublication({
      enabled: true, sourceCommitId: "source-commit",
      gitStore: {
        readCommitFiles: async () => new Map(files),
        writeFilesAsCommit: async (out: Map<string, string>) => { written = new Map(out); return "compiled-commit"; },
      } as never,
      builds: { newUniqueId: () => "build-id",
        get: () => ({ compile: async (input: Readonly<Record<string, string>>) => { sent = input; return { clientJs: "compiled" }; } }) },
      author: async () => ({ name: "test", email: "test@example.com" }) as never,
      onFailure: () => {},
    });
    expect(result).toBe("compiled-commit");
    expect(Object.keys(sent ?? {}).toSorted()).toEqual(["client.tsx", "styles/main.css"]);
    expect([...written!.keys()].toSorted()).toEqual([...files.keys()].toSorted());
    expect(written!.get("client.js")).toBe("compiled");
  });
});
