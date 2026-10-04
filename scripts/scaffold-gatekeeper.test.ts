import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { validateConnection } from "./connection-package.ts";
import { initialConsumerConfig } from "./consumer/config.ts";
import { readConsumerGatekeepers } from "./consumer/gatekeepers.ts";
import { scaffoldGatekeeper } from "./scaffold-gatekeeper.ts";

const UPSTREAM = resolve(import.meta.dirname, "..");

function temp(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function files(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path, join(prefix, name)) : [join(prefix, name)];
  }).toSorted();
}

test("scaffolds a fork connection package that validates and says it is only a scaffold", async t => {
  const root = temp(t, "inferos-scaffold-");
  const result = await scaffoldGatekeeper("acme", { root, generateConfig: false });
  const dir = join(root, "custom-gatekeepers/gatekeeper-acme");
  assert.deepEqual({ ...result, directory: result.directory }, {
    name: "gatekeeper-acme", directory: dir, status: "scaffold",
    next: ["pnpm install", "pnpm types:generate", "pnpm --filter @inferos/gatekeeper-acme test:run",
      "pnpm canvas gatekeeper enable gatekeeper-acme"],
  });
  assert.deepEqual(files(dir), [
    "README.md", "__tests__/conformance-adapter.ts", "__tests__/conformance.test.ts", "__tests__/env.d.ts",
    "__tests__/worker.ts", "cloudflare.config.ts", "connection.json", "package.json", "src/acme.ts",
    "src/client.ts", "src/env.d.ts", "src/fake-provider.ts", "src/text-modules.d.ts", "src/types.d.ts",
    "src/types.txt", "tsconfig.json", "vite.config.ts", "vitest.config.ts",
  ]);
  assert.equal(readlinkSync(join(dir, "src/types.txt")), "types.d.ts");
  for (const file of files(dir)) {
    assert.doesNotMatch(readFileSync(join(dir, file), "utf8"), /__(?!tests__)[A-Za-z_]+__/, `${file} kept a template token`);
  }

  const contract = JSON.parse(readFileSync(join(dir, "connection.json"), "utf8"));
  assert.equal(validateConnection(contract).state, "valid");
  assert.equal(contract.status, "scaffold");
  assert.equal(contract.package, JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name);
  assert.equal(contract.compatibility.provider.revision, null);
  const source = readFileSync(join(dir, "src/acme.ts"), "utf8");
  assert.ok(source.includes(`"${contract.resources[0].urlPattern}"`));
  for (const cls of ["GatekeeperVendor", "AcmeAccount", "AcmeVerifier", "AcmeCollectionGatekeeper"]) {
    assert.match(source, new RegExp(`class ${cls}\\b`));
  }
  assert.match(readFileSync(join(dir, "src/client.ts"), "utf8"), /^\/\/ SCAFFOLD: .*not a trusted proxy/s);
  assert.match(readFileSync(join(dir, "cloudflare.config.ts"), "utf8"), /from "@gadgets\/scripts\/worker-config"/);
  assert.match(readFileSync(join(dir, "README.md"), "utf8"), /\*\*Status: scaffold\.\*\*/);
});

test("never overwrites, and refuses bad slugs and names the checkout already uses", async t => {
  const root = temp(t, "inferos-scaffold-");
  await scaffoldGatekeeper("acme", { root, generateConfig: false });
  writeFileSync(join(root, "custom-gatekeepers/gatekeeper-acme/README.md"), "edited\n");
  await assert.rejects(scaffoldGatekeeper("acme", { root, generateConfig: false }), /already exists/);
  assert.equal(readFileSync(join(root, "custom-gatekeepers/gatekeeper-acme/README.md"), "utf8"), "edited\n");
  // An empty directory is still a directory someone made.
  mkdirSync(join(root, "custom-gatekeepers/gatekeeper-beta"));
  await assert.rejects(scaffoldGatekeeper("beta", { root, generateConfig: false }), /already exists/);
  for (const slug of ["Acme", "acme-crm", "a", "1acme", "acme_crm", ""]) {
    await assert.rejects(scaffoldGatekeeper(slug, { root, generateConfig: false }), /slug must be/, slug);
  }
  // Checked against the real checkout: refused before anything is written.
  await assert.rejects(scaffoldGatekeeper("inferops", { root: UPSTREAM, generateConfig: false }), /already exists/);
  assert.deepEqual(readdirSync(join(root, "custom-gatekeepers")).toSorted(), ["gatekeeper-acme", "gatekeeper-beta"]);
});

test("scaffolds into a wrapper's gatekeepers/, unbound until the wrapper lists it", async t => {
  const wrapper = temp(t, "inferos-scaffold-wrapper-");
  await assert.rejects(scaffoldGatekeeper("acme", { consumerRoot: wrapper }), /inferos.config.json/);
  const config = initialConsumerConfig("https://github.com/factory-level/inferos", "a".repeat(40));
  config.features.customCloudflareCode = true;
  writeFileSync(join(wrapper, "inferos.config.json"), JSON.stringify(config));

  const result = await scaffoldGatekeeper("acme", { consumerRoot: wrapper });
  const dir = join(wrapper, "gatekeepers/gatekeeper-acme");
  assert.equal(result.directory, dir);
  assert.match(result.next[0]!, /Add \{ "slug": "acme", "enabled": true \} to "gatekeepers"/);
  assert.ok(!existsSync(join(dir, "wrangler.jsonc")), "a wrapper scaffold executes nothing");
  assert.match(readFileSync(join(dir, "cloudflare.config.ts"), "utf8"), /from "\.\.\/\.\.\/inferos\/scripts\/worker-config\.ts"/);
  assert.equal(JSON.parse(readFileSync(join(dir, "connection.json"), "utf8")).$schema,
    "../../inferos/scripts/connection-package.schema.json");

  let manifest = readConsumerGatekeepers(wrapper, UPSTREAM);
  assert.deepEqual(manifest.accepted, []);
  assert.deepEqual(manifest.refused.map(({ name, severity }) => ({ name, severity })), [{ name: "gatekeeper-acme", severity: "notice" }]);

  config.gatekeepers = [{ slug: "acme", enabled: true }];
  writeFileSync(join(wrapper, "inferos.config.json"), JSON.stringify(config));
  manifest = readConsumerGatekeepers(wrapper, UPSTREAM);
  assert.deepEqual(manifest.accepted, [{ directory: dir, status: "scaffold" }]);
  assert.deepEqual(manifest.refused, []);
});
