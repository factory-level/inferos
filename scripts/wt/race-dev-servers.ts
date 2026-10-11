#!/usr/bin/env node

// Reproduction harness for port races between `pnpm dev-server`s in parallel worktrees -- not a CI
// test (it starts real Wrangler stacks and takes minutes).
//
//   node scripts/wt/race-dev-servers.ts [--rounds 5] [--gatekeepers inferops] <worktree> <worktree>...
//
// Each round starts one dev server per worktree at the same instant, each in its own process group,
// waits until every one is ready (`Ready on`) or has failed, counts `bind(): Address already in use`
// failures, then stops every group by its own pid and waits for it to be gone before the next round.
// Logs go to a temporary directory, printed at the end. Exit code 1 when any start failed.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rounds: { type: "string", default: "5" },
    gatekeepers: { type: "string", default: "inferops" },
  },
});
const rounds = Number(values.rounds);
const worktrees = positionals.map(path => resolve(path));
if (!Number.isInteger(rounds) || rounds < 1 || worktrees.length < 2) {
  console.error("Usage: race-dev-servers.ts [--rounds N] [--gatekeepers a,b] <worktree> <worktree>...");
  process.exit(2);
}

const logs = mkdtempSync(join(tmpdir(), "race-dev-servers-"));
type Verdict = "ready" | "bind-failure" | "exited" | "timeout";

interface Started { child: ChildProcess; output: string; verdict: Promise<Verdict> }

function start(worktree: string): Started {
  // Detached: its own process group, so the whole Wrangler/workerd tree can be signalled by pgid.
  const child = spawn(process.execPath,
    [join(worktree, "scripts", "run-dev-server.ts"), "--gatekeepers", values.gatekeepers, "--no-ui-watchers"],
    { cwd: worktree, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const started: Started = { child, output: "", verdict: Promise.resolve("timeout") };
  started.verdict = new Promise<Verdict>(settle => {
    setTimeout(() => settle("timeout"), 240_000).unref();
    const onData = (chunk: Buffer) => {
      started.output += chunk;
      if (/Address already in use/.test(started.output)) settle("bind-failure");
      else if (/Ready on/.test(started.output)) settle("ready");
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("exit", () => settle(/Address already in use/.test(started.output) ? "bind-failure" : "exited"));
  });
  return started;
}

async function stop({ child }: Started): Promise<void> {
  if (child.pid === undefined) return;
  const group = -child.pid;
  try { process.kill(group, "SIGTERM"); } catch { return; }
  for (let i = 0; i < 60; i++) {
    try { process.kill(group, 0); } catch { return; }
    await new Promise(r => setTimeout(r, 500));
  }
  try { process.kill(group, "SIGKILL"); } catch { /* gone */ }
}

const counts: Record<Verdict, number> = { ready: 0, "bind-failure": 0, exited: 0, timeout: 0 };
for (let round = 1; round <= rounds; round++) {
  const servers = worktrees.map(start);
  const settled = await Promise.all(servers.map(server => server.verdict));
  // Let a slower sibling's bind happen before judging the round over: a server can print Ready on
  // and still lose its inspector bind a moment later.
  await new Promise(r => setTimeout(r, 3_000));
  const verdicts = servers.map((server, i): Verdict =>
    /Address already in use/.test(server.output) ? "bind-failure" : settled[i]!);
  servers.forEach((server, i) => writeFileSync(join(logs, `round-${round}-${i}.log`), server.output));
  for (const verdict of verdicts) counts[verdict]++;
  console.log(`round ${round}: ${verdicts.join(", ")}`);
  await Promise.all(servers.map(stop));
  await new Promise(r => setTimeout(r, 2_000));
}
console.log(`${counts.ready} ready, ${counts["bind-failure"]} bind failures, ${counts.exited} exited, ` +
  `${counts.timeout} timed out, over ${rounds} rounds of ${worktrees.length}; logs in ${logs}`);
process.exitCode = counts.ready === rounds * worktrees.length ? 0 : 1;
