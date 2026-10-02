import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { initialConsumerConfig } from "./config.ts";
import { prepareConsumerWorkers, readConsumerWorkers } from "./extensions.ts";

const factory = new URL("../worker-config.ts", import.meta.url).href;
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "inferos-extensions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = initialConsumerConfig("https://github.com/factory-level/inferos", "a".repeat(40));
  config.features.customCloudflareCode = true;
  writeFileSync(join(root, "inferos.config.json"), JSON.stringify(config));
  const dir = join(root, "workers/hello");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "src.ts"), "export default { fetch() { return new Response('hello'); } };\n");
  writeFileSync(join(dir, "cloudflare.config.ts"), `import { defineGadgetsWorker } from ${JSON.stringify(factory)};\nexport default defineGadgetsWorker({ name: 'consumer-hello', entrypoint: 'src.ts' });\n`);
  const manifest = { schemaVersion: 1, workers: [{ id: "hello", directory: "workers/hello" }] };
  const save = () => writeFileSync(join(root, "inferos.extensions.json"), JSON.stringify(manifest));
  save();
  return { root, dir, config, manifest, save };
}

test("disabled custom code does not read its manifest or import executable config", async t => {
  const f = fixture(t);
  f.config.features.customCloudflareCode = false;
  writeFileSync(join(f.root, "inferos.config.json"), JSON.stringify(f.config));
  writeFileSync(join(f.root, "inferos.extensions.json"), "invalid json");
  writeFileSync(join(f.dir, "cloudflare.config.ts"), "throw new Error('must not execute');");
  assert.deepEqual(await prepareConsumerWorkers(f.root), []);
});

test("canonical custom config generates an isolated Worker with its full source path", async t => {
  const f = fixture(t);
  assert.deepEqual(readConsumerWorkers(f.root).map(({ id, name, binding }) => ({ id, name, binding })), [
    { id: "hello", name: "consumer-hello", binding: "CONSUMER_HELLO" },
  ]);
  const [worker] = await prepareConsumerWorkers(f.root);
  const config = parse(readFileSync(worker.configPath, "utf8"));
  assert.equal(config.name, "consumer-hello");
  assert.equal(config.main, "src.ts");
  assert.ok(config.compatibility_date);
});

test("manifest rejects duplicates, aliases, traversal, invalid IDs and unknown fields", async t => {
  const f = fixture(t);
  f.manifest.workers.push({ ...f.manifest.workers[0] }); f.save();
  assert.throws(() => readConsumerWorkers(f.root), /Duplicate/);
  f.manifest.workers[1].id = "other"; f.save();
  await assert.rejects(prepareConsumerWorkers(f.root), /share a Worker directory/);
  for (const directory of ["../workers/hello", "/tmp", "workers/../workers/hello", "workers\\hello"]) {
    f.manifest.workers = [{ id: "hello", directory }]; f.save();
    assert.throws(() => readConsumerWorkers(f.root), /relative path/);
  }
  for (const id of ["HELLO", "hello_world", "hello--world", "../api"]) {
    f.manifest.workers = [{ id, directory: "workers/hello" }]; f.save();
    assert.throws(() => readConsumerWorkers(f.root), /lowercase id/);
  }
  writeFileSync(join(f.root, "inferos.extensions.json"), JSON.stringify({ ...f.manifest, ambient: true }));
  assert.throws(() => readConsumerWorkers(f.root), /manifest requires/);
});

test("symlinked sources and generated outputs cannot escape the wrapper boundary", async t => {
  const f = fixture(t);
  const outside = fixture(t);
  symlinkSync(outside.dir, join(f.root, "workers/escape"));
  f.manifest.workers = [{ id: "escape", directory: "workers/escape" }]; f.save();
  assert.throws(() => readConsumerWorkers(f.root), /inside the wrapper/);
  f.manifest.workers = [{ id: "hello", directory: "workers/hello" }]; f.save();
  const destination = join(outside.root, "keep.txt"); writeFileSync(destination, "preserve");
  symlinkSync(destination, join(f.dir, "wrangler.consumer.jsonc"));
  await assert.rejects(prepareConsumerWorkers(f.root), /symbolic link/);
  assert.equal(readFileSync(destination, "utf8"), "preserve");
});

test("mismatched canonical names are rejected before generated output is written", async t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, "cloudflare.config.ts"), `import { defineGadgetsWorker } from ${JSON.stringify(factory)};\nexport default defineGadgetsWorker({ name: 'workshop-backend', entrypoint: 'src.ts' });\n`);
  await assert.rejects(prepareConsumerWorkers(f.root), /name must match/);
});
