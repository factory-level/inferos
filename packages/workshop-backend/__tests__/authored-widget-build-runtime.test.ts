import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authoredWidgetDependencies } from "../src/generated/authored-widget-dependencies.js";
import { compileAuthoredWidgetWithWasm } from "../src/authored-widget-build-compiler.js";

const minimalWidget = {
  "client.tsx": 'export default function Widget(){ return <div>hello</div> }',
};
const wasmModule = readFile(new URL("../node_modules/esbuild-wasm/esbuild.wasm", import.meta.url))
  .then(bytes => WebAssembly.compile(bytes));
const priorSelf = (globalThis as typeof globalThis & { self?: unknown }).self;

beforeAll(() => {
  Object.defineProperty(globalThis, "self", { configurable: true, value: globalThis });
});

afterAll(() => {
  if (priorSelf === undefined) delete (globalThis as typeof globalThis & { self?: unknown }).self;
  else Object.defineProperty(globalThis, "self", { configurable: true, value: priorSelf });
});

describe("authored widget Worker compiler", () => {
  it("compiles a self-contained widget with the in-process WASM worker pool", async () => {
    const result = await compileAuthoredWidgetWithWasm(minimalWidget, await wasmModule);

    expect(result.clientJs).toContain("hello");
    expect(result.clientJs).not.toMatch(/^\s*import\s/mu);
    expect(result.clientBytes).toBe(new TextEncoder().encode(result.clientJs).byteLength);
  });

  it("refuses a dependency edge missing from the reviewed closure", async () => {
    const resolutions = authoredWidgetDependencies.resolutions as Record<string, string>;
    const edge = `${authoredWidgetDependencies.roots.react}::./cjs/react.production.js`;
    const previous = resolutions[edge];
    expect(previous).toBeDefined();
    delete resolutions[edge];

    try {
      await expect(compileAuthoredWidgetWithWasm(minimalWidget, await wasmModule)).rejects.toThrow(
        "Authored widget refused: dependency outside the reviewed closure.",
      );
    } finally {
      resolutions[edge] = previous!;
    }
  });
});
