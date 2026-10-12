import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { describePhases, describeSummary, describeTask, report } from "./last-run-report.ts";

const script = join(dirname(fileURLToPath(import.meta.url)), "last-run-report.ts");
// Planted where vp records commands, paths and messages; the report must never print it.
const SENTINEL = "ghp_sentinelTOKEN0123456789";
const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const spawned = (outcome: unknown, cache: unknown = "Disabled") => ({ Spawned: { cache_status: cache, outcome } });
const task = (pkg: string, name: string, result: unknown) => ({ package_name: pkg, task_name: name, command: `vitest run --token ${SENTINEL}`, cwd: `/home/${SENTINEL}`, result });
const success = { Success: { infra_error: null, input_modified_path: null, fspy_unsupported: false, ipc_server_error: null, tracking_incomplete: false, tool_disabled_cache: false } };

/** The CI failure this report exists for: the watchdog's 124 plus the cancelled siblings. */
const summary = {
  exit_code: 1,
  tasks: [
    task("@gadgets/ui", "test", { CacheHit: { saved_duration_ms: 4429 } }),
    task("@gadgets/workshop-backend", "test", spawned({ Failed: { exit_code: 143 } }, { Miss: { InputChanged: { kind: "Modified", path: `src/${SENTINEL}.ts` } } })),
    task("@gadgets/integration-tests", "test", spawned({ Failed: { exit_code: 124 } }, { Miss: "NotFound" })),
    task("@gadgets/scripts", "test", spawned(success)),
    task("@gadgets/google-gatekeeper", "test", spawned({ SpawnError: { Spawn: { message: SENTINEL } } })),
    task("@gadgets/router", "build", spawned({ Success: { ...success.Success, infra_error: { PostRunFingerprint: { message: SENTINEL } } } })),
    task("@gadgets/x", "in", "InProcess"),
  ],
};

test("each task is reported by identity, outcome kind and exit code, never command, path or message", () => {
  const lines = describeSummary(summary);
  const text = lines.join("\n");
  assert.ok(!text.includes(SENTINEL), text);
  assert.equal(lines[0], "  exit code 1; 7 task(s), 4 not successful");
  // Not-successful tasks first, in summary order.
  assert.deepEqual(lines.slice(1, 5), [
    "  @gadgets/workshop-backend#test: FAILED exit 143; cache miss (InputChanged)",
    "  @gadgets/integration-tests#test: FAILED exit 124; cache miss (NotFound)",
    "  @gadgets/google-gatekeeper#test: SPAWN ERROR (Spawn); cache disabled",
    "  @gadgets/router#build: success with infrastructure error (PostRunFingerprint); cache disabled",
  ]);
  assert.ok(lines.includes("  @gadgets/ui#test: cache hit"));
  assert.ok(lines.includes("  @gadgets/scripts#test: success; cache disabled"));
  assert.ok(lines.includes("  @gadgets/x#in: in-process"));
  assert.equal(describeTask({ package_name: "a\u001b[31m", task_name: "b\nc", result: spawned(success) }), "  a??31m#b?c: success; cache disabled");
  assert.deepEqual(describeSummary({ nope: true }), ["  (unrecognized summary format)"]);
});

test("phase timings name what was still open and the longest silence", () => {
  const events = [
    { t: "2026-10-12T21:14:12.000Z", pid: 1, event: "suite-start", file: "__tests__/a.test.ts" },
    { t: "2026-10-12T21:14:13.000Z", pid: 1, event: "test-start", file: "__tests__/a.test.ts", test: "boots" },
    { t: "2026-10-12T21:14:14.000Z", pid: 1, event: "test-end", file: "__tests__/a.test.ts", test: "boots", state: "pass" },
    { t: "2026-10-12T21:14:14.500Z", pid: 2, event: "suite-start", file: "__tests__/b.test.ts" },
    { t: "2026-10-12T21:14:15.000Z", pid: 1, event: "test-start", file: "__tests__/a.test.ts", test: "hangs" },
    { t: "2026-10-12T21:15:05.000Z", pid: 2, event: "test-start", file: "__tests__/b.test.ts", test: `late ${"x".repeat(300)}` },
  ];
  const text = `${events.map(e => JSON.stringify(e)).join("\n")}\n{"t":"2026-10-12T21:15:0`;
  const lines = describePhases(text);
  assert.equal(lines[0], "  6 event(s), 2026-10-12T21:14:12.000Z to 2026-10-12T21:15:05.000Z");
  const open = lines.slice(lines.indexOf("  open at the end of the log (4):") + 1, lines.indexOf("  longest gaps between consecutive events:"));
  assert.deepEqual(open.map(line => line.trim().split(" ").slice(0, 5).join(" ")), [
    "2026-10-12T21:14:12.000Z pid 1 suite-start __tests__/a.test.ts",
    "2026-10-12T21:14:14.500Z pid 2 suite-start __tests__/b.test.ts",
    "2026-10-12T21:14:15.000Z pid 1 test-start __tests__/a.test.ts",
    "2026-10-12T21:15:05.000Z pid 2 test-start __tests__/b.test.ts",
  ]);
  const gaps = lines.slice(lines.indexOf("  longest gaps between consecutive events:") + 1);
  assert.equal(gaps[0], "    50.0s after 2026-10-12T21:14:15.000Z pid 1 test-start __tests__/a.test.ts > hangs");
  assert.ok(lines.every(line => line.length < 260), "names are bounded");
  assert.deepEqual(describePhases("not json\n"), ["  (no phase events recorded)"]);
});

const fixtureRoot = (summaryMtime: number, phaseMtime: number | null, markerMtime: number) => {
  const root = mkdtempSync(join(tmpdir(), "last-run-report-"));
  dirs.push(root);
  const summaryPath = join(root, "node_modules/.vite/task-cache/v18/last-summary.json");
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, JSON.stringify(summary));
  utimesSync(summaryPath, summaryMtime, summaryMtime);
  if (phaseMtime !== null) {
    const phasePath = join(root, "packages/integration-tests/node_modules/.vite/integration-phases.jsonl");
    mkdirSync(dirname(phasePath), { recursive: true });
    writeFileSync(phasePath, `${JSON.stringify({ t: "2026-10-12T21:14:12.000Z", pid: 1, event: "suite-start", file: "__tests__/a.test.ts" })}\n`);
    utimesSync(phasePath, phaseMtime, phaseMtime);
  }
  const marker = join(root, "marker");
  writeFileSync(marker, "");
  utimesSync(marker, markerMtime, markerMtime);
  return { root, marker };
};

test("only files written after the test step's start marker are reported; an earlier run's are withheld", () => {
  const fresh = fixtureRoot(2_000, 2_000, 1_000);
  const shown = report(["--since", fresh.marker], fresh.root);
  assert.ok(shown.includes("  @gadgets/integration-tests#test: FAILED exit 124; cache miss (NotFound)"));
  assert.ok(shown.includes("  1 event(s), 2026-10-12T21:14:12.000Z to 2026-10-12T21:14:12.000Z"));
  // The summary's mtime (2000 s) is the run's end; the one event is at 2026-10-12T21:14:12Z.
  assert.ok(shown.some(line => / from the last event to the end of the vp run/u.test(line)));
  const stale = fixtureRoot(500, 500, 1_000);
  const withheld = report(["--since", stale.marker], stale.root);
  assert.equal(withheld.filter(line => line.includes("older than this test step's start marker")).length, 2);
  assert.ok(!withheld.some(line => line.includes("FAILED")));
  const noPhases = fixtureRoot(2_000, null, 1_000);
  assert.ok(report(["--since", noPhases.marker], noPhases.root).includes("  withheld: not found"));
  assert.match(report(["--since", join(fresh.root, "missing")], fresh.root)[0]!, /start marker is missing/u);
  assert.match(report([], fresh.root)[0]!, /usage/u);
});

test("the CLI always exits 0, so it can never change the job's result", () => {
  for (const args of [[], ["--since", "/nonexistent/marker"], ["--since"]]) {
    const run = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^last-run-report: /u);
  }
});
