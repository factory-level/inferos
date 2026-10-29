#!/usr/bin/env node
// Factory node 7, `dast`: an OWASP ZAP baseline (passive) scan of the local InferOS router.
//
//   node scripts/ci/dast.ts [--run-id ID]
//
// ZAP runs in its container on the host network (it must reach 127.0.0.1; nothing is published),
// writing its JSON and HTML reports into the node's evidence directory. Its own pass/warn exit code
// is not the gate: the gate is no high-risk alert (riskcode 3) that is new against
// `scripts/ci/dast-baseline.json`, keyed by plugin id.
// ponytail: unauthenticated baseline only; upgrade path is a ZAP context authenticated as the
// local seeded user plus an API scan of /api.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveLocalStack } from "../local/stack.ts";
import { dockerRun, exec, finish, nodeContext, runAsMain } from "./lib.ts";

/** One ZAP alert, reduced to what the gate and the evidence need. */
export interface ZapAlert {
  pluginid: string;
  name: string;
  riskcode: number;
  instances: number;
}

/** The alerts of a ZAP JSON report (`-J`). */
export function parseZap(report: { site?: { alerts?: { pluginid: string; alert?: string; name?: string; riskcode: string; count?: string; instances?: unknown[] }[] }[] }): ZapAlert[] {
  return (report.site ?? []).flatMap(site => (site.alerts ?? []).map(alert => ({
    pluginid: alert.pluginid, name: alert.name ?? alert.alert ?? "", riskcode: Number(alert.riskcode),
    instances: Number(alert.count ?? alert.instances?.length ?? 0),
  })));
}

/** High-risk alerts whose plugin id the baseline has not accepted. */
export function newHighAlerts(alerts: ZapAlert[], accepted: string[]): ZapAlert[] {
  return alerts.filter(alert => alert.riskcode >= 3 && !accepted.includes(alert.pluginid));
}

export async function main(argv: string[]): Promise<number> {
  const ctx = nodeContext("dast", argv);
  const target = resolveLocalStack(ctx.root, [], ctx.env).url;
  // ZAP runs as this uid but writes its session scratch beside the reports.
  chmodSync(ctx.dir, 0o777);
  const record = await exec(ctx, dockerRun(ctx, [
    "--network", "host", "-v", `${ctx.dir}:/zap/wrk:rw`,
    "ghcr.io/zaproxy/zaproxy:stable", "zap-baseline.py", "-t", target, "-J", "zap.json", "-r", "zap.html", "-I",
  ]), { log: "zap.log" });
  const reportPath = join(ctx.dir, "zap.json");
  const alerts = existsSync(reportPath) ? parseZap(JSON.parse(readFileSync(reportPath, "utf8"))) : null;
  const baselinePath = join(ctx.root, "scripts", "ci", "dast-baseline.json");
  const accepted: string[] = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")).acceptedHighPluginIds ?? [] : [];
  const fresh = alerts ? newHighAlerts(alerts, accepted) : [];
  writeFileSync(join(ctx.dir, "alerts.json"), JSON.stringify(alerts, null, 2) + "\n");
  for (const alert of fresh) console.error(`[factory] NEW high ZAP alert ${alert.pluginid} ${alert.name}`);
  const byRisk = alerts ? Object.fromEntries([0, 1, 2, 3].map(risk => [["info", "low", "medium", "high"][risk]!, alerts.filter(a => a.riskcode === risk).length])) : null;
  // zap-baseline exits 0 (pass), 1 (fail) or 2 (warn) with -I; anything else, or no report, is a tool failure.
  const ran = [0, 1, 2].includes(record.exitCode) && alerts !== null;
  return finish(ctx, {
    node: "dast", ok: ran && fresh.length === 0,
    gate: "ZAP baseline ran against the local router and no high-risk alert is new against scripts/ci/dast-baseline.json",
    commands: [record], details: { target, alerts: byRisk, newHigh: fresh },
  });
}

await runAsMain(import.meta.url, main);
