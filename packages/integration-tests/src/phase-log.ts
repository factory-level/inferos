// Phase timestamps for the integration suite, written to a file and never to stdout or stderr.
//
// The suite runs under the `with-timeout.ts` idle watchdog, which resets on every output chunk. A
// line printed here would reset it at every phase boundary and change which silences it catches, so
// these go to `node_modules/.vite/integration-phases.jsonl` instead (a path the task's fingerprint
// already excludes; `global-setup.ts` truncates it per run). After a failed CI run,
// `scripts/vp/last-run-report.ts` prints its tail and the longest gaps, which locate the quiet
// interval the watchdog only reports as "no output for 60s".
//
// Registered first as a setup file, so under vitest's default hook order its `beforeAll`/`beforeEach`
// run before the file's own and its `afterEach`/`afterAll` after them: `suite-start` to the first
// `test-start` spans the file's own `beforeAll` (typically the Worker boot), and `test-start` to
// `test-end` spans the test with its own per-test hooks. Only file paths, test names and states are
// recorded -- never arguments, payloads or environment. Writing is best effort and can never fail a
// test.

import { appendFileSync } from "node:fs";
import { relative } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import { PACKAGE_DIR, PHASE_LOG } from "./phase-log-path.js";

/**
 * Per test file: vitest's default isolation evaluates this module afresh for each file, so one
 * runaway file cannot grow the log without bound.
 */
const MAX_EVENTS = 2_000;
const MAX_NAME = 160;

let written = 0;

function record(event: string, file: string | undefined, test?: string, state?: string): void {
  if (written >= MAX_EVENTS) return;
  written++;
  try {
    const entry = {
      t: new Date().toISOString(),
      pid: process.pid,
      event,
      file: file ? relative(PACKAGE_DIR, file) : null,
      ...(test === undefined ? {} : { test: test.slice(0, MAX_NAME) }),
      ...(state === undefined ? {} : { state }),
      ...(written === MAX_EVENTS ? { truncated: true } : {}),
    };
    appendFileSync(PHASE_LOG, `${JSON.stringify(entry)}\n`);
  } catch {
    // A diagnostic must not change the run it describes.
  }
}

beforeAll(() => { record("suite-start", expect.getState().testPath); });
beforeEach(context => { record("test-start", context.task.file?.filepath, context.task.name); });
afterEach(context => { record("test-end", context.task.file?.filepath, context.task.name, context.task.result?.state ?? "unknown"); });
afterAll(() => { record("suite-end", expect.getState().testPath); });
