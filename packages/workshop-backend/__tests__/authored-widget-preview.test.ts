import { describe, expect, it } from "vitest";
import { compileAuthoredWidgetSources, MAX_AUTHORED_WIDGET_PREVIEW_BYTES } from "../src/authored-widget-publication.js";

const sources = { "client.tsx": "export default function Widget(){ return <div/> }" };

function buildHarness(compile: (files: Readonly<Record<string, string>>) => Promise<{
  clientJs: string; durationMs: number; clientBytes: number;
}>) {
  let allocated = 0;
  let nextId = 0;
  const builds = {
    newUniqueId: () => ++nextId,
    get: () => {
      allocated++;
      return { compile };
    },
  };
  const run = (timeoutMs?: number) => compileAuthoredWidgetSources({
    sources, builds, timeoutMs, maxOutputBytes: MAX_AUTHORED_WIDGET_PREVIEW_BYTES, onFailure: () => {},
  });
  return { run, get allocated() { return allocated; } };
}

describe("authored widget preview compiler boundary", () => {
  it("returns only compiled code and measurements", async () => {
    const test = buildHarness(async () => ({ clientJs: "compiled", durationMs: 7, clientBytes: 8 }));
    await expect(test.run()).resolves.toEqual({ clientJs: "compiled", durationMs: 7, clientBytes: 8 });
    expect(test.allocated).toBe(1);
  });

  it("refuses compiler errors without exposing their text", async () => {
    const test = buildHarness(async () => { throw new Error("private source content"); });
    await expect(test.run()).rejects.toThrow("Build failed: the widget could not be compiled.");
  });

  it("refuses when the build deadline expires", async () => {
    const test = buildHarness(() => new Promise(() => {}));
    await expect(test.run(1)).rejects.toThrow("Build failed: it ran out of resources; try fewer or smaller files.");
  });

  it("refuses oversized compiled output", async () => {
    const test = buildHarness(async () => ({
      clientJs: "é".repeat(MAX_AUTHORED_WIDGET_PREVIEW_BYTES / 2 + 1),
      durationMs: 1,
      clientBytes: MAX_AUTHORED_WIDGET_PREVIEW_BYTES + 2,
    }));
    await expect(test.run()).rejects.toThrow("Build output size limit exceeded.");
  });

  it("isolates concurrent previews with separate build objects", async () => {
    const test = buildHarness(async files => ({ clientJs: files["client.tsx"]!, durationMs: 1, clientBytes: 2 }));
    const [first, second] = await Promise.all([test.run(), test.run()]);
    expect(first.clientJs).toBe(sources["client.tsx"]);
    expect(second.clientJs).toBe(sources["client.tsx"]);
    expect(test.allocated).toBe(2);
  });
});
