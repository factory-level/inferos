// Keeps `test-projects.ts` in step with the directory: every test file runs in exactly one vitest
// project, so `vitest run` still runs them all, and none lands somewhere it cannot work.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BACKEND, UNIT_NODE, WORKERD_LIGHT } from "./test-projects.js";

const here = import.meta.dirname;
const PROJECTS = { "unit-node": UNIT_NODE, "workerd-light": WORKERD_LIGHT, backend: BACKEND };
const onDisk = readdirSync(here).filter(file => file.endsWith(".test.ts"));

/**
 * Whether `source` reaches the backend Worker: a static or dynamic import of `cloudflare:test`
 * (which evaluates `test-worker.ts` as the pool's `main`) or of `test-worker` itself.
 */
function loadsBackend(source: string): boolean {
  return /(?:from\s*|import\s+|import\s*\(\s*)["'](?:cloudflare:test|\.\/test-worker(?:\.[jt]s)?)["']/u.test(source);
}

/**
 * Whether `source` replaces a module or the clock, which the `backend` project's shared module graph
 * and isolate would carry into the next file (`vi.mock` is never undone between files there).
 */
function replacesModulesOrClock(source: string): boolean {
  return /\bvi\.(?:mock|doMock|useFakeTimers|setSystemTime)\b/u.test(source);
}

/** `backend` files allowed to use `vi.mock`, fake timers or system time, each with its reason. */
const BACKEND_MODULE_OR_CLOCK_EXCEPTIONS: Readonly<Record<string, string>> = {};

const read = (file: string) => readFileSync(path.join(here, file), "utf-8");

describe("test projects", () => {
  it("place every test file in exactly one project", () => {
    let placed = new Map<string, string[]>();
    for (let [project, files] of Object.entries(PROJECTS)) {
      for (let file of files) placed.set(file, [...(placed.get(file) ?? []), project]);
    }
    let misplaced = onDisk.filter(file => placed.get(file)?.length !== 1)
      .map(file => `${file}: ${placed.get(file)?.join(", ") || "no project"}`);
    expect(misplaced).toEqual([]);
    expect([...placed.keys()].filter(file => !onDisk.includes(file))).toEqual([]);
  });

  it("keep every file that loads the backend in the backend project", () => {
    expect(onDisk.filter(file => loadsBackend(read(file)) && !BACKEND.includes(file))).toEqual([]);
  });

  it("keep module mocks, fake timers and system time out of the backend project", () => {
    expect(BACKEND.filter(file =>
      replacesModulesOrClock(read(file)) && !(file in BACKEND_MODULE_OR_CLOCK_EXCEPTIONS))).toEqual([]);
  });

  // The fixtures are assembled from pieces so that this file's own source matches neither check.
  it("recognize what the checks above look for", () => {
    let cfTest = ["cloudflare", "test"].join(":");
    let worker = ["./test", "worker"].join("-");
    let vi = "vi";
    expect(loadsBackend(`import { env } from "${cfTest}";`)).toBe(true);
    expect(loadsBackend(`const t = await import("${cfTest}");`)).toBe(true);
    expect(loadsBackend(`import "${worker}.js";`)).toBe(true);
    expect(loadsBackend(`import  '${worker}';`)).toBe(true);
    expect(loadsBackend(`import type { X } from "${worker}.ts";`)).toBe(true);
    expect(loadsBackend(`import { y } from "${worker}";`)).toBe(true);
    expect(loadsBackend(`import { env } from "cloudflare:workers";`)).toBe(false);
    expect(loadsBackend(`import { z } from "./test-projects.js";`)).toBe(false);
    expect(replacesModulesOrClock(`${vi}.mock("jose", () => ({}));`)).toBe(true);
    expect(replacesModulesOrClock(`${vi}.doMock(path);`)).toBe(true);
    expect(replacesModulesOrClock(`${vi}.useFakeTimers();`)).toBe(true);
    expect(replacesModulesOrClock(`${vi}.setSystemTime(0);`)).toBe(true);
    expect(replacesModulesOrClock("vi.stubGlobal('fetch', f); vi.useRealTimers();")).toBe(false);
  });
});
