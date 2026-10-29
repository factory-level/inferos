#!/usr/bin/env node
// Factory release-graph node 10, `stage-smoke`: the scripted gate on a stage, signed in as the
// grokbot personas. Run from the `stage-probe` sandbox (`pnpm local factory stage-smoke`, which
// runs `doctor stage-probe` first), or directly:
//
//   FACTORY_STAGE_URL=<origin> node scripts/ci/stage-smoke.ts [--run-id ID] [--part all|flow|probe]
//
// `flow` (scripts/ci/stage-smoke-flow.ts) runs in the artilleryio/artillery container with its
// bundled Playwright and Chromium, this checkout mounted read-only at its own path (so `capnweb`
// resolves) and the evidence directory writable: as the operator persona it signs in through the
// stage's own login page, opens the board on a canvas and asserts its cards render, proposes one
// move (simulated on the board, InferOps unchanged), approves it in the Activity panel and confirms
// through InferOps' own API that the state and revision changed, then moves it back the same way;
// as the viewer persona it asserts a move is refused and InferOps is unchanged. As each persona it
// also reads the InferMind Wiki (`grokbot.knowledge`) through its own connection, checks the page
// against InferOps' knowledge API and asserts it renders in the canvas Wiki widget. `probe` is a light
// Artillery Playwright-engine run (load/stage-probe.yml, 2 VUs) of the sign-in, for latency.
//
// Credentials reach the container by name (`docker run -e NAME`), never on a command line or in a
// log, and the evidence names personas by role. An emulated stage (FACTORY_STAGE_ACCESS=emulated: the
// loopback `dev` sandbox behind scripts/local/access-emulator.ts) sends the Access service token like
// a remote one, with the loopback stage's stub personas. Required names follow the stage's kind
// (`requiredSmokeCredentials` in scripts/local/factory.ts). Gate: every flow oracle passes and the
// probe's `ensure` conditions hold. Evidence: `<run>/stage-smoke/` (smoke.json, screenshots, the
// probe report, result.json).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { forbiddenCredentials, requiredSmokeCredentials, STAGE_SMOKE_IMAGE, stageTarget, type StageTarget } from "../local/factory.ts";
import { summarizeArtillery } from "./perf.ts";
import { dockerRun, exec, finish, nodeContext, runAsMain, type CommandRecord, type NodeContext } from "./lib.ts";

/** The variables passed into the smoke's container, by name only: whichever of these are set. */
const PASSED_VARS = ["FACTORY_STAGE_URL", "FACTORY_STAGE_BOARD", "FACTORY_STAGE_WIKI", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "GROKBOT_PERSONA_USER", "GROKBOT_PERSONA_PASSWORD", "GROKBOT_VIEWER_USER"];

/** Why the smoke cannot start against `env`, or null: an unusable stage, forbidden or missing credentials. */
export function smokePreconditions(env: NodeJS.ProcessEnv): { target: StageTarget | null; problem: string | null } {
  if (!env.FACTORY_STAGE_URL) return { target: null, problem: "FACTORY_STAGE_URL names no stage" };
  let target: StageTarget;
  try {
    target = stageTarget(env.FACTORY_STAGE_URL, env.FACTORY_STAGE_ACCESS);
  } catch (error) {
    return { target: null, problem: (error as Error).message };
  }
  const forbidden = forbiddenCredentials(env, "stage-probe");
  if (forbidden.length) return { target, problem: `cloud/provider/prod credentials present (names only): ${forbidden.join(", ")}` };
  const missing = requiredSmokeCredentials(target.kind).filter(name => !env[name]);
  if (missing.length) return { target, problem: `${target.kind} stage, missing (names only): ${missing.join(", ")}` };
  return { target, problem: null };
}

/** The docker arguments for one smoke container: named variables only, loopback and emulated stages on the host network. */
export function smokeContainer(ctx: Pick<NodeContext, "root" | "dir" | "env">, target: StageTarget, command: string[]): string[] {
  const names = PASSED_VARS.filter(name => ctx.env[name]);
  return dockerRun(ctx as NodeContext, [
    ...(target.kind !== "remote" ? ["--network", "host"] : []),
    ...names.flatMap(name => ["-e", name]),
    "-v", `${ctx.root}:${ctx.root}:ro`, "-v", `${ctx.dir}:${ctx.dir}`,
    ...command,
  ]);
}

export async function main(argv: string[]): Promise<number> {
  const ctx = nodeContext("stage-smoke", argv);
  const part = ctx.part ?? "all";
  if (!["all", "flow", "probe"].includes(part)) throw new Error("--part must be all, flow or probe");
  const { target, problem } = smokePreconditions(ctx.env);
  const gate = "node 10: as each persona the grokbot.knowledge Wiki page InferOps' knowledge API answers renders in the canvas Wiki widget; as the operator persona the board renders and a simulate -> approve transition is visible in InferOps' API (then reverted); the viewer persona is refused with InferOps unchanged; the light Artillery Playwright probe's ensure holds";
  if (problem || !target) return finish(ctx, { node: "stage-smoke", ok: false, gate, commands: [], details: { refused: problem } });
  const records: CommandRecord[] = [];
  const details: Record<string, unknown> = { stage: target.origin, kind: target.kind };
  if (part === "all" || part === "flow") {
    const record = await exec(ctx, smokeContainer(ctx, target, [
      "--entrypoint", "node", STAGE_SMOKE_IMAGE, join(ctx.root, "scripts", "ci", "stage-smoke-flow.ts"), ctx.dir,
    ]), { log: "flow.log" });
    records.push(record);
    try {
      const smoke = JSON.parse(readFileSync(join(ctx.dir, "smoke.json"), "utf8")) as { ok: boolean; oracles: { name: string; ok: boolean; detail: string }[]; notes?: unknown };
      details.oracles = smoke.oracles;
      details.notes = smoke.notes;
      details.flowOk = smoke.ok && record.exitCode === 0;
    } catch {
      details.flowOk = false;
      details.oracles = "smoke.json was not written; see flow.log";
    }
  }
  if (part === "all" || part === "probe") {
    const record = await exec(ctx, smokeContainer(ctx, target, [
      "-e", `FACTORY_TARGET=${target.origin}`, "-v", `${join(ctx.root, "load")}:/load:ro`,
      STAGE_SMOKE_IMAGE, "run", "--output", join(ctx.dir, "probe.json"), "/load/stage-probe.yml",
    ]), { log: "probe.log" });
    records.push(record);
    const checked = /^Checks:/m.test(readFileSync(record.log, "utf8"));
    let summary: unknown = null;
    try {
      summary = summarizeArtillery(JSON.parse(readFileSync(join(ctx.dir, "probe.json"), "utf8")));
    } catch {
      // No report: the exit code and the log say why.
    }
    details.probe = { ensureEvaluated: checked, summary };
    details.probeOk = record.exitCode === 0 && checked;
  }
  const ok = (part === "probe" || details.flowOk === true) && (part === "flow" || details.probeOk === true);
  return finish(ctx, { node: "stage-smoke", ok, gate, commands: records, details });
}

await runAsMain(import.meta.url, main);
