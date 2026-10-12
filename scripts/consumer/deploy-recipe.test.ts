import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonical, validateDeployRecipe, type DeployPlan, type RecipeProblem } from "./deploy-recipe.ts";

const here = new URL(".", import.meta.url).pathname;
const RECIPE_PATH = join(here, "fixtures/deploy-recipe/disposable.json");
const CONFIG_PATH = join(here, "fixtures/deploy-recipe/inferos.config.json");
const CLI = join(here, "deploy-recipe.ts");
const recipe = () => JSON.parse(readFileSync(RECIPE_PATH, "utf8")) as Record<string, any>;
const config = () => JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, any>;

/** A fully decided synthetic recipe: every cloud input has a (fictional) value. */
const decided = () => {
  const r = recipe();
  r.target.account = "0123456789abcdef0123456789abcdef";
  r.target.publicOrigin = "https://inferos-disposable-smoke-20261015.example.invalid";
  r.target.oauthOrigins = ["https://inferos-disposable-smoke-20261015.example.invalid"];
  r.target.access = { mode: "staff-only" };
  r.target.admins = { count: 1 };
  r.target.bindings.BLUEPRINTS.resource = "inferos-disposable-smoke-20261015-kv-blueprints";
  r.target.bindings.AVATARS.resource = "inferos-disposable-smoke-20261015-kv-avatars";
  return r;
};

const planOf = (r: unknown): DeployPlan => {
  const result = validateDeployRecipe(r, config());
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as { plan: DeployPlan }).plan;
};
const problemsOf = (r: unknown, c: unknown = config()): RecipeProblem[] => {
  const result = validateDeployRecipe(r, c);
  assert.equal(result.ok, false, "expected the recipe to be refused");
  return (result as { problems: RecipeProblem[] }).problems;
};
/** Refused with this field (and a rule matching `rule`), and the rejected value never echoed. */
function refuses(mutate: (r: Record<string, any>) => void, field: string, rule: RegExp, planted?: string) {
  const r = decided();
  mutate(r);
  const problems = problemsOf(r);
  assert.ok(problems.some(p => p.field === field && rule.test(p.rule)), `${field} ~ ${rule}: ${JSON.stringify(problems)}`);
  if (planted) assert.ok(!JSON.stringify(problems).includes(planted), "a problem must never echo the rejected value");
}

test("the synthetic fixture plans a disposable target, NOT DEPLOYED, with every owner decision unresolved", () => {
  const plan = planOf(recipe());
  assert.equal(plan.status, "NOT DEPLOYED");
  assert.equal(plan.readyToApply, false);
  assert.equal(plan.target.environment, "disposable");
  assert.equal(plan.target.name, "inferos-disposable-smoke-20261015");
  assert.deepEqual(plan.source, { repository: "https://github.com/factory-level/inferos", revision: "0123456789abcdef0123456789abcdef01234567" });
  assert.deepEqual(plan.wrapperConfig, { schemaVersion: 1, revision: "0123456789abcdef0123456789abcdef01234567", inferopsMode: "fixture" });
  assert.deepEqual(plan.inferops, { mode: "mock", baseUrl: null });
  assert.deepEqual(plan.unresolved.map(u => u.field), [
    "target.access", "target.account", "target.admins", "target.bindings.AVATARS.resource",
    "target.bindings.BLUEPRINTS.resource", "target.oauthOrigins", "target.publicOrigin",
  ]);
  assert.equal(plan.target.account, "(unresolved)");
  assert.match(plan.readyReason, /7 input\(s\) unresolved; and no apply command exists/u);
  // Cloud-only steps are listed, never run, each with a pending evidence slot.
  assert.deepEqual(plan.cloudOnly.map(s => [s.id, s.status, s.slot]), [
    ["provision-bindings", "not run", "pending"], ["register-oauth-origins", "not run", "pending"],
    ["access-policy", "not run", "pending"], ["deploy-workers", "not run", "pending"], ["smoke", "not run", "pending"],
    ["deployed-only-checks", "not run", "pending"], ["teardown", "not run", "pending"],
  ]);
  assert.ok(plan.local.every(s => s.status === "checked"));
  assert.deepEqual(plan.target.secrets, ["CLIENT_SECRET"]);
});

test("a fully decided recipe is still not ready to apply: no apply command exists", () => {
  const plan = planOf(decided());
  assert.deepEqual(plan.unresolved, []);
  assert.equal(plan.readyToApply, false);
  assert.match(plan.readyReason, /No apply command exists/u);
  assert.equal(plan.target.publicOrigin, "https://inferos-disposable-smoke-20261015.example.invalid");
  assert.equal(plan.target.admins, "1 admin(s), named outside the recipe");
});

test("the plan is deterministic: key order does not change it or its digest", () => {
  const a = planOf(recipe());
  const reordered = Object.fromEntries(Object.entries(recipe()).toReversed());
  const b = planOf(reordered);
  assert.deepEqual(b, a);
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), canonical({ a: [2, { c: 4, d: 3 }], b: 1 }));
  assert.notEqual(planOf(decided()).recipeDigest, a.recipeDigest);
});

test("missing required inputs are refused; an explicit unresolved marker is not missing", () => {
  refuses(r => { delete r.target.account; }, "target.account", /is required/u);
  refuses(r => { delete r.owner; }, "owner", /is required/u);
  refuses(r => { delete r.source; }, "source", /is required/u);
  refuses(r => { delete r.target.bindings; }, "target.bindings", /is required/u);
  refuses(r => { r.target.account = { unresolved: "" }; }, "target.account", /32-character/u);
});

test("production, shared or default targets are not expressible", () => {
  refuses(r => { r.target.environment = "production"; }, "target.environment", /must be "disposable"/u);
  refuses(r => { delete r.target.environment; }, "target.environment", /must be "disposable"/u);
  refuses(r => { r.target.name = "inferos-prod"; }, "target.name", /inferos-disposable-<slug>-<yyyymmdd>/u);
  refuses(r => {
    r.target.name = "inferos-disposable-shared-20261015";
    r.target.publicOrigin = "https://inferos-disposable-shared-20261015.example.invalid";
    r.target.oauthOrigins = [r.target.publicOrigin];
  }, "target.name", /production, live, main, shared/u);
  refuses(r => { r.target.name = "inferos-disposable-smoke-20261016"; }, "target.name", /expiry date/u);
  refuses(r => { r.expires = "2026-10-30"; r.target.name = "inferos-disposable-smoke-20261030"; }, "expires", /within 7 days/u);
  refuses(r => { r.target.bindings.BLUEPRINT_CONTENT.resource = "gadgets-blueprint-content-prod"; }, "target.bindings.BLUEPRINT_CONTENT.resource", /production or shared/u);
});

test("malformed origins and topology are refused", () => {
  const origin = (value: string) => (r: Record<string, any>) => { r.target.publicOrigin = value; r.target.oauthOrigins = [value]; };
  refuses(origin("http://inferos-disposable-smoke-20261015.example.invalid"), "target.publicOrigin", /https/u);
  refuses(origin("https://inferos-disposable-smoke-20261015.example.invalid/app"), "target.publicOrigin", /origin only/u);
  refuses(origin("https://*.example.invalid"), "target.publicOrigin", /origin only|wildcard/u);
  refuses(origin("https://localhost"), "target.publicOrigin", /local host/u);
  refuses(origin("https://www.example.invalid"), "target.publicOrigin", /first host label/u);
  refuses(origin("https://inferos-disposable-smoke-20261015.prod.example.invalid"), "target.publicOrigin", /production/u);
  refuses(r => { r.target.oauthOrigins = ["https://inferos-disposable-other-20261015.example.invalid"]; }, "target.oauthOrigins[0]", /first host label/u);
  refuses(r => { r.target.oauthOrigins = []; }, "target.oauthOrigins", /at least one/u);
});

test("malformed bindings are refused", () => {
  refuses(r => { r.target.bindings.BLUEPRINTS.type = "queue"; }, "target.bindings.BLUEPRINTS", /must be \{type/u);
  refuses(r => { r.target.bindings.blueprints = { type: "kv", resource: "x" }; }, "target.bindings.blueprints", /UPPER_SNAKE/u);
  refuses(r => { r.target.bindings.AVATARS.resource = r.target.bindings.BLUEPRINTS.resource; }, "target.bindings.AVATARS.resource", /already uses/u);
  refuses(r => { r.target.bindings.API = { type: "secret", resource: "x" }; }, "target.bindings.API", /target\.secrets/u);
});

test("implicit live mode is refused: live InferOps must be explicit and https", () => {
  refuses(r => { r.inferops = { mode: "live", baseUrl: "https://inferops.example.invalid" }; }, "inferops.live", /explicitly/u);
  refuses(r => { r.inferops = { mode: "live", live: true, baseUrl: "http://inferops.example.invalid" }; }, "inferops.baseUrl", /https/u);
  refuses(r => { r.inferops = { mode: "mock", baseUrl: "https://inferops.example.invalid" }; }, "inferops", /mock target takes no/u);
  refuses(r => { r.inferops = {}; }, "inferops.mode", /mock" or "live"/u);
  const live = decided();
  live.inferops = { mode: "live", live: true, baseUrl: { unresolved: "owner: which InferOps environment" } };
  const plan = planOf(live);
  assert.deepEqual(plan.inferops, { mode: "live", baseUrl: "(unresolved)" });
  assert.ok(plan.unresolved.some(u => u.field === "inferops.baseUrl"));
});

test("unsupported cloud extensions are refused, not silently dropped", () => {
  refuses(r => { r.extensions.wrapperGatekeepers = true; }, "extensions.wrapperGatekeepers", /not supported in a cloud deployment/u);
  refuses(r => { r.extensions.customWorkers = true; }, "extensions.customWorkers", /not supported/u);
  refuses(r => { r.extensions.inferopsEnabled = true; }, "extensions.inferopsEnabled", /unknown field/u);
});

test("secrets in a recipe are refused, and never echoed", () => {
  const planted = "ghp_0123456789abcdefSYNTHETIC";
  refuses(r => { r.target.clientSecret = "super-synthetic-value"; }, "target.clientSecret", /secretRef/u, "super-synthetic-value");
  refuses(r => { r.purpose = planted; }, "purpose", /looks like a credential/u, planted);
  refuses(r => { r.target.secrets = ["CLIENT_SECRET"]; }, "target.secrets[0]", /secretRef/u);
  refuses(r => { r.target.bindings.BLUEPRINTS.resource = "sk-SYNTHETIC0123456789"; }, "target.bindings.BLUEPRINTS.resource", /looks like a credential/u, "sk-SYNTHETIC0123456789");
});

test("the source revision and wrapper config are pinned to the wrapper's own config", () => {
  refuses(r => { r.source.revision = "f".repeat(40); }, "source.revision", /equal the wrapper config/u);
  refuses(r => { r.source.revision = "main"; }, "source.revision", /40-character/u);
  refuses(r => { r.wrapperConfig.schemaVersion = 2; }, "wrapperConfig.schemaVersion", /equal the wrapper config/u);
  refuses(r => { r.schemaVersion = 2; }, "schemaVersion", /must be 1/u);
  refuses(r => { r.deployNow = true; }, "deployNow", /unknown field/u);
  const broken = config();
  delete broken.upstream;
  assert.ok(problemsOf(decided(), broken).some(p => p.field === "wrapperConfig" && /invalid/u.test(p.rule)));
});

const cli = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });

test("the CLI prints NOT DEPLOYED first, exits 0 / 1 / 2, and its output holds no secret value", () => {
  const ok = cli([RECIPE_PATH, "--config", CONFIG_PATH]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^NOT DEPLOYED -- local preflight of inferos-disposable-smoke-20261015/u);
  assert.match(ok.stdout, /Cloud-only, NOT RUN:/u);
  const json = cli([RECIPE_PATH, "--config", CONFIG_PATH, "--json"]);
  assert.equal(JSON.parse(json.stdout).status, "NOT DEPLOYED");

  const dir = mkdtempSync(join(tmpdir(), "deploy-recipe-"));
  const bad = decided();
  bad.target.clientSecret = "planted-synthetic-secret";
  writeFileSync(join(dir, "bad.json"), JSON.stringify(bad));
  const refused = cli([join(dir, "bad.json"), "--config", CONFIG_PATH]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^NOT DEPLOYED -- the recipe is invalid/u);
  assert.ok(!`${refused.stdout}${refused.stderr}`.includes("planted-synthetic-secret"));
  assert.equal(cli([RECIPE_PATH]).status, 2);
});

test("no side effects: no deploy, provider, process or network call is made", () => {
  const dir = mkdtempSync(join(tmpdir(), "deploy-recipe-spy-"));
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  // Fake tools first on PATH: any invocation is recorded.
  for (const tool of ["wrangler", "gh", "curl", "npx", "pnpm", "git"]) {
    const path = join(dir, tool);
    writeFileSync(path, `#!/bin/sh\necho "${tool} $*" >> "${log}"\nexit 97\n`);
    chmodSync(path, 0o755);
  }
  // A preload that records and refuses process spawns, sockets and fetch inside the CLI itself.
  const preload = join(dir, "spy.mjs");
  writeFileSync(preload, `
import cp from "node:child_process"; import net from "node:net"; import tls from "node:tls"; import dns from "node:dns";
import { appendFileSync } from "node:fs"; import { syncBuiltinESMExports } from "node:module";
const record = (what) => () => { appendFileSync(${JSON.stringify(log)}, what + "\\n"); throw new Error("blocked " + what); };
for (const k of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) cp[k] = record("child_process." + k);
net.connect = net.createConnection = record("net.connect"); tls.connect = record("tls.connect"); dns.lookup = record("dns.lookup");
globalThis.fetch = record("fetch");
syncBuiltinESMExports();
`);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, NODE_OPTIONS: `--import=${preload}` };
  for (const args of [[RECIPE_PATH, "--config", CONFIG_PATH], [RECIPE_PATH, "--config", CONFIG_PATH, "--json"]]) {
    const run = cli(args, env);
    assert.equal(run.status, 0, run.stderr);
  }
  assert.equal(readFileSync(log, "utf8"), "", "the preflight must not invoke any tool, process, socket or fetch");
  // Control: the same spy does record a process spawn and a fetch, so the empty log above means something.
  const control = join(dir, "control.mjs");
  writeFileSync(control, `import cp from "node:child_process";
try { cp.spawnSync("wrangler", ["deploy"]); } catch {}
try { await fetch("https://example.invalid"); } catch {}
`);
  spawnSync(process.execPath, [control], { encoding: "utf8", env });
  assert.equal(readFileSync(log, "utf8"), "child_process.spawnSync\nfetch\n");
  // And the module imports nothing that could: no process, network or provider client.
  const source = readFileSync(CLI, "utf8");
  for (const forbidden of [/from "node:child_process"/u, /from "node:(?:net|tls|http|https|dns)"/u, /\bfetch\(/u, /wrangler/u]) {
    const code = source.split("\n").filter(line => !line.trim().startsWith("//") && !line.trim().startsWith("*"));
    assert.ok(!code.some(line => forbidden.test(line) && !line.includes("evidence") && !line.includes("readyReason")), `${forbidden}`);
  }
});

// Repairs from independent QA (proof/02): credential markers inside a value, malformed JSON input,
// a remote wrapper config planned as mock, and dates that are not on the calendar.

test("a credential marker anywhere in a value is refused and never reaches the plan", () => {
  const planted = "ghp_QA_SYNTHETIC_TOKEN_0123456789";
  refuses(r => { r.owner = `operator: ${planted}`; }, "owner", /looks like a credential/u, planted);
  refuses(r => { r.purpose = `see sk-SYNTHETIC0123 for access`; }, "purpose", /looks like a credential/u, "sk-SYNTHETIC0123");
  refuses(r => { r.target.bindings.BLUEPRINTS.resource = { unresolved: `ask ${planted}` }; }, "target.bindings.BLUEPRINTS.resource.unresolved", /looks like a credential/u, planted);
  const c = config();
  c.inferops.targetRef = `inferops://t.w/project/board/KEY`;
  c.styling = { ...c.styling, siteName: `InferOS ${planted}` };
  const problems = problemsOf(decided(), c);
  assert.ok(problems.some(p => p.field.startsWith("wrapperConfig:") && /looks like a credential/u.test(p.rule)), JSON.stringify(problems));
  assert.ok(!JSON.stringify(problems).includes(planted));
});

test("malformed recipe or wrapper config JSON exits 2 without reflecting its contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "deploy-recipe-json-"));
  for (const body of ["sk-QA", "{\"owner\": \"ghp_QA_SYNTHETIC_TOKEN_0123456789\"", "{ not json sk-QA-SYNTHETIC }"]) {
    writeFileSync(join(dir, "bad.json"), body);
    for (const args of [[join(dir, "bad.json"), "--config", CONFIG_PATH], [RECIPE_PATH, "--config", join(dir, "bad.json")]]) {
      const run = cli(args);
      assert.equal(run.status, 2);
      const out = `${run.stdout}${run.stderr}`;
      assert.match(out, /^NOT DEPLOYED -- deploy-recipe: the (recipe|wrapper config) file is not valid JSON\n$/u);
      for (const fragment of ["sk-QA", "ghp_QA", "SYNTHETIC", "not json"]) assert.ok(!out.includes(fragment), `${fragment} echoed`);
    }
  }
  const missing = cli([join(dir, "absent.json"), "--config", CONFIG_PATH]);
  assert.equal(missing.status, 2);
  assert.equal(missing.stderr, "NOT DEPLOYED -- deploy-recipe: cannot read the recipe file\n");
});

test("a wrapper config that reads a remote InferOps is never planned as mock", () => {
  const remote = config();
  remote.inferops = { mode: "remote", baseUrl: "https://api.example.invalid", targetRef: remote.inferops.targetRef };
  const asMock = decided();
  assert.ok(problemsOf(asMock, remote).some(p => p.field === "inferops.mode" && /remote InferOps/u.test(p.rule)));
  const otherBase = decided();
  otherBase.inferops = { mode: "live", live: true, baseUrl: "https://other.example.invalid" };
  assert.ok(problemsOf(otherBase, remote).some(p => p.field === "inferops.baseUrl" && /equal the wrapper config/u.test(p.rule)));
  const coherent = decided();
  coherent.inferops = { mode: "live", live: true, baseUrl: "https://api.example.invalid" };
  const result = validateDeployRecipe(coherent, remote);
  assert.equal(result.ok, true, JSON.stringify(result));
  const plan = (result as { plan: DeployPlan }).plan;
  assert.deepEqual([plan.wrapperConfig.inferopsMode, plan.inferops.mode, plan.inferops.baseUrl], ["remote", "live", "https://api.example.invalid"]);
});

test("dates must exist on the calendar before the lifetime is computed", () => {
  refuses(r => {
    r.created = "2026-02-30"; r.expires = "2026-03-03"; r.target.name = "inferos-disposable-smoke-20260303";
    r.target.publicOrigin = "https://inferos-disposable-smoke-20260303.example.invalid";
    r.target.oauthOrigins = [r.target.publicOrigin];
  }, "created", /real calendar date/u);
  refuses(r => { r.expires = "2026-10-32"; }, "expires", /real calendar date/u);
  refuses(r => { r.created = "2026-13-01"; }, "created", /real calendar date/u);
  const leap = decided();
  leap.created = "2028-02-27"; leap.expires = "2028-02-29"; leap.target.name = "inferos-disposable-smoke-20280229";
  leap.target.publicOrigin = "https://inferos-disposable-smoke-20280229.example.invalid";
  leap.target.oauthOrigins = [leap.target.publicOrigin];
  leap.target.bindings.BLUEPRINT_CONTENT.resource = "inferos-disposable-smoke-20280229-blueprints";
  leap.target.bindings.BLUEPRINTS.resource = "inferos-disposable-smoke-20280229-kv-blueprints";
  leap.target.bindings.AVATARS.resource = "inferos-disposable-smoke-20280229-kv-avatars";
  assert.equal(planOf(leap).target.expires, "2028-02-29");
});

test("refusals never repeat an input-derived key: unsafe or credential-looking path segments are redacted", () => {
  const planted = "ghp_QA_SYNTHETIC_TOKEN_0123456789";
  for (const mutate of [
    (r: Record<string, any>) => { r.target.bindings[planted] = { type: "kv", resource: "synthetic" }; },
    (r: Record<string, any>) => { r[planted] = true; },
    (r: Record<string, any>) => { r.target[`x ${planted}`] = 1; },
    (r: Record<string, any>) => { r.extensions[planted] = true; },
  ]) {
    const r = decided();
    mutate(r);
    const problems = problemsOf(r);
    assert.ok(problems.length > 0);
    assert.ok(!JSON.stringify(problems).includes("ghp_"), JSON.stringify(problems));
    assert.ok(problems.some(p => p.field.includes("<key>")), JSON.stringify(problems));
  }
  // A credential-looking key in the wrapper config is redacted too, whether it is reported by this
  // preflight's scan or inside the config parser's own message.
  for (const mutateConfig of [
    (c: Record<string, any>) => { c.styling[planted] = "x"; },
    (c: Record<string, any>) => { c[planted] = true; },
  ]) {
    const c = config();
    mutateConfig(c);
    const problems = problemsOf(decided(), c);
    assert.ok(problems.length > 0);
    assert.ok(!JSON.stringify(problems).includes("ghp_"), JSON.stringify(problems));
  }
  // The CLI's text and JSON refusals carry the same redacted paths.
  const dir = mkdtempSync(join(tmpdir(), "deploy-recipe-key-"));
  const r = decided();
  r.target.bindings[planted] = { type: "kv", resource: "synthetic" };
  writeFileSync(join(dir, "bad.json"), JSON.stringify(r));
  for (const args of [[join(dir, "bad.json"), "--config", CONFIG_PATH], [join(dir, "bad.json"), "--config", CONFIG_PATH, "--json"]]) {
    const run = cli(args);
    assert.equal(run.status, 1);
    assert.ok(!`${run.stdout}${run.stderr}`.includes("ghp_"), `${run.stdout}${run.stderr}`);
    assert.match(`${run.stdout}${run.stderr}`, /target\.bindings\.<key>/u);
  }
  // Ordinary paths are shown as they are.
  const plain = decided();
  plain.target.bindings.blueprints = { type: "kv", resource: "x" };
  assert.ok(problemsOf(plain).some(p => p.field === "target.bindings.blueprints"));
  const indexed = decided();
  indexed.target.oauthOrigins = ["http://x"];
  assert.ok(problemsOf(indexed).some(p => p.field === "target.oauthOrigins[0]"));
});
