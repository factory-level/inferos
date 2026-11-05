/**
 * Runs a command in its own process group under a deadline (FAC-162). On timeout the whole group is
 * killed with SIGKILL, so a hung Wrangler bundle, esbuild, Miniflare or workerd under it can't
 * outlive the command and hold a heavy-run slot. Children that move to a new session themselves
 * would escape the group; Wrangler, esbuild and Miniflare's workerd don't.
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
      killGroup();
      resolve(timedOut
        ? { timedOut, code: null, message: `${label} did not finish within ${timeoutMs}ms; its process group was killed` }
        : { timedOut, code });
    });
  });
}
