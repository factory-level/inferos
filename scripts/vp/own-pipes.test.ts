import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stdioFor, type OutputSinks } from "./own-pipes.ts";

const OWN_PIPES = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "own-pipes.ts"));

// Fixtures go under the OS temp directory, never in the workspace: this suite's `input` is
// workspace-wide (see `scripts/vite.config.ts`), so writing in here would be writing its own task
// input. Same discipline as `relay-termination.test.ts`.
const fixtureRoot = mkdtempSync(join(tmpdir(), "vp-own-pipes-"));
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

let caseCount = 0;

/** 64-byte lines, numbered per stream, so a dropped, duplicated or reordered chunk shows up. */
const LINE_FILLER = 48;
const line = (stream: string, n: number) =>
    `${stream} ${String(n).padStart(9, "0")} ${"x".repeat(LINE_FILLER)}\n`;
const LINES_PER_WRITE = 256;
/** 4 MiB per stream, far past any pipe buffer, so the paused reader below really does stall it. */
const WRITES = 256;

const expected = (stream: string) =>
    Array.from({ length: WRITES * LINES_PER_WRITE }, (_, n) => line(stream, n)).join("");

// Stands in for vp: alternates large synchronous writes between stdout and stderr and, like vp,
// treats EAGAIN as fatal instead of retrying -- so it survives only if its fds block when full.
const BURST_CHILD = `
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
  for (let w = 0; w < ${WRITES}; w++) {
    let out = "", err = "";
    for (let i = 0; i < ${LINES_PER_WRITE}; i++, n++) { out += line("out", n); err += line("err", n); }
    writeAll(1, out);
    writeAll(2, err);
  }
  process.exit(3);
`;

// Reports readiness, then on a signal writes to both streams after a short delay -- so the test
// also proves output produced *after* the forwarded signal still makes it through the pipes.
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

interface Run {
  wrapperPid: number;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout: () => string;
  stderr: () => string;
  /** Resolves once both of the wrapper's output streams have closed. */
  closed: Promise<void>;
}

/**
 * Runs `childBody` under `spawnWithOwnPipes` in a wrapper process -- the composition `vp/run.ts`
 * uses -- and returns the wrapper's own output, which is the test's to read as slowly as it likes.
 *
 * After the spawn the wrapper makes its own stdout non-blocking explicitly. That is the hazard the
 * module exists for, done deliberately: an ancestor sharing the description flipping it to
 * O_NONBLOCK underneath the child. With inherited stdio it reaches the child's fd and the burst
 * fails with EAGAIN; with own pipes the child never sees it.
 */
function runWrapper(childBody: string, { readDelayMs = 0 } = {}): Run {
  const dir = join(fixtureRoot, `case-${++caseCount}`);
  mkdirSync(dir, { recursive: true });
  const child = join(dir, "child.cjs");
  writeFileSync(child, childBody);
  const wrapper = join(dir, "wrapper.mjs");
  writeFileSync(wrapper, `
    import { spawnWithOwnPipes } from ${JSON.stringify(OWN_PIPES.href)};
    spawnWithOwnPipes(process.execPath, [${JSON.stringify(child)}], { graceMs: 2_000 });
    process.stdout._handle?.setBlocking?.(false);
  `);

  const proc = spawn(process.execPath, [wrapper], { stdio: ["ignore", "pipe", "pipe"] });
  assert.ok(proc.pid, "the wrapper was not spawned");
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    proc.on("exit", (code, signal) => resolve({ code, signal }));
  });

  // Buffers, decoded once at the end, so a chunk boundary splitting a character cannot garble it.
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const startReading = () => {
    proc.stdout.on("data", (chunk: Buffer) => { out.push(chunk); });
    proc.stderr.on("data", (chunk: Buffer) => { err.push(chunk); });
  };
  // Not reading at all is the slow reader: the streams stay paused until a listener attaches, so
  // the wrapper's writes back up, then the child's pipes fill, for the whole delay.
  if (readDelayMs > 0) setTimeout(startReading, readDelayMs);
  else startReading();

  const closed = Promise.all([proc.stdout, proc.stderr].map(
      stream => new Promise<void>(resolve => stream.once("close", resolve)))).then(() => undefined);
  return {
    wrapperPid: proc.pid,
    exit,
    stdout: () => Buffer.concat(out).toString(),
    stderr: () => Buffer.concat(err).toString(),
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

/** Stand-in sinks for `stdioFor`, which reads nothing from them but `isTTY`. */
const sinks = (stdoutTTY: boolean, stderrTTY: boolean) =>
    ({ stdout: { isTTY: stdoutTTY }, stderr: { isTTY: stderrTTY } }) as unknown as OutputSinks;

describe("stdioFor", () => {
  it("pipes both streams when neither is a TTY (CI)", () => {
    assert.deepEqual(stdioFor(sinks(false, false)), ["inherit", "pipe", "pipe"]);
  });

  it("inherits both streams at a terminal, keeping vp's colours and progress", () => {
    assert.deepEqual(stdioFor(sinks(true, true)), ["inherit", "inherit", "inherit"]);
  });

  it("decides per stream when only one is redirected", () => {
    assert.deepEqual(stdioFor(sinks(true, false)), ["inherit", "inherit", "pipe"]);
    assert.deepEqual(stdioFor(sinks(false, true)), ["inherit", "pipe", "inherit"]);
  });
});

describe("spawnWithOwnPipes", {
  concurrency: true,
  skip: process.platform === "win32" ? "the EAGAIN hazard and these signal fixtures are POSIX-only" : false,
}, () => {
  // The CI failure: a multi-MB burst while the reader is behind. Every byte has to arrive, in order
  // per stream, and the child's exit code has to come out of the wrapper unchanged.
  it("forwards a multi-MB burst intact to a slow reader and passes the exit code through", async () => {
    const run = runWrapper(BURST_CHILD, { readDelayMs: 1_500 });
    const { code, signal } = await run.exit;
    await run.closed;
    // 98 would be the child dying of EAGAIN, the bug itself.
    assert.deepEqual({ code, signal }, { code: 3, signal: null });
    // Compared by equality rather than with `assert.equal` on the strings, whose diff of two 4 MiB
    // values would bury the failure.
    for (const [name, actual] of [["out", run.stdout()], ["err", run.stderr()]] as const) {
      const want = expected(name);
      assert.ok(actual === want,
          `${name}: got ${actual.length} bytes, want ${want.length}; first difference at ` +
          `${[...want].findIndex((ch, i) => actual[i] !== ch)}`);
    }
  });

  for (const sent of ["SIGTERM", "SIGINT"] as const) {
    it(`forwards ${sent} to the child, drains its last output, and re-raises it`, async () => {
      const run = runWrapper(SIGNAL_CHILD);
      let childPid = 0;
      try {
        assert.ok(await waitFor(() => /^ready \d+$/m.test(run.stdout())), "the child never started");
        childPid = Number(/^ready (\d+)$/m.exec(run.stdout())?.[1]);
        process.kill(run.wrapperPid, sent);
        assert.deepEqual(await run.exit, { code: null, signal: sent });
        await run.closed;
        assert.match(run.stdout(), new RegExp(`^child got ${sent}$`, "m"));
        assert.match(run.stderr(), new RegExp(`^child got ${sent}$`, "m"));
        assert.ok(!isAlive(childPid), "the child outlived the wrapper");
      } finally {
        for (const pid of [run.wrapperPid, childPid]) {
          if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
        }
      }
    });
  }
});
