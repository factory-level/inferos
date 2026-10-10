import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPABILITY_NAMES, LEGACY_FLAG_COMPATIBILITY, codingRepoIds, inferOpsAuthRequested, initialConsumerConfig, migrateConsumerConfig, parseConsumerConfig, resolveConsumerConfig } from "./config.ts";

const candidate = () => ({
  ...initialConsumerConfig("https://github.com/factory-level/inferos", "a".repeat(40)),
  features: {}, styling: {},
});

test("operations inherits supported view defaults, curated styling and per-field provenance", () => {
  const { config, provenance } = resolveConsumerConfig(candidate());
  assert.deepEqual(config.features, { composableViews: true, durableViews: true, customCloudflareCode: false, inferlabLogin: false });
  assert.deepEqual(config.styling, { siteName: "InferOS", density: "compact", theme: "system" });
  assert.deepEqual(provenance, {
    features: { composableViews: "profile", durableViews: "profile", customCloudflareCode: "default", inferlabLogin: "default" },
    styling: { siteName: "default", density: "profile", theme: "default" },
  });
});

test("personal retains baseline defaults and explicit false overrides operations", () => {
  const personal = resolveConsumerConfig({ ...candidate(), profile: "personal" });
  assert.deepEqual(personal.config.features, { composableViews: false, durableViews: false, customCloudflareCode: false, inferlabLogin: false });
  assert.equal(personal.config.styling.siteName, "InferOS");
  assert.equal(personal.provenance.styling.density, "default");
  const operations = resolveConsumerConfig({ ...candidate(), features: { durableViews: false }, styling: { density: "comfortable", theme: "dark" } });
  assert.equal(operations.config.features.durableViews, false);
  assert.equal(operations.config.features.composableViews, true);
  assert.equal(operations.provenance.features.durableViews, "override");
  assert.equal(operations.config.styling.density, "comfortable");
  assert.equal(operations.provenance.styling.theme, "override");
});

test("dependencies and invalid overrides fail after resolution without silent correction", () => {
  assert.throws(() => parseConsumerConfig({ ...candidate(), features: { composableViews: false } }), /requires/);
  for (const features of [{ durableViews: null }, { durableViews: "false" }, { durableViews: undefined }, { custom: true }]) {
    assert.throws(() => parseConsumerConfig({ ...candidate(), features }));
  }
  for (const styling of [{ theme: null }, { siteName: "" }, { density: "tiny" }, { css: "*{}" }]) {
    assert.throws(() => parseConsumerConfig({ ...candidate(), styling }));
  }
  assert.throws(() => parseConsumerConfig({ ...candidate(), features: null }));
  assert.throws(() => parseConsumerConfig({ ...candidate(), profile: "industrial" }));
});

test("fully explicit legacy wrappers keep their behavior and resolution does not mutate input", () => {
  const legacy = { ...candidate(), features: { composableViews: false, durableViews: false, customCloudflareCode: false },
    styling: { siteName: "Existing", density: "comfortable", theme: "system" } };
  const before = structuredClone(legacy);
  const resolved = resolveConsumerConfig(legacy);
  // A flag added after the wrapper was written resolves to its default, which is off.
  assert.deepEqual(resolved.config, { ...before, features: { ...before.features, inferlabLogin: false } });
  assert.equal(resolved.provenance.features.composableViews, "override");
  resolved.config.features.composableViews = true;
  assert.deepEqual(legacy, before);
  const initial = initialConsumerConfig(legacy.upstream.repository, legacy.upstream.revision);
  assert.deepEqual(parseConsumerConfig(initial), initial);
  assert.equal(resolveConsumerConfig(initial).provenance.features.composableViews, "override");
});

test("InferLab login is an explicit opt-in that no profile turns on", () => {
  for (const profile of ["personal", "inferops-operations"]) {
    const resolved = resolveConsumerConfig({ ...candidate(), profile });
    assert.equal(resolved.config.features.inferlabLogin, false);
    assert.equal(resolved.provenance.features.inferlabLogin, "default");
  }
  const enabled = resolveConsumerConfig({ ...candidate(), features: { inferlabLogin: true } });
  assert.equal(enabled.config.features.inferlabLogin, true);
  assert.equal(enabled.provenance.features.inferlabLogin, "override");
  assert.equal(initialConsumerConfig("https://github.com/factory-level/inferos", "a".repeat(40)).features.inferlabLogin, false);
  for (const inferlabLogin of [null, "true", 1]) {
    assert.throws(() => parseConsumerConfig({ ...candidate(), features: { inferlabLogin } }), /features.inferlabLogin/);
  }
});

const allOff = Object.fromEntries(CAPABILITY_NAMES.map(name => [name, false]));
const v2 = (capabilities: Record<string, unknown> = {}) => ({ ...candidate(), schemaVersion: 2, capabilities });

test("version 1 resolves without capabilities and rejects the version 2 section", () => {
  const { config, provenance } = resolveConsumerConfig(candidate());
  assert.equal(config.schemaVersion, 1);
  assert.equal(Object.hasOwn(config, "capabilities"), false);
  assert.equal(Object.hasOwn(provenance, "capabilities"), false);
  assert.throws(() => parseConsumerConfig({ ...candidate(), capabilities: {} }), /capabilities: requires schemaVersion 2/);
  for (const schemaVersion of [0, 3, "2", null, undefined]) {
    assert.throws(() => parseConsumerConfig({ ...candidate(), schemaVersion }), /only versions 1 and 2/);
  }
  assert.throws(() => parseConsumerConfig(null), /schemaVersion/);
});

test("version 2 accepts the eleven capability names, defaulting each to off with provenance", () => {
  assert.equal(CAPABILITY_NAMES.length, 11);
  const inherited = resolveConsumerConfig(v2());
  assert.equal(inherited.config.schemaVersion, 2);
  assert.deepEqual(inherited.config.schemaVersion === 2 && inherited.config.capabilities, allOff);
  assert.deepEqual(inherited.provenance.capabilities, Object.fromEntries(CAPABILITY_NAMES.map(name => [name, "default"])));
  for (const profile of ["personal", "inferops-operations"]) {
    const resolved = parseConsumerConfig({ ...v2(), profile });
    assert.deepEqual(resolved.schemaVersion === 2 && resolved.capabilities, allOff);
  }
  const all = resolveConsumerConfig(v2(Object.fromEntries(CAPABILITY_NAMES.map(name => [name, true]))));
  assert.deepEqual(all.config.schemaVersion === 2 && Object.values(all.config.capabilities), CAPABILITY_NAMES.map(() => true));
  assert.equal(all.provenance.capabilities?.AGENT_DEPLOYMENTS, "override");
  // Capabilities and legacy flags resolve independently: neither turns the other on.
  assert.deepEqual(all.config.features, resolveConsumerConfig(candidate()).config.features);
  const durable = parseConsumerConfig({ ...v2(), features: { composableViews: true, durableViews: true, customCloudflareCode: true } });
  assert.deepEqual(durable.schemaVersion === 2 && durable.capabilities, allOff);
});

test("version 2 rejects unknown keys, wrong types and unmet dependencies without echoing values", () => {
  assert.throws(() => parseConsumerConfig({ ...candidate(), schemaVersion: 2 }), /config: expected exactly/);
  for (const capabilities of [null, [], "INFEROPS_ENABLED", { INFEROPS: true }, { inferops_enabled: true }, { composableViews: true }]) {
    assert.throws(() => parseConsumerConfig(v2(capabilities as Record<string, unknown>)), /^Error: capabilities: expected/);
  }
  for (const value of ["true", 1, null, undefined, "sk-secret-value"]) {
    assert.throws(() => parseConsumerConfig(v2({ INFEROPS_AUTH: value })), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "capabilities.INFEROPS_AUTH: expected boolean");
      return true;
    });
  }
  assert.throws(() => parseConsumerConfig(v2({ "sk-secret-key": true })), error => error instanceof Error && !error.message.includes("secret"));
  // A dependency is validated, never switched on for the customer.
  assert.throws(() => parseConsumerConfig(v2({ INFEROPS_CANVAS_STATE_MACHINE: true })), /^Error: INFEROPS_CANVAS_STATE_MACHINE requires INFEROPS_ENABLED$/);
  assert.throws(() => parseConsumerConfig(v2({ INFEROPS_CANVAS_STATE_MACHINE: true, INFEROPS_ENABLED: false })), /requires INFEROPS_ENABLED/);
  const flow = parseConsumerConfig(v2({ INFEROPS_CANVAS_STATE_MACHINE: true, INFEROPS_ENABLED: true }));
  assert.equal(flow.schemaVersion === 2 && flow.capabilities.INFEROPS_CANVAS_STATE_MACHINE, true);
  // Independent capabilities need neither HG nor the InferOps integration.
  for (const name of ["AGENT_DEPLOYMENTS", "HARNESS_HG_ENABLED"]) parseConsumerConfig(v2({ [name]: true }));
  // Coding dispatch goes through the InferOps gatekeeper, so it needs the integration, not HG.
  assert.throws(() => parseConsumerConfig(v2({ CODING_WORKBENCH_ENABLED: true })), /^Error: CODING_WORKBENCH_ENABLED requires INFEROPS_ENABLED$/);
  parseConsumerConfig(v2({ CODING_WORKBENCH_ENABLED: true, INFEROPS_ENABLED: true, HARNESS_HG_ENABLED: false }));
  // Legacy dependency rules still apply in version 2.
  assert.throws(() => parseConsumerConfig({ ...v2(), features: { composableViews: false } }), /durableViews requires composableViews/);
});

test("migration keeps two different wrappers' settings and behaviour and maps no legacy flag to a capability", () => {
  // Fixture A: a fully explicit operations wrapper as bootstrap writes it, with custom code on.
  const explicit = { ...initialConsumerConfig("https://github.com/factory-level/inferos", "a".repeat(40)),
    features: { composableViews: true, durableViews: true, customCloudflareCode: true },
    styling: { siteName: "Acme Operations", density: "compact", theme: "dark" }, local: { port: 9123 } };
  // Fixture B: a personal wrapper on a local path and a remote endpoint that inherits most settings.
  const inheriting = { schemaVersion: 1, upstream: { repository: "/srv/git/inferos", revision: "b".repeat(40) }, profile: "personal",
    features: { composableViews: true }, styling: { theme: "light" }, local: { port: 8788 },
    inferops: { mode: "remote", baseUrl: "https://inferops.example.com", targetRef: "inferops://acme.prod/project/board/OPS" } };
  for (const fixture of [explicit, inheriting]) {
    const before = structuredClone(fixture);
    const migrated = migrateConsumerConfig(fixture);
    assert.deepEqual(fixture, before);
    const { schemaVersion, capabilities, ...kept } = migrated;
    const { schemaVersion: previous, ...written } = before;
    assert.equal(previous, 1);
    assert.equal(schemaVersion, 2);
    assert.deepEqual(kept, written);
    assert.deepEqual(capabilities, allOff);
    const from = resolveConsumerConfig(fixture);
    const to = resolveConsumerConfig(migrated);
    assert.ok(to.config.schemaVersion === 2);
    const { schemaVersion: _from, ...fromSettings } = from.config;
    const { schemaVersion: _to, capabilities: resolvedCapabilities, ...toSettings } = to.config;
    assert.deepEqual(toSettings, fromSettings);
    assert.deepEqual(resolvedCapabilities, allOff);
    assert.deepEqual(to.provenance.features, from.provenance.features);
    assert.deepEqual(to.provenance.styling, from.provenance.styling);
    assert.throws(() => migrateConsumerConfig(migrated), /migration expects version 1/);
  }
  assert.equal(resolveConsumerConfig(migrateConsumerConfig(inheriting)).provenance.features.durableViews, "default");
  assert.deepEqual(Object.keys(LEGACY_FLAG_COMPATIBILITY), ["composableViews", "durableViews", "customCloudflareCode", "inferlabLogin"]);
  for (const flag of ["composableViews", "durableViews", "customCloudflareCode"] as const) {
    assert.deepEqual(LEGACY_FLAG_COMPATIBILITY[flag], { retained: true, capability: null });
  }
  assert.throws(() => migrateConsumerConfig({ ...explicit, token: "secret" }), /expected exactly/);
});

test("INFEROPS_AUTH and features.inferlabLogin are one switch for InferOps-backed sign-in", () => {
  assert.deepEqual(LEGACY_FLAG_COMPATIBILITY.inferlabLogin, { retained: true, capability: "INFEROPS_AUTH" });
  assert.equal(inferOpsAuthRequested(parseConsumerConfig(candidate())), false);
  assert.equal(inferOpsAuthRequested(parseConsumerConfig(v2())), false);
  assert.equal(inferOpsAuthRequested(parseConsumerConfig({ ...candidate(), features: { inferlabLogin: true } })), true);
  assert.equal(inferOpsAuthRequested(parseConsumerConfig(v2({ INFEROPS_AUTH: true }))), true);
  assert.equal(inferOpsAuthRequested(parseConsumerConfig({ ...v2(), features: { inferlabLogin: true } })), true);
  // The migration keeps a version 1 wrapper's sign-in as written: the flag stays on, the capability stays off.
  const migrated = parseConsumerConfig(migrateConsumerConfig({ ...candidate(), features: { inferlabLogin: true } }));
  assert.equal(migrated.schemaVersion === 2 && migrated.capabilities.INFEROPS_AUTH, false);
  assert.equal(inferOpsAuthRequested(migrated), true);
});

test("INFEROPS_ENABLED is explicit: migration carries the gatekeeper selection over, and sign-in does not need it", () => {
  // A version 1 wrapper selects the gatekeeper through inferos.canvas.json, which the caller reads.
  const selected = parseConsumerConfig(migrateConsumerConfig(candidate(), { inferOpsGatekeeperSelected: true }));
  assert.equal(selected.schemaVersion === 2 && selected.capabilities.INFEROPS_ENABLED, true);
  for (const context of [undefined, {}, { inferOpsGatekeeperSelected: false }]) {
    const off = parseConsumerConfig(migrateConsumerConfig(candidate(), context));
    assert.ok(off.schemaVersion === 2);
    assert.deepEqual(CAPABILITY_NAMES.filter(name => off.capabilities[name]), []);
  }
  // No profile or other flag turns it on, and sign-in is an identity mode that stands alone.
  for (const profile of ["personal", "inferops-operations"] as const) {
    const { config, provenance } = resolveConsumerConfig({ ...v2(), profile });
    assert.equal(config.schemaVersion === 2 && config.capabilities.INFEROPS_ENABLED, false);
    assert.equal(provenance.capabilities?.INFEROPS_ENABLED, "default");
  }
  const signInOnly = parseConsumerConfig(v2({ INFEROPS_AUTH: true }));
  assert.equal(signInOnly.schemaVersion === 2 && signInOnly.capabilities.INFEROPS_ENABLED, false);
  const enabled = resolveConsumerConfig(v2({ INFEROPS_ENABLED: true }));
  assert.equal(enabled.provenance.capabilities?.INFEROPS_ENABLED, "override");
  assert.equal(inferOpsAuthRequested(enabled.config), false);
});

const REPO_A = "4a000000-0000-4000-8000-00000000000a";
const REPO_B = "40000000-0000-4000-8000-000000000002";
const workbench = (repos: unknown) => ({ ...v2({ INFEROPS_ENABLED: true, CODING_WORKBENCH_ENABLED: true }), codingWorkbench: { repos } });

test("codingWorkbench is a version 2 allowlist whose ids alone reach the gatekeeper", () => {
  const config = parseConsumerConfig(workbench([
    { repoId: REPO_A, path: "/home/dev/acme/web", testCommands: ["pnpm test"], baseRef: "main" },
    { repoId: REPO_B, path: "C:\\work\\api", testCommands: ["pnpm lint", "pnpm test"] },
  ]));
  assert.equal(config.schemaVersion === 2 && config.codingWorkbench?.repos.length, 2);
  assert.equal(codingRepoIds(config), `${REPO_A},${REPO_B}`);
  // Omitted, nothing is allowed; version 1 never allows anything and cannot declare it.
  assert.equal(codingRepoIds(parseConsumerConfig(v2())), "");
  assert.equal(codingRepoIds(parseConsumerConfig(candidate())), "");
  assert.throws(() => parseConsumerConfig({ ...candidate(), codingWorkbench: { repos: [] } }), /codingWorkbench: requires schemaVersion 2/);
  // An empty allowlist is valid: coding can be on with nothing to dispatch yet.
  assert.equal(codingRepoIds(parseConsumerConfig(workbench([]))), "");
});

test("codingWorkbench rejects malformed entries without echoing their values", () => {
  const entry = { repoId: REPO_A, path: "/srv/repo", testCommands: ["pnpm test"] };
  for (const [repos, message] of [
    ["nope", /codingWorkbench.repos: expected an array/],
    [[{ ...entry, repoId: "sk-secret-not-a-uuid" }], /repos\[0\].repoId: expected lowercase UUID/],
    [[{ ...entry, repoId: REPO_A.toUpperCase() }], /expected lowercase UUID/],
    [[entry, { ...entry }], /repos\[1\].repoId: listed twice/],
    [[{ ...entry, path: "relative/secret-dir" }], /path: expected absolute local path/],
    [[{ ...entry, testCommands: [] }], /testCommands: expected 1 to 20 commands/],
    [[{ ...entry, testCommands: ["pnpm test\nrm -rf /"] }], /testCommands\[0\]: expected one line/],
    [[{ ...entry, baseRef: "--upload-pack=secret" }], /baseRef: expected git ref name/],
    [[{ ...entry, baseRef: "a..b" }], /baseRef: expected git ref name/],
    [[{ repoId: REPO_A, testCommands: ["x"] }], /path: required/],
    [[{ ...entry, token: "sk-secret" }], /expected exactly/],
  ] as const) {
    assert.throws(() => parseConsumerConfig(workbench(repos)), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, message);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
  }
  assert.throws(() => parseConsumerConfig({ ...workbench([]), codingWorkbench: { repos: [], extra: 1 } }), /codingWorkbench: expected exactly repos/);
});

test("gatekeepers lists wrapper gatekeepers by slug in either version, omitted meaning none", () => {
  assert.equal(parseConsumerConfig(candidate()).gatekeepers, undefined);
  const listed = [{ slug: "tickets", enabled: true }, { slug: "acme-crm", enabled: false }];
  assert.deepEqual(parseConsumerConfig({ ...candidate(), gatekeepers: listed }).gatekeepers, listed);
  const migrated = migrateConsumerConfig({ ...candidate(), gatekeepers: listed });
  assert.deepEqual(parseConsumerConfig(migrated).gatekeepers, listed, "migration keeps the listing");
  for (const [gatekeepers, message] of [
    [{}, /expected an array/],
    [[{ slug: "Tickets", enabled: true }], /lowercase slug/],
    [[{ slug: "gatekeeper-tickets", enabled: true }, { slug: "gatekeeper-tickets", enabled: true }], /listed twice/],
    [[{ slug: "tickets", enabled: "yes" }], /enabled: expected boolean/],
    [[{ slug: "tickets" }], /expected exactly slug, enabled/],
    [Array.from({ length: 33 }, (_, n) => ({ slug: `g${n}`, enabled: true })), /at most 32/],
  ] as const) {
    assert.throws(() => parseConsumerConfig({ ...candidate(), gatekeepers }), message);
  }
});
