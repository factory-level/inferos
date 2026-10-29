#!/usr/bin/env node
// The InferOS side of the factory release graph, nodes 1-8, run locally:
//
//   node scripts/ci/pipeline.ts --target=local [--only a,b] [--skip a,b] [--keep-going] [--run-id ID] [--base REF]
//   pnpm factory:ci                                   (the same, --target=local)
//
// Each node is its own script (`scripts/ci/<node>.ts`), run here as a child exactly as the thin
// composite actions in `.github/actions/*` run it under GitHub Actions, so a red GHA job reproduces
// with the same command in a shell. Evidence goes to `.factory/runs/<run-id>/<node>/` and the run's
// `state.json` records each node's outcome; the first failing gate stops the run (`--keep-going`
// runs the rest) and the exit code is 1 when any gate failed.
//
// Before anything runs, the environment is checked for cloud, model-provider and prod credentials
// (the factory sandboxes' rule, scripts/local/factory.ts): the pipeline refuses to run with one.
// Nodes 0 (intake), 6 (e2e) and 9-12 (release, stage smoke, rollback) are not part of this local
// InferOS graph yet; see docs/architecture/factory.md.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { forbiddenCredentials } from "../local/factory.ts";
import { newRunId, ROOT, runAsMain, runsDir } from "./lib.ts";

/** The nodes, in release-graph order. `local-deploy` precedes the nodes that need the stack. */
export const NODES = ["verify", "security", "build", "local-deploy", "bindings", "dast", "perf"] as const;
export type PipelineNode = (typeof NODES)[number];

/** The run's state file: what ran, what passed. */
export interface PipelineState {
  runId: string;
  target: "local" | "gha";
  startedAt: string;
  nodes: { node: PipelineNode; ok: boolean; exitCode: number; durationMs: number }[];
  passes: PipelineNode[];
  skipped: PipelineNode[];
  ok: boolean | null;
}

/** What the pipeline touches; tests replace it. */
export interface PipelineDeps {
  root: string;
  env: NodeJS.ProcessEnv;
  runNode: (node: PipelineNode, args: string[]) => Promise<number>;
  writeState: (path: string, state: PipelineState) => void;
  now: () => number;
  log: (line: string) => void;
}

function runNodeChild(node: PipelineNode, args: string[]): Promise<number> {
  return new Promise(settle => {
    const child = spawn(process.execPath, [join(ROOT, "scripts", "ci", `${node}.ts`), ...args], { cwd: ROOT, stdio: "inherit" });
    child.on("error", () => settle(127));
    child.on("close", code => settle(code ?? 1));
  });
}

export const defaultPipelineDeps: PipelineDeps = {
  root: ROOT,
  env: process.env,
  runNode: runNodeChild,
  writeState: (path, state) => writeFileSync(path, JSON.stringify(state, null, 2) + "\n"),
  now: Date.now,
  log: line => console.log(line),
};

const parseList = (value: string | undefined): string[] => (value ? value.split(",").map(item => item.trim()).filter(Boolean) : []);

/** Run the graph. Returns the exit code: 0 green, 1 a gate failed or the run was refused, 2 usage. */
export async function runPipeline(argv: string[], deps: PipelineDeps = defaultPipelineDeps): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { target: { type: "string" }, only: { type: "string" }, skip: { type: "string" }, "keep-going": { type: "boolean", default: false }, "run-id": { type: "string" }, base: { type: "string" } },
    }));
  } catch (error) {
    deps.log((error as Error).message);
    return 2;
  }
  if (values.target !== "local" && values.target !== "gha") {
    deps.log("--target=local|gha is required (gha: the same graph, as the reusable workflows run it)");
    return 2;
  }
  const only = parseList(values.only);
  const skip = parseList(values.skip);
  const unknown = [...only, ...skip].filter(node => !(NODES as readonly string[]).includes(node));
  if (unknown.length) {
    deps.log(`unknown node(s): ${unknown.join(", ")}; nodes: ${NODES.join(", ")}`);
    return 2;
  }
  const credentials = forbiddenCredentials(deps.env, "verify");
  if (credentials.length) {
    deps.log(`[factory] refused: cloud/provider/prod credentials in the environment (names only): ${credentials.join(", ")}`);
    return 1;
  }
  const runId = values["run-id"] ?? newRunId(deps.root, new Date(deps.now()));
  const dir = join(runsDir(deps.root), runId);
  mkdirSync(dir, { recursive: true });
  const selected = NODES.filter(node => (only.length === 0 || only.includes(node)) && !skip.includes(node));
  const state: PipelineState = {
    runId, target: values.target, startedAt: new Date(deps.now()).toISOString(), nodes: [], passes: [],
    skipped: NODES.filter(node => !selected.includes(node)), ok: null,
  };
  const statePath = join(dir, "state.json");
  deps.writeState(statePath, state);
  const nodeArgs = ["--run-id", runId, `--target=${values.target}`, ...(values.base ? ["--base", values.base] : [])];
  for (const node of selected) {
    deps.log(`\n[factory] ==> ${node} (run ${runId})`);
    const started = deps.now();
    const exitCode = await deps.runNode(node, nodeArgs);
    state.nodes.push({ node, ok: exitCode === 0, exitCode, durationMs: deps.now() - started });
    if (exitCode === 0) state.passes.push(node);
    deps.writeState(statePath, state);
    if (exitCode !== 0 && !values["keep-going"]) break;
  }
  state.ok = state.nodes.length === selected.length && state.nodes.every(entry => entry.ok);
  deps.writeState(statePath, state);
  deps.log(`\n[factory] run ${runId}: ${state.ok ? "GREEN" : "RED"}`);
  for (const entry of state.nodes) deps.log(`  ${entry.ok ? "PASS" : "FAIL"}  ${entry.node.padEnd(12)} ${(entry.durationMs / 1000).toFixed(1)}s`);
  for (const name of selected.filter(node => !state.nodes.some(entry => entry.node === node))) deps.log(`  ----  ${name.padEnd(12)} not run (an earlier gate failed)`);
  deps.log(`  evidence: ${dir}`);
  return state.ok ? 0 : 1;
}

await runAsMain(import.meta.url, runPipeline);
