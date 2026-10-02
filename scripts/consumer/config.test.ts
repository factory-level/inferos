import assert from "node:assert/strict";
import { test } from "node:test";
import { initialConsumerConfig, parseConsumerConfig, resolveConsumerConfig } from "./config.ts";

const candidate = () => ({
  ...initialConsumerConfig("https://github.com/factory-level/inferos", "a".repeat(40)),
  features: {}, styling: {},
});

test("operations inherits supported view defaults, curated styling and per-field provenance", () => {
  const { config, provenance } = resolveConsumerConfig(candidate());
  assert.deepEqual(config.features, { composableViews: true, durableViews: true, customCloudflareCode: false });
  assert.deepEqual(config.styling, { siteName: "InferOps Workspace", density: "compact", theme: "system" });
  assert.deepEqual(provenance, {
    features: { composableViews: "profile", durableViews: "profile", customCloudflareCode: "default" },
    styling: { siteName: "profile", density: "profile", theme: "default" },
  });
});

test("personal retains baseline defaults and explicit false overrides operations", () => {
  const personal = resolveConsumerConfig({ ...candidate(), profile: "personal" });
  assert.deepEqual(personal.config.features, { composableViews: false, durableViews: false, customCloudflareCode: false });
  assert.equal(personal.config.styling.siteName, "My Workspace");
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
