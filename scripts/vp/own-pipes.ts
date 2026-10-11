// Spawn `vp` with stdout and stderr on pipes of its own, and forward them to ours with Node streams.
//
// Why: `vp run` aborts the whole run with "Failed to forward task process output: Resource
// temporarily unavailable (os error 11)" when a write to its stdout returns EAGAIN. With
// `stdio: "inherit"` its stdout is the very open file description that every Node process above it
// shares -- `pnpm`, this wrapper -- and libuv puts a pipe stdout into O_NONBLOCK as soon as a Node
// process opens it as a stream. vp clears the flag at startup (`ensureBlockingStdio`), but it is a
// property of the shared description, so any of those processes can set it again underneath vp.
// In CI the reader of that pipe is GitHub's log collector; when it falls behind during a burst
// (workshop-backend's vitest stderr is several MB), the pipe fills, vp's write returns EAGAIN
// instead of blocking, and vp gives up rather than retrying.
//
// With a pipe of its own, vp is the only process holding the write end, so nothing else can make
// it non-blocking and a full pipe simply blocks vp until this process reads. This process then
// writes to the shared description through libuv, which queues and retries on EAGAIN instead of
// failing, and `pipe()` pauses reading from vp while that queue is over its high-water mark, so a
// slow reader becomes backpressure on vp rather than memory growth here. The shared fd is
// deliberately left in whatever mode Node puts it in; forcing it blocking would only move the race.
//
// What this costs: stdout and stderr travel on two independent pipes, so the relative order of a
// stdout chunk and a stderr chunk written close together is no longer guaranteed (each stream's own
// order is exact). That is already true of every task's output inside `vp run`, which captures
// stdout and stderr separately, so in practice it only affects vp's own lines.
//
// A stream that is a TTY is still inherited (see `stdioFor`): that keeps vp's colours, progress
// rendering and terminal width exactly as before, and a TTY cannot hit this bug, because Node puts a
// TTY stdout into *blocking* mode (`tty.WriteStream` calls `setBlocking(true)`).

import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { relayTermination } from "../relay-termination.ts";

/** The two output streams this module forwards to, as far as it reads them. */
export interface OutputSinks {
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream & { isTTY?: boolean };
}

/**
 * The `stdio` option for the child: stdin inherited, and each of stdout and stderr inherited if
 * ours is a TTY, piped otherwise.
 *
 * Per stream, so the child sees `isatty` exactly as it did when everything was inherited: a local
 * `pnpm test` at a terminal is unchanged, `pnpm test 2>log` still colours stdout, and CI, where
 * neither is a TTY, gets both pipes. Inheriting a TTY rather than piping it with `FORCE_COLOR` set
 * keeps the child's other TTY-dependent behaviour (progress, line rewriting, width) and avoids
 * pushing a colour override into every task vp runs, where it could change what is cached.
 *
 * Reading `isTTY` also instantiates Node's stream for the fd, which for a TTY is what puts it into
 * blocking mode before the child starts writing to it.
 */
export function stdioFor(sinks: OutputSinks = process): ["inherit", "inherit" | "pipe", "inherit" | "pipe"] {
  return ["inherit", sinks.stdout.isTTY ? "inherit" : "pipe", sinks.stderr.isTTY ? "inherit" : "pipe"];
}

/**
 * Forwards whichever of `child`'s stdout and stderr are piped to `sinks`, and resolves once both
 * have closed and everything read from them has been handed to the OS.
 *
 * The wait is what makes exiting safe: `process.exit()` drops a write that libuv is still holding
 * for a slow pipe, so the caller must not exit before this settles (with-timeout.ts has the same
 * rule).
 */
export function forwardOutput(child: ChildProcess, sinks: OutputSinks = process): Promise<void> {
  const forwarded = ([[child.stdout, sinks.stdout], [child.stderr, sinks.stderr]] as const)
      .filter((pair): pair is [Readable, OutputSinks["stdout"]] => pair[0] !== null)
      .map(([source, sink]) => forward(source, sink));
  return Promise.all(forwarded).then(() => undefined);
}

async function forward(source: Readable, sink: OutputSinks["stdout"]): Promise<void> {
  // A reader that goes away (`pnpm test | head`) makes our write fail with EPIPE. Unhandled, that
  // is an uncaught exception that kills this wrapper and orphans vp. Instead the pipe from vp is
  // closed, so vp's next write gets EPIPE -- what it got when it held the reader's pipe directly.
  sink.on("error", () => source.destroy());
  // `end: false`: our stdio is shared with the rest of this process and must outlive the child.
  source.pipe(sink, { end: false });
  await new Promise<void>(resolve => source.once("close", resolve));
  // Writes are ordered, so this callback runs only once everything piped before it is flushed. A
  // destroyed sink still calls back (with an error, ignored: there is nowhere left to report it).
  await new Promise<void>(resolve => { sink.write("", () => resolve()); });
}

/**
 * Spawns `command` the way `vp/run.ts` runs `vp`: own pipes for non-TTY output (`stdioFor`), the
 * output forwarded (`forwardOutput`), and termination relayed (`relayTermination`): SIGINT and
 * SIGTERM go to the child's whole process tree, and this process exits with the child's code, or
 * re-raises the signal that ended it -- but only after the forwarded output has drained.
 */
export function spawnWithOwnPipes(
  command: string,
  args: string[],
  { env, graceMs }: { env?: NodeJS.ProcessEnv; graceMs?: number } = {},
): ChildProcess {
  const child = spawn(command, args, { stdio: stdioFor(), env });
  const drained = forwardOutput(child);
  relayTermination(child, { graceMs, beforeExit: () => drained });
  return child;
}
