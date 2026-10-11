// Give `vp` regular temp files for stdout and stderr, and tail them into ours with Node streams.
//
// Why: `vp run` aborts the whole run with "Failed to forward task process output: Resource
// temporarily unavailable (os error 11)" when a write to its stdout returns EAGAIN. That happens
// whenever its stdout is a pipe in O_NONBLOCK mode and the reader falls behind -- in CI, GitHub's
// log collector during a multi-MB burst such as workshop-backend's vitest stderr. O_NONBLOCK is a
// property of the open file *description*, and libuv sets it as soon as any Node process opens a
// pipe stdout as a stream. vp clears it at startup (`ensureBlockingStdio`), but it cannot stop
// another process sharing the description from setting it again:
//
// - with inherited stdio, `pnpm` and this wrapper share vp's stdout;
// - with a pipe of vp's own, vp still hands that pipe to every `cache: false` task it runs
//   (`build:bundled-blueprints`, `build:browser-runtime`, `clean:error-reporting-artifacts`), and
//   one Node task is enough to make it non-blocking again under vp.
//
// So no pipe given to vp can be kept blocking. A regular file can: a write to one never returns
// EAGAIN, whatever O_NONBLOCK says, and never waits on a reader. vp and its uncached tasks write into
// the files at disk speed, and this process tails them into its own stdout and stderr, awaiting
// `drain` so a slow reader slows only the tail. Our own stdio is left in whatever mode Node puts it
// in; libuv queues and retries our writes on EAGAIN instead of failing.
//
// The files live in a fresh `mkdtemp` directory under `os.tmpdir()` (0700, files 0600) and are
// unlinked as soon as vp has them open, so nothing is left behind on any exit path, SIGKILL
// included: the kernel frees them when the last descriptor closes. Where an open file cannot be
// unlinked (Windows), they are removed on exit instead.
//
// What this costs:
// - stdout and stderr are two files, so the relative order of a stdout and a stderr chunk written
//   close together is not preserved (each stream's own order is exact). `vp run` already captures
//   each task's two streams separately, so in practice this only affects vp's own lines;
// - output reaches us up to `POLL_MS` later than it was written;
// - a reader that goes away (`| head`) no longer kills vp with EPIPE; the run finishes unread.
//
// A stream that is a TTY is still inherited (see `stdioFor`): that keeps vp's colours, progress and
// terminal width, and a TTY cannot hit this bug, because Node puts a TTY stdout into *blocking* mode.

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, constants, fstatSync, mkdtempSync, openSync, read, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { relayTermination } from "../relay-termination.ts";

/** How often a tail at end-of-file checks for more output while vp is running. */
export const POLL_MS = 50;

/**
 * How long the final drain may go without the sink accepting a byte before it is abandoned. It
 * bounds only a reader that has stopped reading; a slow one that keeps accepting output is waited
 * for, and a second signal abandons it at once.
 *
 * Not the ~5s first proposed: that was for descendants holding the output open, which the tail no
 * longer waits on at all (it stops at each file's size when the child exited). What is left is a
 * stalled reader, and GitHub's has been seen stalling for 6s; giving up then drops the end of the
 * CI log -- the failure summary. 30s is half `with-timeout.ts`'s idle bound for a task.
 */
export const FINAL_DRAIN_IDLE_MS = 30_000;

const readAsync = promisify(read);

type Sink = NodeJS.WritableStream & { isTTY?: boolean };

/** The two output streams this module forwards to, as far as it reads them. */
export interface OutputSinks {
  stdout: Sink;
  stderr: Sink;
}

/**
 * How each of vp's output streams is wired: inherited if ours is a TTY, captured to a temp file
 * otherwise.
 *
 * Per stream, so vp sees `isatty` exactly as it did when everything was inherited: a local
 * `pnpm test` at a terminal is unchanged, `pnpm test 2>log` still colours stdout, and CI, where
 * neither is a TTY, captures both. Inheriting a TTY rather than capturing it with `FORCE_COLOR` set
 * keeps vp's other TTY-dependent behaviour (progress, width) and pushes no colour override into the
 * tasks vp runs, where it could change what is cached.
 *
 * Reading `isTTY` also instantiates Node's stream for the fd, which for a TTY is what puts it into
 * blocking mode before vp starts writing to it.
 */
export function stdioFor(sinks: OutputSinks = process): { stdout: "inherit" | "file"; stderr: "inherit" | "file" } {
  return { stdout: sinks.stdout.isTTY ? "inherit" : "file", stderr: sinks.stderr.isTTY ? "inherit" : "file" };
}

interface Capture {
  name: "stdout" | "stderr";
  /** What the child is given as its stdio entry: our write descriptor for the file. */
  writeFd: number;
  readFd: number;
  path: string;
  sink: Sink;
  /**
   * The file's size when the child exited: the tail stops here. `null` while the child runs.
   * Taken from the read descriptor, which works after the file is unlinked.
   */
  endAt: number | null;
}

/**
 * Spawns `command` the way `vp/run.ts` runs `vp`: non-TTY output captured to temp files and tailed
 * into ours, and termination relayed (`relayTermination`): SIGINT and SIGTERM go to the child's
 * whole process tree, and this process exits with the child's code, or re-raises the signal that
 * ended it, once the tail has caught up with everything the child wrote before it exited.
 *
 * The tail stops at each file's size as `fstat` reports it in the child's `exit` handler, so a
 * descendant that outlives the child while still writing to the files (a detached grandchild of an
 * uncached task) can neither keep this process alive nor add to the forwarded output: anything
 * written after that point is dropped with the files.
 */
export function spawnWithOwnOutput(
  command: string,
  args: string[],
  { env, graceMs, sinks = process, finalDrainIdleMs = FINAL_DRAIN_IDLE_MS }: {
    env?: NodeJS.ProcessEnv;
    graceMs?: number;
    sinks?: OutputSinks;
    /** `FINAL_DRAIN_IDLE_MS`, overridable so the bound can be tested without waiting it out. */
    finalDrainIdleMs?: number;
  } = {},
): ChildProcess {
  const wiring = stdioFor(sinks);
  const wanted = (["stdout", "stderr"] as const).filter(name => wiring[name] === "file");

  let dir: string | null = null;
  const captures: Capture[] = [];
  const cleanUp = () => {
    for (const capture of captures.splice(0)) {
      try { closeSync(capture.readFd); } catch { /* already closed */ }
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  };
  // The backstop for every path that ends this process without reaching `beforeExit` below: an
  // uncaught error, a spawn failure, a `process.exit` elsewhere. Synchronous, as `exit` requires.
  process.on("exit", cleanUp);

  if (wanted.length > 0) {
    dir = mkdtempSync(join(tmpdir(), "vp-output-"));
    chmodSync(dir, 0o700);
    for (const name of wanted) {
      const path = join(dir, name);
      // O_EXCL: the directory is fresh and private, so an existing file means something is wrong.
      // O_APPEND: vp and the uncached tasks it hands this descriptor to all write at the end.
      const writeFd = openSync(path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND, 0o600);
      captures.push({ name, writeFd, readFd: openSync(path, "r"), path, sink: sinks[name], endAt: null });
    }
  }

  const fdFor = (name: "stdout" | "stderr") =>
      captures.find(capture => capture.name === name)?.writeFd ?? "inherit";
  const child = spawn(command, args, { stdio: ["inherit", fdFor("stdout"), fdFor("stderr")], env });

  // The child has its own descriptors now. Ours would only keep the files open longer.
  for (const capture of captures) closeSync(capture.writeFd);
  if (dir) {
    try {
      for (const capture of captures) unlinkSync(capture.path);
      rmdirSync(dir);
      dir = null;
    } catch {
      // Windows cannot unlink an open file; `cleanUp` removes them on exit.
    }
  }

  const state = { stopped: false, progressAt: Date.now() };
  // Registered before `relayTermination`'s own `exit` listener, so every `endAt` is set by the time
  // its `beforeExit` runs. Everything the child wrote is in the files by now: a write to a regular
  // file is complete when the call returns.
  child.on("exit", () => {
    for (const capture of captures) {
      try {
        capture.endAt = fstatSync(capture.readFd).size;
      } catch {
        capture.endAt = 0;
      }
    }
    state.progressAt = Date.now();
  });
  const tails = captures.map(capture => tail(capture, state));

  relayTermination(child, {
    graceMs,
    beforeExit: async force => {
      await Promise.race([Promise.all(tails), abandoned(state, force, finalDrainIdleMs)]);
      state.stopped = true;
      // Never allowed to turn the child's exit status into this process's crash: a removal that
      // fails (Windows, with a descendant still holding a file) only leaves a temp file behind.
      try { cleanUp(); } catch { /* left for the OS's temp cleanup */ }
      process.off("exit", cleanUp);
    },
  });
  return child;
}

/**
 * Copies the capture's file into its sink from the start, polling at end-of-file while the child
 * runs, and stopping at `endAt` once the child has exited. Waits for `drain` whenever the sink asks
 * it to, so the file, not this process's memory, absorbs a slow reader.
 */
async function tail(capture: Capture, state: { stopped: boolean; progressAt: number }): Promise<void> {
  const { readFd: fd, sink } = capture;
  // A property rather than a local, since only the `error` listener sets it.
  const sinkState = { broken: false };
  // A reader that goes away makes our write fail with EPIPE; unhandled, that would kill this wrapper
  // and orphan vp. There is nowhere left to forward to, so the tail just stops.
  sink.on("error", () => { sinkState.broken = true; });
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (!state.stopped && !sinkState.broken) {
    const { endAt } = capture;
    if (endAt !== null && position >= endAt) break;
    // Never past `endAt`: a descendant may still be appending, and that is not the child's output.
    const length = endAt === null ? buffer.length : Math.min(buffer.length, endAt - position);
    let bytesRead: number;
    try {
      ({ bytesRead } = await readAsync(fd, buffer, 0, length, position));
    } catch {
      // Only once `cleanUp` has closed the descriptor under an abandoned drain; nothing is waiting.
      return;
    }
    if (bytesRead > 0) {
      position += bytesRead;
      // Copied: `buffer` is reused for the next read while the sink may still hold this chunk.
      if (!sink.write(Buffer.from(buffer.subarray(0, bytesRead)))) await drained(sink);
      state.progressAt = Date.now();
      continue;
    }
    // End-of-file while the child is still running: wait for more. (After its exit the file only
    // grows, so a short read below `endAt` cannot happen; the idle bound would cover it if it did.)
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  if (sinkState.broken) return;
  // Writes are ordered, so this callback runs once everything written before it has been handed to
  // the OS; `process.exit()` would otherwise drop a write libuv is still holding for a slow pipe.
  await new Promise<void>(resolve => { sink.write("", () => resolve()); });
  state.progressAt = Date.now();
}

function drained(sink: Sink): Promise<void> {
  return new Promise<void>(resolve => {
    const done = () => {
      sink.off("drain", done);
      sink.off("close", done);
      sink.off("error", done);
      resolve();
    };
    sink.once("drain", done);
    sink.once("close", done);
    sink.once("error", done);
  });
}

/**
 * Resolves when the final drain should be given up: on a second signal (`force`), or once the
 * sink has accepted nothing for `idleMs` since the child exited.
 */
async function abandoned(state: { progressAt: number; stopped: boolean }, force: AbortSignal,
  idleMs: number): Promise<void> {
  while (!state.stopped && !force.aborted && Date.now() - state.progressAt < idleMs) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
