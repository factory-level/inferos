#!/usr/bin/env node
// Factory node 4 (InferOS side), `bindings`: every binding a deployable Worker declares in its
// committed `wrangler.jsonc` resolves locally.
//
//   node scripts/ci/bindings.ts [--run-id ID]
//
// Floci has no Cloudflare emulator, so the local equivalent of "the infrastructure exists" is
// Wrangler/Miniflare. Raw Miniflare does not read the wrangler config, so each config goes through
// Wrangler's own `getPlatformProxy({ configPath })`, which builds the bindings from that file. Three
// things must hold for each Worker:
//   1. the local run's generated `wrangler.dev.jsonc` (what `pnpm run-local` actually starts)
//      declares every binding the deploy config does;
//   2. each binding is present in the proxy's `env`, or — for the kinds the proxy cannot build
//      (`worker_loaders`) — its Worker answers through the router of the running local stack;
//   3. the Worker itself answers through that router (`scripts/local/stack.ts` probes).
// Durable Objects here are reached through `ctx.exports` and declare no binding, so the workerd
// test pools (`pnpm test`) are what exercise them.
// ponytail: getPlatformProxy, not a @cloudflare/vitest-pool-workers project per Worker; upgrade
// path is one pool-workers test per Worker asserting `env` keys from inside workerd.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "jsonc-parser";
import { configuredWorkers, probeWorkers, resolveLocalStack } from "../local/stack.ts";
import { workerPackageDirs } from "../worker-dirs.ts";
import { finish, nodeContext, runAsMain } from "./lib.ts";

/** A binding a Worker config declares. */
export interface Binding {
  name: string;
  kind: string;
}

type Config = Record<string, unknown>;
const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value : []);

/** Every binding `config` declares, by name and kind. Vars and secrets are not bindings. */
export function declaredBindings(config: Config): Binding[] {
  const bindings: Binding[] = [];
  const add = (kind: string, name: unknown) => { if (typeof name === "string") bindings.push({ name, kind }); };
  for (const kind of ["kv_namespaces", "r2_buckets", "d1_databases", "services", "worker_loaders", "analytics_engine_datasets", "vectorize", "hyperdrive", "mtls_certificates", "dispatch_namespaces"]) {
    for (const entry of list(config[kind])) add(kind, entry.binding);
  }
  for (const entry of list((config.queues as Config | undefined)?.producers)) add("queues", entry.binding);
  for (const entry of list((config.durable_objects as Config | undefined)?.bindings)) add("durable_objects", entry.name);
  for (const kind of ["browser", "ai", "assets", "images", "version_metadata"]) add(kind, (config[kind] as Config | undefined)?.binding);
  return bindings;
}

/** Kinds `getPlatformProxy` does not build; these are proven by the running local stack instead. */
export const LOCAL_RUN_KINDS = new Set(["worker_loaders"]);

/** One binding's verdict. */
export interface BindingVerdict extends Binding {
  worker: string;
  inLocalRunConfig: boolean;
  resolvedBy: "proxy" | "local-run" | null;
}

/** Judge one Worker's bindings from its configs, the proxy's env keys and the local run. */
export function judgeWorker(worker: string, deploy: Config, dev: Config | null, proxyKeys: Set<string>, workerUp: boolean): BindingVerdict[] {
  const local = new Set(dev ? declaredBindings(dev).map(binding => binding.name) : []);
  return declaredBindings(deploy).map(binding => ({
    ...binding, worker,
    inLocalRunConfig: local.has(binding.name),
    resolvedBy: proxyKeys.has(binding.name) ? "proxy" : LOCAL_RUN_KINDS.has(binding.kind) && workerUp ? "local-run" : null,
  }));
}

export async function main(argv: string[]): Promise<number> {
  const ctx = nodeContext("bindings", argv);
  const { getPlatformProxy } = await import("wrangler");
  const stack = resolveLocalStack(ctx.root, [], ctx.env);
  const probes = await probeWorkers(stack.url, configuredWorkers(ctx.root));
  const up = new Set(probes.filter(probe => probe.state === "up").map(probe => probe.name));
  const verdicts: BindingVerdict[] = [];
  const workers: { worker: string; answering: boolean; bindings: number }[] = [];
  for (const dir of workerPackageDirs(ctx.root)) {
    const configPath = join(dir, "wrangler.jsonc");
    if (!existsSync(configPath)) continue;
    const worker = basename(dir);
    const deploy = parse(readFileSync(configPath, "utf8")) as Config;
    // The router's local config is the root wrangler.dev.jsonc; every other Worker's sits beside it.
    const devPath = worker === "router" ? join(ctx.root, "wrangler.dev.jsonc") : join(dir, "wrangler.dev.jsonc");
    const dev = existsSync(devPath) ? parse(readFileSync(devPath, "utf8")) as Config : null;
    let keys = new Set<string>();
    if (declaredBindings(deploy).length) {
      const proxy = await getPlatformProxy({ configPath, persist: false });
      keys = new Set(Object.keys(proxy.env as object));
      await proxy.dispose();
    }
    verdicts.push(...judgeWorker(worker, deploy, dev, keys, up.has(worker)));
    workers.push({ worker, answering: up.has(worker), bindings: declaredBindings(deploy).length });
  }
  const unresolved = verdicts.filter(verdict => !verdict.resolvedBy || !verdict.inLocalRunConfig);
  // Every deployable Worker the dev server starts must answer; a Worker it does not start is reported.
  const silent = workers.filter(worker => !worker.answering && configuredWorkers(ctx.root).some(c => c.name === worker.worker));
  for (const verdict of unresolved) console.error(`[factory] UNRESOLVED ${verdict.worker}.${verdict.name} (${verdict.kind}): ${verdict.inLocalRunConfig ? "not built locally" : "missing from the local run config"}`);
  for (const worker of silent) console.error(`[factory] ${worker.worker} does not answer through ${stack.url}`);
  return finish(ctx, {
    node: "bindings", ok: unresolved.length === 0 && silent.length === 0 && verdicts.length > 0,
    gate: "every wrangler.jsonc binding is in the local run's config and resolves (getPlatformProxy, or the running Worker), and every Worker answers through the local router",
    commands: [],
    details: { url: stack.url, workers, bindings: verdicts, unresolved: unresolved.length, notAnswering: silent.map(worker => worker.worker) },
  });
}

await runAsMain(import.meta.url, main);
