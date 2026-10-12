import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readIntakeFile } from "./intake.ts";
import {
  buildDeclarationReport, canonical, DeclarationError, formatDeclarationReport, parseMetricDeclarations, UNSUPPORTED,
} from "./metric-declarations.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const module = join(here, "metric-declarations.ts");
const fixturePath = join(here, "fixtures/metric-declarations/acme-field-ops.json");
const intakePath = join(here, "fixtures/intake/acme-field-ops.json");
const { intake, sha256: intakeSha } = readIntakeFile(intakePath);
const fixture = () => JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, any>;
// Planted in every rejected value; no message may contain it.
const SENTINEL = "sentinel-0xDEADBEEF";

/** The digest of the Acme fixture at this revision. A change to the fixture or the normalization changes it. */
const ACME_DIGEST = "b1dcf6614ba075736961d0e58fd47381d8a3661260290121f10292900779e510";

const report = (input: unknown) => buildDeclarationReport(parseMetricDeclarations(input, intake), intake, intakeSha);

const refused = (mutate: (input: Record<string, any>) => void): DeclarationError => {
  const input = fixture();
  mutate(input);
  try { parseMetricDeclarations(input, intake); } catch (error) {
    assert.ok(error instanceof DeclarationError, `expected a DeclarationError, got ${String(error)}`);
    assert.ok(!error.message.includes(SENTINEL), `message echoed the rejected value: ${error.message}`);
    return error;
  }
  assert.fail("expected the declarations to be refused");
};

const cli = (args: string[], cwd = repo) => spawnSync(process.execPath, [module, ...args], { cwd, encoding: "utf8" });

test("the Acme fixture yields a deterministic report with a pinned digest", () => {
  const first = JSON.stringify(report(fixture()));
  assert.equal(JSON.stringify(report(fixture())), first);
  assert.equal(report(fixture()).declarationsDigest, ACME_DIGEST);
  assert.equal(report(fixture()).intakeSha256, intakeSha);
  // Key order, metric order, dimension order and value order do not change the content digest.
  const shuffled = fixture();
  shuffled.metrics = shuffled.metrics.toReversed();
  shuffled.metrics[2].dimensions[0].values = shuffled.metrics[2].dimensions[0].values.toReversed();
  const reordered = Object.fromEntries(Object.entries(shuffled).toReversed());
  assert.equal(JSON.stringify(report(reordered)), first);
  const twoDimensions = (order: "forward" | "reverse") => {
    const input = fixture();
    const dimensions = [{ name: "crew_type", values: ["inspection", "repair"] }, { name: "region", values: ["east", "north", "south"] }];
    input.metrics[2].dimensions = order === "forward" ? dimensions : dimensions.toReversed();
    return JSON.stringify(report(input));
  };
  assert.equal(twoDimensions("reverse"), twoDimensions("forward"));
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
});

test("the report carries every metric through with explicit unavailable and unresolved dispositions", () => {
  const result = report(fixture());
  assert.equal(result.status, "NOT REGISTERED");
  assert.deepEqual(result.scope, { tenant: "acme", workspace: "operations", isolation: "not-enforced" });
  assert.equal(result.synthetic, true);
  const byKey = Object.fromEntries(result.metrics.map(metric => [metric.key, metric]));
  assert.deepEqual(Object.keys(byKey), ["custom.crew_dispatches", "custom.first_time_fix_rate", "custom.open_safety_checks", "custom.work_order_lead_time", "custom.work_orders_closed"]);
  for (const metric of result.metrics) {
    assert.equal(metric.version, null, "versions are assigned by InferOps, never here");
    assert.equal(metric.approval, "unavailable");
    assert.equal(metric.registration, "none");
    assert.ok(["declared", "unsupported"].includes(metric.disposition));
  }
  assert.equal(byKey["custom.crew_dispatches"]!.producer, "unresolved");
  assert.equal(byKey["custom.crew_dispatches"]!.deriver, "not-applicable");
  assert.deepEqual(byKey["custom.crew_dispatches"]!.dimensions, [{ name: "region", values: ["east", "north", "south"] }]);
  assert.equal(byKey["custom.work_orders_closed"]!.deriver, "unavailable");
  assert.equal(byKey["custom.work_orders_closed"]!.producer, "not-applicable");
  assert.equal(byKey["custom.work_orders_closed"]!.disposition, "declared");
  assert.deepEqual(byKey["custom.work_orders_closed"]!.attribution, { operation: "close-work-order", accountable: "Field supervisor" });
  assert.deepEqual(byKey["custom.first_time_fix_rate"]!.reasons, [UNSUPPORTED.aggregation]);
  assert.deepEqual(byKey["custom.work_order_lead_time"]!.reasons, [UNSUPPORTED.distribution, UNSUPPORTED.aggregation]);
  // Nothing is ever claimed supported, registered, approved or enforced.
  const serialized = JSON.stringify(result);
  for (const claim of ['"supported"', '"registered"', '"approved"', '"enforced"', '"active"']) assert.ok(!serialized.includes(claim), claim);
  assert.match(formatDeclarationReport(result), /^NOT REGISTERED -- local check of 5 metric declaration\(s\)/u);
});

test("well-formed constructs outside this revision's subset are reported unsupported with their source", () => {
  const cases: [string, (input: Record<string, any>) => void, string][] = [
    ["avg", input => { input.metrics[0].aggregation = "avg"; }, UNSUPPORTED.aggregation],
    ["ref dimension", input => { input.metrics[2].dimensions = [{ name: "crew", cardinalityCap: 20 }]; }, UNSUPPORTED.ref],
    ["live source", input => { input.metrics[1].source = { kind: "live" }; }, UNSUPPORTED.live],
    ["derived with a dimension", input => { input.metrics[0].dimensions = [{ name: "label", values: ["urgent"] }]; }, UNSUPPORTED.derivedDimensions],
    ["distribution", input => { input.metrics[0] = { ...input.metrics[4], key: "custom.wait" }; }, UNSUPPORTED.distribution],
  ];
  for (const [label, mutate, reason] of cases) {
    const input = fixture();
    mutate(input);
    const unsupported = report(input).metrics.filter(metric => metric.reasons.includes(reason));
    assert.ok(unsupported.length > 0, label);
    for (const metric of unsupported) assert.equal(metric.disposition, "unsupported", label);
  }
  for (const reason of Object.values(UNSUPPORTED)) assert.match(reason, /MVP-19 rev2|draft|InferOps Metrics|source/u);
});

test("malformed, unknown and out-of-bounds declarations are refused by field and rule, never by value", () => {
  const cases: [string, (input: Record<string, any>) => void, string, RegExp][] = [
    ["schema version", input => { input.schemaVersion = 2; }, "schemaVersion", /only version 1/u],
    ["document kind", input => { input.kind = SENTINEL; }, "kind", /metric-declarations/u],
    ["unknown root field", input => { input[SENTINEL] = true; }, "declarations", /expected exactly/u],
    ["synthetic mismatch", input => { input.synthetic = false; }, "synthetic", /match the intake/u],
    ["empty metrics", input => { input.metrics = []; }, "metrics", /1 to 64/u],
    ["unknown metric field", input => { input.metrics[0].owner = SENTINEL; }, "metrics[0]", /expected exactly/u],
    ["built-in shadowing key", input => { input.metrics[0].key = "project.wip"; }, "metrics[0].key", /must start with custom\./u],
    ["malformed custom key", input => { input.metrics[0].key = `custom.${SENTINEL}`; }, "metrics[0].key", /custom\.<lowercase_name>/u],
    ["duplicate key", input => { input.metrics[1].key = input.metrics[0].key; }, "metrics", /duplicate/u],
    ["unknown kind", input => { input.metrics[0].kind = SENTINEL; }, "metrics[0].kind", /counter, gauge, distribution/u],
    ["unknown aggregation", input => { input.metrics[0].aggregation = SENTINEL; }, "metrics[0].aggregation", /expected one of/u],
    ["unknown grain", input => { input.metrics[0].grain = "minute"; }, "metrics[0].grain", /hour, day/u],
    ["control character", input => { input.metrics[0].name = "Closed\u0007"; }, "metrics[0].name", /control characters/u],
    ["unknown template", input => { input.metrics[0].source.template = `project.${SENTINEL}`; }, "metrics[0].source.template", /expected one of/u],
    ["unknown source kind", input => { input.metrics[2].source.kind = "streamed"; }, "metrics[2].source.kind", /derived, recorded, live/u],
    ["unknown template parameter", input => { input.metrics[0].source.parameters.priority = SENTINEL; }, "metrics[0].source.parameters", /expected exactly project, stateGroup/u],
    ["missing template parameter", input => { delete input.metrics[0].source.parameters.stateGroup; }, "metrics[0].source.parameters", /expected exactly/u],
    ["unknown state group", input => { input.metrics[0].source.parameters.stateGroup = SENTINEL; }, "metrics[0].source.parameters.stateGroup", /backlog/u],
    ["same from and to", input => { input.metrics[4].source.parameters.to = "unstarted"; }, "metrics[4].source.parameters.to", /different/u],
    ["project not in intake", input => { input.metrics[0].source.parameters.project = "ZZZ"; }, "metrics[0].source.parameters.project", /intake's inferops\.projects/u],
    ["injected project", input => { input.metrics[0].source.parameters.project = `OPS'; DROP TABLE x;--${SENTINEL}`; }, "metrics[0].source.parameters.project", /project key/u],
    ["template and kind disagree", input => { input.metrics[0].kind = "gauge"; }, "metrics[0].kind", /expected counter, the kind of template project\.entered_state/u],
    ["producer slug", input => { input.metrics[2].source.producer = `Acme ${SENTINEL}`; }, "metrics[2].source.producer", /producer slug/u],
    ["recorded with a template", input => { input.metrics[2].source.template = "project.entered_state"; }, "metrics[2].source", /expected exactly kind, producer/u],
    ["too many dimensions", input => { input.metrics[2].dimensions = ["a", "b", "c", "d", "e"].map(name => ({ name, values: ["x"] })); }, "metrics[2].dimensions", /0 to 4/u],
    ["too many values", input => { input.metrics[2].dimensions[0].values = Array.from({ length: 33 }, (_, i) => `v${i}`); }, "metrics[2].dimensions[0].values", /1 to 32/u],
    ["duplicate value", input => { input.metrics[2].dimensions[0].values = ["north", "north"]; }, "metrics[2].dimensions[0].values", /duplicate/u],
    ["free-text value", input => { input.metrics[2].dimensions[0].values = [`North ${SENTINEL}`]; }, "metrics[2].dimensions[0].values[0]", /value slug/u],
    ["duplicate dimension", input => { input.metrics[2].dimensions = [{ name: "region", values: ["a"] }, { name: "region", values: ["b"] }]; }, "metrics[2].dimensions", /duplicate/u],
    ["cardinality cap", input => { input.metrics[2].dimensions = [{ name: "crew", cardinalityCap: 0 }]; }, "metrics[2].dimensions[0].cardinalityCap", /1 to 32/u],
    ["unknown operation", input => { input.metrics[0].attribution.operation = SENTINEL; }, "metrics[0].attribution.operation", /operation id listed in the intake/u],
    ["unknown accountable role", input => { input.metrics[0].attribution.accountable = SENTINEL; }, "metrics[0].attribution.accountable", /owns an operation in the intake/u],
    ["missing attribution", input => { delete input.metrics[0].attribution; }, "metrics[0]", /expected exactly/u],
  ];
  for (const [label, mutate, field, rule] of cases) {
    const error = refused(mutate);
    assert.equal(error.field, field, label);
    assert.match(error.rule, rule, label);
  }
});

test("code and SQL are refused wherever they appear", () => {
  const cases: [(input: Record<string, any>) => void, string][] = [
    [input => { input.query = `SELECT * FROM metric_points -- ${SENTINEL}`; }, "declarations.query"],
    [input => { input.metrics[0].sql = `SELECT 1 ${SENTINEL}`; }, "declarations.metrics[0].sql"],
    [input => { input.metrics[0].source.parameters.expression = `count(*) ${SENTINEL}`; }, "declarations.metrics[0].source.parameters.expression"],
    [input => { input.metrics[2].source.Deriver = `() => ${SENTINEL}`; }, "declarations.metrics[2].source.deriver"],
    [input => { input.metrics[2].dimensions[0].FORMULA = SENTINEL; }, "declarations.metrics[2].dimensions[0].formula"],
    [input => { input.metrics[0].source = { kind: "derived", code: SENTINEL }; }, "declarations.metrics[0].source.code"],
  ];
  for (const [mutate, field] of cases) {
    const error = refused(mutate);
    assert.equal(error.field, field);
    assert.match(error.rule, /code or SQL is not accepted/u);
  }
});

test("the module itself imports no network, process or provider client", () => {
  const imports = [...readFileSync(module, "utf8").matchAll(/^import .* from "([^"]+)";$/gmu)].map(match => match[1]);
  assert.deepEqual(imports, ["node:crypto", "node:fs", "node:url", "./intake.ts"]);
});

test("the CLI exits 0 valid, 1 invalid, 2 usage, and runs with no write or child-process permission", () => {
  const ok = cli([fixturePath, "--intake", intakePath, "--json"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).declarationsDigest, ACME_DIGEST);
  // Under Node's permission model with read access only: a write or a spawn would throw ERR_ACCESS_DENIED.
  const confined = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${repo}`, module, fixturePath, "--intake", intakePath, "--json"], { cwd: repo, encoding: "utf8" });
  assert.equal(confined.status, 0, confined.stderr);
  assert.equal(confined.stdout, ok.stdout);
  assert.equal(cli([fixturePath]).status, 2);
  assert.equal(cli([]).status, 2);
  const dir = mkdtempSync(join(tmpdir(), "metric-declarations-"));
  try {
    const broken = join(dir, "broken.json");
    writeFileSync(broken, `{"schemaVersion": 1, "metrics": [${SENTINEL}`);
    const bad = cli([broken, "--intake", intakePath]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not valid JSON/u);
    assert.ok(!bad.stderr.includes(SENTINEL));
    const sql = join(dir, "sql.json");
    writeFileSync(sql, JSON.stringify({ ...fixture(), sql: `DROP TABLE ${SENTINEL}` }));
    const refusedJson = cli([sql, "--intake", intakePath, "--json"]);
    assert.equal(refusedJson.status, 1);
    assert.deepEqual(JSON.parse(refusedJson.stdout), { status: "NOT REGISTERED", ok: false, problem: { field: "declarations.sql", rule: "code or SQL is not accepted; name a declared template or a recorded producer" } });
    assert.equal(cli([fixturePath, "--intake", join(dir, "missing.json")]).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
