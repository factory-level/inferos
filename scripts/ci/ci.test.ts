import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { declaredBindings, judgeWorker } from "./bindings.ts";
import { accountFreeEnv } from "./build.ts";
import { newHighAlerts, parseZap } from "./dast.ts";
import { dockerRun, nodeContext } from "./lib.ts";
import { summarizeArtillery } from "./perf.ts";
import { NODES, runPipeline, type PipelineDeps, type PipelineNode, type PipelineState } from "./pipeline.ts";
import { smokeContainer, smokePreconditions } from "./stage-smoke.ts";
import { cvssSeverity, dedupe, newFindings, parseGitleaks, parseOsv, parseSemgrep, parseTrivy, type Baseline } from "./security.ts";
import { VERIFY_PARTS } from "./verify.ts";

const REPO = join(import.meta.dirname, "..", "..");

function pipelineDeps(exitCodes: Partial<Record<PipelineNode, number>> = {}, env: NodeJS.ProcessEnv = { PATH: "/bin" }) {
  const root = mkdtempSync(join(tmpdir(), "inferos-pipeline-"));
  const ran: { node: PipelineNode; args: string[] }[] = [];
  const states: PipelineState[] = [];
  const lines: string[] = [];
  let clock = 0;
  const deps: PipelineDeps = {
    root, env,
    runNode: async (node, args) => { ran.push({ node, args }); clock += 1_000; return exitCodes[node] ?? 0; },
    writeState: (_path, state) => { states.push(structuredClone(state)); },
    now: () => clock,
    log: line => { lines.push(line); },
  };
  return { deps, ran, states, lines, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("the pipeline runs every node in release-graph order with one run id, and goes green", async () => {
  const p = pipelineDeps();
  try {
    assert.equal(await runPipeline(["--target=local", "--run-id", "local-test"], p.deps), 0);
    assert.deepEqual(p.ran.map(r => r.node), [...NODES]);
    assert.ok(p.ran.every(r => r.args.includes("local-test") && r.args.includes("--target=local")));
    const last = p.states.at(-1)!;
    assert.equal(last.ok, true);
    assert.deepEqual(last.passes, [...NODES]);
  } finally {
    p.cleanup();
  }
});

test("a failed gate stops the run with exit 1 unless --keep-going", async () => {
  const p = pipelineDeps({ security: 1 });
  try {
    assert.equal(await runPipeline(["--target=local"], p.deps), 1);
    assert.deepEqual(p.ran.map(r => r.node), ["verify", "security"]);
    assert.equal(p.states.at(-1)!.ok, false);
    assert.ok(p.lines.some(line => /not run \(an earlier gate failed\)/.test(line)));
  } finally {
    p.cleanup();
  }
  const k = pipelineDeps({ security: 1 });
  try {
    assert.equal(await runPipeline(["--target=local", "--keep-going"], k.deps), 1);
    assert.equal(k.ran.length, NODES.length);
  } finally {
    k.cleanup();
  }
});

test("--only and --skip select nodes; unknown nodes and a missing target are usage errors", async () => {
  const p = pipelineDeps();
  try {
    assert.equal(await runPipeline(["--target=local", "--only", "perf,dast"], p.deps), 0);
    assert.deepEqual(p.ran.map(r => r.node), ["dast", "perf"]);
    assert.equal(await runPipeline(["--target=local", "--skip", "nope"], p.deps), 2);
    assert.equal(await runPipeline([], p.deps), 2);
  } finally {
    p.cleanup();
  }
});

test("the pipeline refuses to run with a cloud or provider credential, naming it but not its value", async () => {
  const p = pipelineDeps({}, { PATH: "/bin", CLOUDFLARE_API_TOKEN: "cf-secret-token-value" });
  try {
    assert.equal(await runPipeline(["--target=local"], p.deps), 1);
    assert.equal(p.ran.length, 0);
    assert.ok(p.lines.some(line => line.includes("CLOUDFLARE_API_TOKEN")));
    assert.ok(!p.lines.join("\n").includes("cf-secret-token-value"));
  } finally {
    p.cleanup();
  }
});

test("verify keeps CI's commands: the lint job's three, then build, then test", () => {
  assert.deepEqual(VERIFY_PARTS.lint, [["pnpm", "lint:check"], ["pnpm", "types:scripts"], ["pnpm", "configs:check"]]);
  assert.deepEqual(VERIFY_PARTS.build, [["pnpm", "build"]]);
  assert.deepEqual(VERIFY_PARTS.test, [["pnpm", "test"]]);
  assert.deepEqual(VERIFY_PARTS.all, [["pnpm", "lint"], ["pnpm", "test"], ["pnpm", "docs:check"]]);
});

test("ci.yml calls the reusable _verify.yml, whose jobs are setup + one scripts/ci step each", () => {
  const ci = parse(readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8"));
  assert.equal(ci.jobs.verify.uses, "./.github/workflows/_verify.yml");
  const verify = parse(readFileSync(join(REPO, ".github/workflows/_verify.yml"), "utf8"));
  assert.ok(verify.on.workflow_call);
  assert.equal(verify.jobs.lint.name, "Lint");
  assert.equal(verify.jobs.test.name, "Build and test");
  for (const job of Object.values(verify.jobs) as { steps: { uses?: string; with?: Record<string, string> }[] }[]) {
    assert.equal(job.steps[0]!.with?.["persist-credentials"], false);
    const parts = job.steps.filter(step => step.uses === "./.github/actions/verify").map(step => step.with?.part);
    assert.ok(parts.length > 0);
    for (const part of parts) assert.ok(VERIFY_PARTS[part!], String(part));
  }
  const action = parse(readFileSync(join(REPO, ".github/actions/verify/action.yml"), "utf8"));
  assert.match(action.runs.steps[0].run, /^node scripts\/ci\/verify\.ts /);
  // The input reaches the shell as an environment variable, never interpolated into the script.
  assert.ok(!action.runs.steps[0].run.includes("${{"));
});

test("security findings normalize to line-stable fingerprints and severities", () => {
  const root = "/repo";
  assert.deepEqual(parseSemgrep({ results: [{ check_id: "r.x", path: "/repo/a.ts", extra: { severity: "ERROR" } }] }, root),
    [{ tool: "semgrep", id: "r.x", location: "a.ts", severity: "high", fingerprint: "semgrep:r.x:a.ts" }]);
  assert.equal(parseGitleaks([{ RuleID: "aws-access-token", File: "/repo/k.txt" }], root)[0]!.severity, "critical");
  assert.deepEqual(parseGitleaks(null, root), []);
  assert.deepEqual([cvssSeverity("9.2"), cvssSeverity("7.5"), cvssSeverity("5.9"), cvssSeverity("2.1"), cvssSeverity("")], ["critical", "high", "medium", "low", "unknown"]);
  const osv = parseOsv({ results: [{ packages: [{ package: { name: "nanoid", version: "3.1.0" }, groups: [{ ids: ["GHSA-1"], max_severity: "7.5" }] }] }] });
  assert.equal(osv[0]!.fingerprint, "osv:GHSA-1:nanoid");
  const trivy = parseTrivy({ Results: [{ Target: "pnpm-lock.yaml", Vulnerabilities: [{ VulnerabilityID: "CVE-1", PkgName: "x", Severity: "HIGH" }, { VulnerabilityID: "CVE-1", PkgName: "x", Severity: "HIGH" }] }, { Target: "f.json", Secrets: [{ RuleID: "jwt", Severity: "MEDIUM" }] }] });
  assert.equal(dedupe(trivy).length, 2);
  assert.equal(trivy.at(-1)!.fingerprint, "trivy:jwt:f.json");
});

test("only high/critical findings missing from the reviewed baseline fail the gate (a seeded secret fails)", () => {
  const baseline: Baseline = { note: "", accepted: [{ fingerprint: "osv:GHSA-1:nanoid", severity: "high" }] };
  const existing = parseOsv({ results: [{ packages: [{ package: { name: "nanoid", version: "3.1.0" }, groups: [{ ids: ["GHSA-1"], max_severity: "7.5" }, { ids: ["GHSA-2"], max_severity: "5.0" }] }] }] });
  assert.deepEqual(newFindings(existing, baseline), []);
  const seeded = parseGitleaks([{ RuleID: "aws-access-token", File: "/repo/seeded.txt" }], "/repo");
  assert.deepEqual(newFindings([...existing, ...seeded], baseline).map(f => f.fingerprint), ["gitleaks:aws-access-token:seeded.txt"]);
});

test("ZAP alerts gate on new high risk only", () => {
  const alerts = parseZap({ site: [{ alerts: [{ pluginid: "10038", name: "CSP", riskcode: "2", count: "3" }, { pluginid: "40012", name: "XSS", riskcode: "3", count: "1" }] }] });
  assert.deepEqual(alerts.map(a => [a.pluginid, a.riskcode, a.instances]), [["10038", 2, 3], ["40012", 3, 1]]);
  assert.deepEqual(newHighAlerts(alerts, []).map(a => a.pluginid), ["40012"]);
  assert.deepEqual(newHighAlerts(alerts, ["40012"]), []);
});

test("bindings: declared from every kind; worker_loaders are proven by the running Worker, the rest by the proxy", () => {
  const deploy = {
    kv_namespaces: [{ binding: "KV" }], r2_buckets: [{ binding: "R2" }], services: [{ binding: "SVC" }],
    worker_loaders: [{ binding: "LOADER" }], browser: { binding: "BROWSER" }, assets: { binding: "ASSETS" },
    durable_objects: { bindings: [{ name: "DO" }] }, vars: { NOT_A_BINDING: "x" },
  };
  assert.deepEqual(declaredBindings(deploy).map(b => b.name).toSorted(), ["ASSETS", "BROWSER", "DO", "KV", "LOADER", "R2", "SVC"]);
  const dev = { ...deploy, services: [{ binding: "SVC" }, { binding: "GATEKEEPER_X" }] };
  const verdicts = judgeWorker("w", deploy, dev, new Set(["KV", "R2", "SVC", "BROWSER", "ASSETS", "DO"]), true);
  assert.ok(verdicts.every(v => v.resolvedBy && v.inLocalRunConfig));
  assert.equal(verdicts.find(v => v.name === "LOADER")!.resolvedBy, "local-run");
  assert.equal(judgeWorker("w", deploy, dev, new Set(), false).find(v => v.name === "LOADER")!.resolvedBy, null);
  assert.equal(judgeWorker("w", deploy, null, new Set(["KV"]), true).find(v => v.name === "KV")!.inLocalRunConfig, false);
});

test("the build child gets no Cloudflare account, and tool containers never get the Docker socket", () => {
  assert.deepEqual(accountFreeEnv({ PATH: "/b", CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a", CF_API_KEY: "k" }), { PATH: "/b" });
  const root = mkdtempSync(join(tmpdir(), "inferos-ci-"));
  try {
    const ctx = nodeContext("security", ["--run-id", "t-1"], {}, root);
    assert.equal(ctx.dir, join(root, ".factory", "runs", "t-1", "security"));
    const argv = dockerRun(ctx, ["-v", "/x:/x:ro", "image"]).join(" ");
    assert.match(argv, /^docker run --rm -u \d+:\d+ /);
    assert.ok(!argv.includes("docker.sock") && !/ -p /.test(argv));
    assert.throws(() => nodeContext("security", ["--run-id", "../escape"], {}, root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Artillery reports summarize p95s, codes and browser vitals", () => {
  const summary = summarizeArtillery({ aggregate: {
    counters: { "vusers.created": 2, "vusers.completed": 2, "http.codes.200": 9 },
    summaries: { "http.response_time": { p95: 40 }, "browser.page.LCP.http://localhost:8787/": { p75: 300, p95: 400 }, "browser.step.sign_in": { p95: 900 } },
  } });
  assert.deepEqual(summary.vusers, { created: 2, completed: 2, failed: 0 });
  assert.deepEqual(summary.codes, { "http.codes.200": 9 });
  assert.equal((summary.vitals as Record<string, { p75: number }>)["browser.page.LCP.http://localhost:8787/"]!.p75, 300);
  assert.ok((summary.steps as Record<string, unknown>)["browser.step.sign_in"]);
});

test("every load scenario enables the ensure plugin, without which Artillery ignores its gates", () => {
  for (const file of ["inferos-http.yml", "inferos-browser.yml"]) {
    const config = parse(readFileSync(join(REPO, "load", file), "utf8")).config;
    assert.ok(config.plugins && "ensure" in config.plugins, file);
    assert.ok(config.ensure.thresholds.length > 0 && config.ensure.conditions.length > 0, file);
  }
});

test("stage-smoke: a loopback stage needs the persona names, a remote one the Access token too; forbidden keys refuse", () => {
  assert.match(String(smokePreconditions({}).problem), /names no stage/);
  assert.match(String(smokePreconditions({ FACTORY_STAGE_URL: "http://dev-os.example.test" }).problem), /must be https/);
  const loopback = { FACTORY_STAGE_URL: "http://localhost:8797", GROKBOT_PERSONA_USER: "op", GROKBOT_VIEWER_USER: "vw" };
  assert.deepEqual(smokePreconditions(loopback), { target: { origin: "http://localhost:8797", kind: "loopback" }, problem: null });
  assert.match(String(smokePreconditions({ ...loopback, OPENAI_API_KEY: "sk-secret" }).problem), /present \(names only\): OPENAI_API_KEY$/);
  assert.match(String(smokePreconditions({ ...loopback, FACTORY_STAGE_URL: "https://dev-os.example.test" }).problem),
    /remote stage, missing \(names only\): CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, GROKBOT_PERSONA_PASSWORD$/);
});

test("stage-smoke containers get credentials by name only, the checkout read-only, host network for loopback only", () => {
  const env = { FACTORY_STAGE_URL: "http://localhost:8797", GROKBOT_PERSONA_USER: "operator-secret", GROKBOT_VIEWER_USER: "viewer-secret", PATH: "/bin" };
  const ctx = { root: "/repo", dir: "/repo/.factory/runs/r/stage-smoke", env };
  const loopback = smokeContainer(ctx, { origin: "http://localhost:8797", kind: "loopback" }, ["image", "cmd"]);
  assert.ok(!loopback.join(" ").includes("secret"));
  assert.deepEqual(loopback.slice(-14, -2), ["--network", "host", "-e", "FACTORY_STAGE_URL", "-e", "GROKBOT_PERSONA_USER", "-e", "GROKBOT_VIEWER_USER", "-v", "/repo:/repo:ro", "-v", "/repo/.factory/runs/r/stage-smoke:/repo/.factory/runs/r/stage-smoke"]);
  assert.ok(!loopback.includes("/var/run/docker.sock") && !loopback.some(arg => arg.startsWith("-p")));
  assert.ok(!smokeContainer(ctx, { origin: "https://dev-os.example.test", kind: "remote" }, ["image"]).includes("--network"));
});
