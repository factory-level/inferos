// Keeps `test-projects.ts` in step with the directory: every test file runs in exactly one vitest
// project, so `vitest run` still runs them all, and none lands somewhere it cannot work.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BACKEND, UNIT_NODE, WORKERD_LIGHT } from "./test-projects.js";

const here = import.meta.dirname;
const PROJECTS = { "unit-node": UNIT_NODE, "workerd-light": WORKERD_LIGHT, backend: BACKEND };
const onDisk = readdirSync(here).filter(file => file.endsWith(".test.ts"));

/** A file that reaches the backend Worker: `cloudflare:test` evaluates it as the pool's `main`. */
function loadsBackend(file: string): boolean {
  let source = readFileSync(path.join(here, file), "utf-8");
  return /from ["']cloudflare:test["']|["']\.\/test-worker(\.js)?["']/u.test(source);
}

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
    expect(onDisk.filter(file => loadsBackend(file) && !BACKEND.includes(file))).toEqual([]);
  });
});
