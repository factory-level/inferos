/**
 * Runs a command in its own process group under a deadline (FAC-162). On timeout the whole group is
 * killed with SIGKILL, so a hung Wrangler bundle, esbuild, Miniflare or workerd under it can't
 * outlive the command and hold a heavy-run slot. Children that move to a new session themselves
 * would escape the group; Wrangler, esbuild and Miniflare's workerd don't.
 *
 * The new group also leaves the caller's (heavy-run's), so a caller killed outright by SIGKILL
 * can't take it down: the child calls `stopWithParent` to end its own group when that happens.
 */
import { spawn } from "node:child_process";

export interface ProcessGroupResult {
  timedOut: boolean;
  /** The command's exit code; null when a signal ended it. */
  code: number | null;
  /** Set on timeout: what was killed, for the caller to print. */
  message?: string;
}

/** Spawns `command args` detached in a new process group, inheriting stdio, and waits up to timeoutMs. */
export function runInProcessGroup(command: string, args: readonly string[],
    { timeoutMs, label, cwd, env }: { timeoutMs: number; label: string; cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<ProcessGroupResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error("The deadline must be a positive number of milliseconds"));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit", detached: true });
    let timedOut = false;
    const killGroup = () => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* the group has already exited */ }
    };
    // After the leader exits its pid is free, but Linux doesn't hand out a pid still in use as a
    // process group id, so a group that still has members is this one: kill only that.
    const killLeftovers = () => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, 0); } catch { return; }
      killGroup();
    };
    // If this process is interrupted, take the group with it rather than leaving it orphaned.
    const onSignal = () => { killGroup(); process.exit(130); };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    };
    child.once("error", error => { done(); killGroup(); reject(error); });
    child.once("exit", code => {
      done();
      // The leader is gone; kill anything it left behind in its group before returning.
      killLeftovers();
      resolve(timedOut
        ? { timedOut, code: null, message: `${label} did not finish within ${timeoutMs}ms; its process group was killed` }
        : { timedOut, code });
    });
  });
}

/**
 * For the child of runInProcessGroup: ends this process's group when its parent dies, since a
 * parent killed by SIGKILL can't do it. It polls the parent pid every second, without keeping the
 * event loop alive.
 */
export function stopWithParent(intervalMs = 1000): void {
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid === parent) return;
    try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(137); }
  }, intervalMs).unref();
}
