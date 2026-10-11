import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stdioFor, type OutputSinks } from "./own-output.ts";

/** The final-drain idle bound the fixture wrappers run with, in place of the 30s default. */
const DRAIN_IDLE_MS = 1_500;

const OWN_OUTPUT = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "own-output.ts"));

// Fixtures go under the OS temp directory, never in the workspace: this suite's `input` is
// workspace-wide (see `scripts/vite.config.ts`), so writing in here would be writing its own task
// input. Same discipline as `relay-termination.test.ts`.
const fixtureRoot = mkdtempSync(join(tmpdir(), "vp-own-output-"));
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

let caseCount = 0;

/** 64-byte lines, numbered per stream, so a dropped, duplicated or reordered chunk shows up. */
const LINE_FILLER = 48;
const line = (stream: string, n: number) =>
    `${stream} ${String(n).padStart(9, "0")} ${"x".repeat(LINE_FILLER)}\n`;
const LINES_PER_WRITE = 256;
/** One write of `LINES_PER_WRITE` lines is 16 KiB, so 1 MiB is 64 of them. */
const WRITES_PER_MIB = 64;

const expected = (stream: string, mib: number) =>
    Array.from({ length: mib * WRITES_PER_MIB * LINES_PER_WRITE }, (_, n) => line(stream, n)).join("");

// Shared by the fixtures that stand in for vp: large synchronous writes alternating between fd 1
// and fd 2 that, like vp's forwarding of task output, treat EAGAIN as fatal (exit 98) instead of
// retrying -- so the fixture survives only if a full stdout makes it wait rather than fail.
const burst = (mib: number) => `
  const { writeSync } = require("node:fs");
  const line = ${line.toString()};
  const LINE_FILLER = ${LINE_FILLER};
  function writeAll(fd, text) {
    const buffer = Buffer.from(text);
    for (let offset = 0; offset < buffer.length;) {
      try {
        offset += writeSync(fd, buffer, offset);
      } catch (error) {
        process.exit(error.code === "EAGAIN" ? 98 : 99);
      }
    }
  }
  let n = 0;
  for (let w = 0; w < ${mib * WRITES_PER_MIB}; w++) {
    let out = "", err = "";
    for (let i = 0; i < ${LINES_PER_WRITE}; i++, n++) { out += line("out", n); err += line("err", n); }
    writeAll(1, out);
    writeAll(2, err);
  }
`;

const BURST_CHILD = `${burst(4)}\nprocess.exit(3);\n`;

// The review's reproduction, as a stand-in vp: an uncached task (`cache: false`) gets vp's own
// stdout and stderr, and a Node one opens them as streams, which for a pipe sets O_NONBLOCK on the
// description vp writes to. While it is alive, vp forwards a cached sibling's 8 MiB burst.
const UNCACHED_TASK_VP = (readyFile: string) => `
  const { spawn } = require("node:child_process");
  const { existsSync } = require("node:fs");
  const task = spawn(process.execPath, ["-e",
      "process.stdout; process.stderr; require('node:fs').writeFileSync(" +
      ${JSON.stringify(JSON.stringify(readyFile))} + ", ''); setTimeout(() => {}, 60_000)"],
      { stdio: "inherit" });
  const started = Date.now();
  while (!existsSync(${JSON.stringify(readyFile)})) {
    if (Date.now() - started > 10_000) process.exit(97);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  ${burst(8)}
  task.kill("SIGKILL");
  process.exit(3);
`;

// Reports readiness, then on a signal writes to both streams after a short delay -- so the test
// also proves output produced *after* the forwarded signal still makes it out.
const SIGNAL_CHILD = `
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => setTimeout(() => {
      process.stdout.write("child got " + signal + "\\n");
      process.stderr.write("child got " + signal + "\\n");
      process.exit(0);
    }, 100));
  }
  process.stdout.write("ready " + process.pid + "\\n");
  setTimeout(() => {}, 60_000);
`;

// What an uncached task can leave behind: a detached grandchild still holding vp's stdout and
// writing to it after vp itself has exited. It must not keep the wrapper alive.
const DETACHED_GRANDCHILD_VP = `
  const { spawn } = require("node:child_process");
  const grandchild = spawn(process.execPath, ["-e",
      "setInterval(() => process.stdout.write('late\\\\n'), 200); setTimeout(() => process.exit(0), 30_000)"],
      { stdio: "inherit", detached: true });
  grandchild.unref();
  process.stdout.write("grandchild " + grandchild.pid + "\\n");
  setTimeout(() => process.exit(0), 300);
`;

// Leaves 2 MiB the reader will never take, then exits: the wrapper is left in its final drain.
const EXITS_INTO_STALLED_DRAIN = (exitedFile: string) => `
  require("node:fs").writeSync(1, Buffer.alloc(2 * 1024 * 1024, "y"));
  require("node:fs").writeFileSync(${JSON.stringify(exitedFile)}, "");
  process.exit(0);
`;

interface Run {
  wrapperPid: number;
  /** The `TMPDIR` the wrapper was given, so a case can check what it leaves there. */
  tmp: string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout: () => string;
  stderr: () => string;
  startReading: () => void;
  /** Resolves once both of the wrapper's output streams have closed. */
  closed: Promise<void>;
}

/**
 * Runs `childBody` under `spawnWithOwnOutput` in a wrapper process -- the composition `vp/run.ts`
 * uses -- and returns the wrapper's own output, which the test reads as slowly as it likes.
 *
 * After the spawn the wrapper also makes its own stdout non-blocking explicitly: an ancestor
 * sharing the description flipping it to O_NONBLOCK, the hazard with inherited stdio. It must not
 * reach the child either way.
 */
function runWrapper(childBody: string, { readDelayMs = 0, drainIdleMs }:
    { readDelayMs?: number; drainIdleMs?: number } = {}): Run {
  const dir = join(fixtureRoot, `case-${++caseCount}`);
  const tmp = join(dir, "tmp");
  mkdirSync(tmp, { recursive: true });
  const child = join(dir, "child.cjs");
  writeFileSync(child, childBody);
  const wrapper = join(dir, "wrapper.mjs");
  writeFileSync(wrapper, `
    import { spawnWithOwnOutput } from ${JSON.stringify(OWN_OUTPUT.href)};
    spawnWithOwnOutput(process.execPath, [${JSON.stringify(child)}],
        { graceMs: 2_000, finalDrainIdleMs: ${drainIdleMs ?? "undefined"} });
    process.stdout._handle?.setBlocking?.(false);
  `);

  const proc = spawn(process.execPath, [wrapper],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: tmp } });
  assert.ok(proc.pid, "the wrapper was not spawned");
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    proc.on("exit", (code, signal) => resolve({ code, signal }));
  });

  // Buffers, decoded once at the end, so a chunk boundary splitting a character cannot garble it.
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let reading = false;
  const startReading = () => {
    if (reading) return;
    reading = true;
    proc.stdout.on("data", (chunk: Buffer) => { out.push(chunk); });
    proc.stderr.on("data", (chunk: Buffer) => { err.push(chunk); });
  };
  // Not reading at all is the slow reader: the streams stay paused until a listener attaches, so
  // the wrapper's writes back up for the whole delay.
  if (readDelayMs === 0) startReading();
  else if (Number.isFinite(readDelayMs)) setTimeout(startReading, readDelayMs);

  const closed = Promise.all([proc.stdout, proc.stderr].map(
      stream => new Promise<void>(resolve => stream.once("close", resolve)))).then(() => undefined);
  return {
    wrapperPid: proc.pid,
    tmp,
    exit,
    stdout: () => Buffer.concat(out).toString(),
    stderr: () => Buffer.concat(err).toString(),
    startReading,
    closed,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return predicate();
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return true;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function kill(...pids: number[]): void {
  for (const pid of pids) {
    if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

/** Equality on two multi-MB strings, reported without a diff that would bury the failure. */
function assertSameText(name: string, actual: string, want: string): void {
  if (actual === want) return;
  let at = 0;
  while (at < want.length && actual[at] === want[at]) at++;
  assert.fail(`${name}: got ${actual.length} bytes, want ${want.length}; first difference at ${at}`);
}

/** Stand-in sinks for `stdioFor`, which reads nothing from them but `isTTY`. */
const sinks = (stdoutTTY: boolean, stderrTTY: boolean) =>
    ({ stdout: { isTTY: stdoutTTY }, stderr: { isTTY: stderrTTY } }) as unknown as OutputSinks;

describe("stdioFor", () => {
  it("captures both streams to files when neither is a TTY (CI)", () => {
    assert.deepEqual(stdioFor(sinks(false, false)), { stdout: "file", stderr: "file" });
  });

  it("inherits both streams at a terminal, keeping vp's colours and progress", () => {
    assert.deepEqual(stdioFor(sinks(true, true)), { stdout: "inherit", stderr: "inherit" });
  });

  it("decides per stream when only one is redirected", () => {
    assert.deepEqual(stdioFor(sinks(true, false)), { stdout: "inherit", stderr: "file" });
    assert.deepEqual(stdioFor(sinks(false, true)), { stdout: "file", stderr: "inherit" });
  });
});

describe("spawnWithOwnOutput", {
  concurrency: true,
  skip: process.platform === "win32" ? "the EAGAIN hazard and these signal fixtures are POSIX-only" : false,
}, () => {
  // The CI failure, as the review reproduced it against vp's own pipe: an uncached Node task
  // flips O_NONBLOCK inside vp's tree while vp forwards an 8 MiB burst, and the outer reader
  // stalls for 6s. On a pipe, vp's write fails with EAGAIN (98) once the pipe fills.
  it("survives an uncached task making vp's stdout non-blocking during a burst to a stalled reader", async () => {
    const readyFile = join(fixtureRoot, `uncached-ready-${++caseCount}`);
    const run = runWrapper(UNCACHED_TASK_VP(readyFile), { readDelayMs: 6_000 });
    assert.deepEqual(await run.exit, { code: 3, signal: null });
    await run.closed;
    assertSameText("stdout", run.stdout(), expected("out", 8));
    assertSameText("stderr", run.stderr(), expected("err", 8));
    assert.deepEqual(readdirSync(run.tmp), [], "the temp output files were left behind");
  });

  it("forwards a multi-MB burst intact to a slow reader and passes the exit code through", async () => {
    const run = runWrapper(BURST_CHILD, { readDelayMs: 1_500 });
    assert.deepEqual(await run.exit, { code: 3, signal: null });
    await run.closed;
    assertSameText("stdout", run.stdout(), expected("out", 4));
    assertSameText("stderr", run.stderr(), expected("err", 4));
    assert.deepEqual(readdirSync(run.tmp), [], "the temp output files were left behind");
  });

  for (const sent of ["SIGTERM", "SIGINT"] as const) {
    it(`forwards ${sent} to the child, drains its last output, and re-raises it`, async () => {
      const run = runWrapper(SIGNAL_CHILD);
      let childPid = 0;
      try {
        assert.ok(await waitFor(() => /^ready \d+$/m.test(run.stdout())), "the child never started");
        childPid = Number(/^ready (\d+)$/m.exec(run.stdout())?.[1]);
        // Unlinked as soon as the child has them open, so even a SIGKILL leaves nothing behind.
        assert.deepEqual(readdirSync(run.tmp), [], "the temp output files outlived the spawn");
        process.kill(run.wrapperPid, sent);
        assert.deepEqual(await run.exit, { code: null, signal: sent });
        await run.closed;
        assert.match(run.stdout(), new RegExp(`^child got ${sent}$`, "m"));
        assert.match(run.stderr(), new RegExp(`^child got ${sent}$`, "m"));
        assert.ok(!isAlive(childPid), "the child outlived the wrapper");
      } finally {
        kill(run.wrapperPid, childPid);
      }
    });
  }

  it("does not wait on a detached grandchild that still holds the output after the child exits", async () => {
    const run = runWrapper(DETACHED_GRANDCHILD_VP);
    let grandchildPid = 0;
    try {
      assert.ok(await waitFor(() => /^grandchild \d+$/m.test(run.stdout())), "no grandchild reported");
      grandchildPid = Number(/^grandchild (\d+)$/m.exec(run.stdout())?.[1]);
      const started = Date.now();
      // Raced so a wrapper that does wait on the grandchild fails here instead of hanging the suite.
      const timedOut = new Promise(resolve => setTimeout(() => resolve("still running after 10s"), 10_000));
      assert.deepEqual(await Promise.race([run.exit, timedOut]), { code: 0, signal: null });
      // The child exits after 300ms; a wrapper waiting on the grandchild would take its full 30s.
      assert.ok(Date.now() - started < 3_000, `the wrapper took ${Date.now() - started}ms to exit`);
      assert.ok(isAlive(grandchildPid), "fixture error: the grandchild should still be running");
    } finally {
      kill(run.wrapperPid, grandchildPid);
    }
  });

  it("gives up a final drain the reader never takes, after the idle bound", async () => {
    const exitedFile = join(fixtureRoot, `exited-${++caseCount}`);
    const run = runWrapper(EXITS_INTO_STALLED_DRAIN(exitedFile),
        { readDelayMs: Infinity, drainIdleMs: DRAIN_IDLE_MS });
    try {
      assert.ok(await waitFor(() => existsSync(exitedFile)), "the child never finished writing");
      const exitedAt = Date.now();
      assert.deepEqual(await run.exit, { code: 0, signal: null });
      const took = Date.now() - exitedAt;
      assert.ok(took >= DRAIN_IDLE_MS - 500 && took < DRAIN_IDLE_MS + 3_000,
          `the wrapper exited ${took}ms after the child, want about ${DRAIN_IDLE_MS}ms`);
      assert.deepEqual(readdirSync(run.tmp), [], "the temp output files were left behind");
    } finally {
      kill(run.wrapperPid);
      run.startReading();
    }
  });

  it("exits at once on a second signal during a stalled final drain", async () => {
    const exitedFile = join(fixtureRoot, `exited-${++caseCount}`);
    const run = runWrapper(EXITS_INTO_STALLED_DRAIN(exitedFile), { readDelayMs: Infinity });
    try {
      assert.ok(await waitFor(() => existsSync(exitedFile)), "the child never finished writing");
      await new Promise(resolve => setTimeout(resolve, 300));
      process.kill(run.wrapperPid, "SIGTERM");
      await new Promise(resolve => setTimeout(resolve, 300));
      const secondAt = Date.now();
      process.kill(run.wrapperPid, "SIGTERM");
      assert.deepEqual(await run.exit, { code: null, signal: "SIGTERM" });
      assert.ok(Date.now() - secondAt < 1_000, `the wrapper took ${Date.now() - secondAt}ms after the second signal`);
      assert.deepEqual(readdirSync(run.tmp), [], "the temp output files were left behind");
    } finally {
      kill(run.wrapperPid);
      run.startReading();
    }
  });
});
