import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { consumerBlueprintDirectory } from "./runtime.ts";

const upstream = resolve(import.meta.dirname, "../..");

test("empty legacy wrappers retain defaults and linked source roots are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-blueprint-selection-"));
  try {
    assert.equal(consumerBlueprintDirectory(root), undefined);
    mkdirSync(join(root, "blueprints"));
    writeFileSync(join(root, "blueprints/.gitkeep"), "");
    writeFileSync(join(root, "blueprints/README.md"), "Instructions only");
    assert.equal(consumerBlueprintDirectory(root), undefined);
    mkdirSync(join(root, "blueprints/custom"));
    assert.equal(consumerBlueprintDirectory(root), join(root, "blueprints"));
    rmSync(join(root, "blueprints"), { recursive: true });
    symlinkSync(join(upstream, "packages/bundled-blueprints/blueprints"), join(root, "blueprints"), "dir");
    assert.throws(() => consumerBlueprintDirectory(root), /must not be a symbolic link/);
    rmSync(join(root, "blueprints"));
    symlinkSync(join(root, "missing"), join(root, "blueprints"), "dir");
    assert.throws(() => consumerBlueprintDirectory(root), /must not be a symbolic link/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("consumer validation compiles external sources, rereads edits and cleans its scratch output", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-blueprint-build-"));
  const generated = join(upstream, "packages/workshop-backend/src/generated/bundled-blueprints.ts");
  const run = () => spawnSync(process.execPath, ["--input-type=module", "-e",
    `import {validateConsumerBlueprints} from ${JSON.stringify(new URL("./runtime.ts", import.meta.url).href)}; validateConsumerBlueprints(process.argv[1], process.argv[2]);`, root, upstream],
  { encoding: "utf8", env: { ...process.env, BUNDLED_BLUEPRINTS_DIR: "/must-not-use-ambient-source" } });
  try {
    const directory = join(root, "blueprints/consumer-example");
    mkdirSync(join(directory, "files"), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(upstream, "packages/bundled-blueprints/blueprints/workspace-slides/blueprint.json"), "utf8"));
    manifest.blueprintId = "consumer.example";
    manifest.title = "Consumer-owned example";
    writeFileSync(join(directory, "blueprint.json"), JSON.stringify(manifest));
    const client = join(directory, "files/client.ts");
    writeFileSync(client, "document.body.textContent = 'Consumer-owned application';\n");
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Bundled 1 blueprint/);
    const output = /-> (.+)/.exec(first.stdout)?.[1].trim();
    assert.ok(output);
    assert.notEqual(output, generated);
    assert.equal(existsSync(output), false);
    writeFileSync(client, "export const broken = ;\n");
    const broken = run();
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /client.ts/);
    writeFileSync(client, "document.body.textContent = 'Updated application';\n");
    const fixed = run();
    assert.equal(fixed.status, 0, fixed.stderr);
    assert.match(fixed.stdout, /Bundled 1 blueprint/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
