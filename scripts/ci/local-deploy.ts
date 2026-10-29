#!/usr/bin/env node
// Factory node 5 (InferOS side), `local-deploy`: the built Workers running locally behind the
// public router (`pnpm run-local`, :8787 unless the worktree overlay moves it), seeded with the
// local user, mock model, InferOps account and demo board (`pnpm local seed`).
//
//   node scripts/ci/local-deploy.ts [--run-id ID]
//
// The stack is this checkout's: a `pnpm local factory up` sandbox's is reused, otherwise one is
// started detached and recorded in the sandbox state, so `pnpm local factory down` stops it. A port
// held by another process is a failure, never reused.
//
// The `build` node rewrites `packages/workshop-frontend/dist` (the Access-mode asset build), and a
// running `wrangler dev` keeps serving its startup asset manifest, so it answers 404 for the
// document afterwards. A factory-started stack that predates this run's build is therefore
// restarted (run-local rebuilds the local assets first); one the factory did not start is a
// failure naming the fix, never signalled.
//
// Gate: every configured Worker answers through the router, `/` serves the shell (200), and the
// seed's own verify passes. The InferOps stack's `/health/ready` is probed and recorded, not gated:
// this node proves the InferOS side; the InferOps half of node 5 is that repo's pipeline.

import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchInferos, readState, stopGroup, writeState } from "../local/factory.ts";
import { defaultDeps } from "../local/lifecycle.ts";
import { configuredWorkers, probeWorkers, readDevServerRecord, resolveLocalStack, stackOwnership } from "../local/stack.ts";
import { exec, finish, nodeContext, runAsMain, type NodeContext } from "./lib.ts";

const READY_TIMEOUT_MS = 15 * 60_000;

/** When this run's build node finished, if it ran. */
function buildFinishedAt(ctx: NodeContext): number | null {
  const result = join(ctx.dir, "..", "build", "result.json");
  return existsSync(result) ? statSync(result).mtimeMs : null;
}

async function shellStatus(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(5_000) });
    await response.body?.cancel();
    return response.status;
  } catch {
    return null;
  }
}

export async function main(argv: string[]): Promise<number> {
  const ctx = nodeContext("local-deploy", argv);
  const deps = { ...defaultDeps, env: ctx.env };
  const stack = resolveLocalStack(ctx.root, [], ctx.env);
  const fail = (gate: string, details: Record<string, unknown>) => finish(ctx, { node: "local-deploy", ok: false, gate, commands: [], details });
  let record = readDevServerRecord(stack.recordPath);
  const ownership = stackOwnership(await deps.isPortListening(stack.port), record, stack.port);
  if (ownership === "port-in-use-by-other") return fail("this checkout's stack answers on its port", { url: stack.url, ownership });
  const state = readState(ctx.root) ?? { sandbox: "dev" as const, startedAt: new Date().toISOString(), services: {} };
  let action: "reused" | "started" | "restarted" = "reused";
  const built = buildFinishedAt(ctx);
  if (ownership === "running" && built !== null && record && Date.parse(record.startedAt) < built) {
    const ours = state.services.inferos;
    if (!ours?.startedByFactory || ours.pid === undefined) {
      return fail("a stack started before this run's build serves stale assets", { url: stack.url, fix: "restart it (pnpm local stop, then rerun), or start it with pnpm local factory up dev" });
    }
    await stopGroup(ours.pid, deps);
    action = "restarted";
  } else if (ownership === "not-running") {
    action = "started";
  }
  if (action !== "reused") {
    state.services.inferos = launchInferos(stack, deps);
    writeState(ctx.root, state);
  }
  const pid = state.services.inferos?.pid;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let probes = await probeWorkers(stack.url, configuredWorkers(ctx.root));
  while (probes.some(probe => probe.state !== "up") && Date.now() < deadline) {
    if (action !== "reused" && pid !== undefined && !deps.processAlive(pid)) break;
    await new Promise(resolve => setTimeout(resolve, 3_000));
    probes = await probeWorkers(stack.url, configuredWorkers(ctx.root));
  }
  record = readDevServerRecord(stack.recordPath);
  const shell = await shellStatus(stack.url);
  const healthy = probes.every(probe => probe.state === "up") && record !== null && shell === 200;
  const seed = healthy ? await exec(ctx, ["pnpm", "--silent", "local", "seed", "--json"], { log: "seed.log", stdoutFile: "seed.json" }) : null;
  const inferopsUrl = `${ctx.env.FACTORY_INFEROPS_URL ?? "http://127.0.0.1:8080"}/health/ready`;
  let inferopsStatus: number | null = null;
  try {
    inferopsStatus = (await fetch(inferopsUrl, { signal: AbortSignal.timeout(3_000) })).status;
  } catch {
    // Not answering: recorded as null.
  }
  const health = {
    url: stack.url, action, log: state.services.inferos?.log ?? null, shell,
    workers: probes.map(({ name, state: up, status }) => ({ name, state: up, status })),
    inferops: { url: inferopsUrl, status: inferopsStatus, gated: false },
  };
  writeFileSync(join(ctx.dir, "health.json"), JSON.stringify(health, null, 2) + "\n");
  return finish(ctx, {
    node: "local-deploy", ok: healthy && seed?.exitCode === 0,
    gate: "every Worker answers through the local router, / serves the shell, and pnpm local seed verifies the demo board (InferOps /health/ready recorded, not gated)",
    commands: seed ? [seed] : [],
    details: health,
  });
}

await runAsMain(import.meta.url, main);
