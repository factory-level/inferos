import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ConsumerConfig } from "./config.ts";
import { deployArgs } from "./runtime.ts";

const config = (customCloudflareCode = false) =>
  ({ features: { composableViews: true, durableViews: true, customCloudflareCode, inferlabLogin: true } }) as unknown as ConsumerConfig;

test("wrapper deploys relay to the pinned stage deploy, refusing what they can't deploy faithfully", () => {
  const upstream = mkdtempSync(join(tmpdir(), "deploy-args-"));
  try {
    const consumer = { config: config(), blocked: [], modifiedUpstream: false };
    assert.throws(() => deployArgs("/w", upstream, [], consumer), /cannot deploy a wrapper/);
    mkdirSync(join(upstream, "scripts/stage"), { recursive: true });
    writeFileSync(join(upstream, "scripts/stage/wrapper-stage.ts"), "");
    const script = join(upstream, "scripts/stage/stage.ts");

    // `deploy` by default; the wrapper root always goes to the pinned script.
    assert.deepEqual(deployArgs("/w", upstream, ["--dry-run"], consumer), [script, "deploy", "--wrapper", "/w", "--dry-run"]);
    assert.deepEqual(deployArgs("/w", upstream, ["config"], consumer), [script, "config", "--wrapper", "/w"]);
    assert.deepEqual(deployArgs("/w", upstream, ["delete", "--confirm", "os.acme.example"], consumer),
      [script, "delete", "--wrapper", "/w", "--confirm", "os.acme.example"]);
    assert.throws(() => deployArgs("/w", upstream, ["publish"], consumer), /Usage: pnpm inferos:deploy/);

    assert.throws(() => deployArgs("/w", upstream, [], { ...consumer, blocked: ["HARNESS_HG_ENABLED"] }), /not supported/);
    assert.throws(() => deployArgs("/w", upstream, ["--dry-run"], { ...consumer, config: config(true) }), /customCloudflareCode/);
    // A modified pinned checkout can be rehearsed, never deployed.
    assert.throws(() => deployArgs("/w", upstream, [], { ...consumer, modifiedUpstream: true }), /exact pinned revision/);
    assert.deepEqual(deployArgs("/w", upstream, ["--dry-run"], { ...consumer, modifiedUpstream: true }),
      [script, "deploy", "--wrapper", "/w", "--dry-run"]);
  } finally {
    rmSync(upstream, { recursive: true, force: true });
  }
});
