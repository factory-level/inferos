import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authoredWidgetDependencies } from "../src/generated/authored-widget-dependencies.js";
import { compileAuthoredWidgetWithWasm } from "../src/authored-widget-build-compiler.js";

const minimalWidget = {
  "client.tsx": 'export default function Widget(){ return <div>hello</div> }',
};
/** A minimal authored Refine widget with a local data provider (FAC-15). */
const refineWidget = {
  "client.tsx": `import { Refine, useList, type DataProvider } from "@refinedev/core";
const local: DataProvider = {
  getApiUrl: () => "",
  getList: async () => ({ data: [{ id: 1, name: "Acme" }] as never, total: 1 }),
  getOne: async () => ({ data: { id: 1 } as never }),
  create: async () => { throw new Error("read-only"); },
  update: async () => { throw new Error("read-only"); },
  deleteOne: async () => { throw new Error("read-only"); },
};
const Rows = () => { const { result } = useList({ resource: "rows" }); return <ul>{result.data.map((row: { id: number }) => <li key={row.id}>{row.id}</li>)}</ul>; };
export default function Widget(){ return <Refine dataProvider={local} resources={[{ name: "rows" }]}><Rows /></Refine> }`,
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
  }, 15_000);

  // FAC-15: Refine reaches object-inspect, whose browser field maps ./util.inspect.js to false.
  // The closure names that module as browser-field disabled, and it compiles as an empty module.
  it("compiles an authored Refine widget, with its browser-field disabled module named in the closure", async () => {
    const disabled = (authoredWidgetDependencies as unknown as { disabled: { module: string; package: string; path: string; reason: string }[] }).disabled;
    expect(disabled).toEqual([expect.objectContaining({ package: "object-inspect", path: "util.inspect", reason: "browser-field disabled" })]);
    expect(authoredWidgetDependencies.files[disabled[0]!.module as keyof typeof authoredWidgetDependencies.files]).toBe("");
    const result = await compileAuthoredWidgetWithWasm(refineWidget, await wasmModule);
    expect(result.clientBytes).toBeGreaterThan(0);
    // The disabled module's own Node-only source (`module.exports = require('util').inspect;`) is no
    // longer bundled. (lodash-es keeps its guarded \`freeModule.require("util")\` feature probe, a
    // runtime check inside try/catch that the compiler's CommonJS-loader guard allows.)
    expect(result.clientJs).not.toMatch(/require\(\s*["']util["']\s*\)\.inspect/u);
    expect(result.clientJs).not.toContain("telemetry.refine.dev");
  }, 60_000);

  it("refuses a browser-field disabled module the reviewed closure doesn't name", async () => {
    const disabled = (authoredWidgetDependencies as unknown as { disabled: unknown[] }).disabled;
    const previous = disabled.splice(0, disabled.length);
    try {
      await expect(compileAuthoredWidgetWithWasm(refineWidget, await wasmModule)).rejects.toThrow(
        "Authored widget refused: dependency outside the reviewed closure.",
      );
    } finally {
      disabled.push(...previous);
    }
  }, 60_000);

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
