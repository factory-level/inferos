import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPABILITY_NAMES, LEGACY_FLAG_COMPATIBILITY, initialConsumerConfig, migrateConsumerConfig, parseConsumerConfig, resolveConsumerConfig } from "./config.ts";

const candidate = () => ({
  ...initialConsumerConfig("https://github.com/factory-level/inferos", "a".repeat(40)),
  features: {}, styling: {},
});

test("operations inherits supported view defaults, curated styling and per-field provenance", () => {
  const { config, provenance } = resolveConsumerConfig(candidate());
  assert.deepEqual(config.features, { composableViews: true, durableViews: true, customCloudflareCode: false });
  assert.deepEqual(config.styling, { siteName: "InferOS", density: "compact", theme: "system" });
  assert.deepEqual(provenance, {
    features: { composableViews: "profile", durableViews: "profile", customCloudflareCode: "default" },
    styling: { siteName: "default", density: "profile", theme: "default" },
  });
});

test("personal retains baseline defaults and explicit false overrides operations", () => {
  const personal = resolveConsumerConfig({ ...candidate(), profile: "personal" });
  assert.deepEqual(personal.config.features, { composableViews: false, durableViews: false, customCloudflareCode: false });
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
  assert.deepEqual(resolved.config, before);
  assert.equal(resolved.provenance.features.composableViews, "override");
  resolved.config.features.composableViews = true;
  assert.deepEqual(legacy, before);
  const initial = initialConsumerConfig(legacy.upstream.repository, legacy.upstream.revision);
  assert.deepEqual(parseConsumerConfig(initial), initial);
  assert.equal(resolveConsumerConfig(initial).provenance.features.composableViews, "override");
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

test("version 2 accepts the eight capability names, defaulting each to off with provenance", () => {
  assert.equal(CAPABILITY_NAMES.length, 8);
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
  for (const name of ["AGENT_DEPLOYMENTS", "CODING_WORKBENCH_ENABLED", "HARNESS_HG_ENABLED"]) parseConsumerConfig(v2({ [name]: true }));
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
  assert.deepEqual(Object.keys(LEGACY_FLAG_COMPATIBILITY), ["composableViews", "durableViews", "customCloudflareCode"]);
  for (const entry of Object.values(LEGACY_FLAG_COMPATIBILITY)) assert.deepEqual(entry, { retained: true, capability: null });
  assert.throws(() => migrateConsumerConfig({ ...explicit, token: "secret" }), /expected exactly/);
});
