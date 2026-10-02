import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readConsumerViews } from "./views.ts";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { bootstrapConsumer } from "./bootstrap.ts";
import { initialConsumerConfig, parseConsumerConfig } from "./config.ts";
import { assertLocalPortAvailable, checkConsumer, diagnoseConsumer } from "./runtime.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();

test("port preflight rejects an occupied port without disturbing its listener", async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await assert.rejects(assertLocalPortAvailable(address.port), /choose a different local.port/);
    assert.equal(server.listening, true);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  await assertLocalPortAvailable(address.port);
});

test("bootstrap produces a recursively cloneable pin and preserves consumer edits on rerun", async () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-bootstrap-"));
  const source = join(root, "source with spaces");
  const target = join(root, "consumer with spaces");
  try {
    execFileSync("git", ["init", "--quiet", source]);
    writeFileSync(join(source, "package.json"), JSON.stringify({ type: "module", packageManager: "pnpm@11.17.0" }));
    mkdirSync(join(source, "scripts"));
    writeFileSync(join(source, "scripts/worker-config.ts"), "export const defineGadgetsWorker = (worker: unknown) => worker;\n");
    const blueprintSource = join(source, "packages/bundled-blueprints/blueprints/example/files");
    mkdirSync(blueprintSource, { recursive: true });
    writeFileSync(join(blueprintSource, "client.js"), "// upstream blueprint\n");
    git(source, "add", ".");
    git(source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
    const revision = git(source, "rev-parse", "HEAD");
    assert.equal(bootstrapConsumer(target, source, revision).created, true);
    assert.ok(existsSync(join(target, ".agents/skills/bootstrap-inferos/SKILL.md")));
    const [starter] = readConsumerViews(target);
    assert.equal(starter.sections[0].widgets[0].targetRef, checkConsumer(target).config.inferops.targetRef);
    assert.equal(starter.revision, "0");
    starter.title = "My customized view";
    writeFileSync(join(target, "views/operations.json"), JSON.stringify(starter));
    const customConfig = await import(pathToFileURL(join(target, "workers/hello/cloudflare.config.ts")).href);
    assert.equal(customConfig.default.name, "consumer-hello");
    const customSource = join(target, "workers/hello/src.ts");
    writeFileSync(customSource, "// wrapper-owned worker customization\n");
    const blueprint = join(target, "blueprints/example/files/client.js");
    assert.equal(readFileSync(blueprint, "utf8"), "// upstream blueprint\n");
    writeFileSync(blueprint, "// consumer customization\n");
    const configPath = join(target, "inferos.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.styling.siteName = "My changed profile";
    config.local.port = 9123;
    config.inferops.targetRef = "inferops://demo.local/project/board/OTHER";
    writeFileSync(configPath, JSON.stringify(config));
    assert.equal(bootstrapConsumer(target, source, revision).created, false);
    assert.equal(readFileSync(blueprint, "utf8"), "// consumer customization\n");
    assert.equal(readFileSync(customSource, "utf8"), "// wrapper-owned worker customization\n");
    assert.equal(checkConsumer(target).config.styling.siteName, "My changed profile");
    assert.equal(checkConsumer(target).config.local.port, 9123);
    assert.deepEqual(readConsumerViews(target), [starter]);
    git(target, "add", ".");
    git(target, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "consumer");
    const clone = join(root, "fresh-clone");
    execFileSync("git", ["-c", "protocol.file.allow=always", "clone", "--recurse-submodules", target, clone], { stdio: "pipe" });
    assert.equal(checkConsumer(clone).config.upstream.revision, revision);
    assert.deepEqual(readConsumerViews(clone), [starter]);
    assert.equal(readFileSync(join(clone, "blueprints/example/files/client.js"), "utf8"), "// consumer customization\n");
    assert.equal(readFileSync(join(clone, "workers/hello/src.ts"), "utf8"), "// wrapper-owned worker customization\n");
    const report = JSON.parse(execFileSync(process.execPath, [join(clone, ".inferos/runtime.ts"), "check"], { encoding: "utf8" }));
    assert.equal(report.ok, true);
    assert.equal(report.modifiedUpstream, false);
    assert.deepEqual(report.features, { composableViews: true, durableViews: true, customCloudflareCode: false });
    assert.equal(report.styling.siteName, "My changed profile");
    assert.equal(report.provenance.features.durableViews, "override");
    assert.ok(report.pending.includes("InferOps fixture/remote adapter"));
    const unsupportedProfile = spawnSync(process.execPath, [join(clone, ".inferos/runtime.ts"), "profile"], { encoding: "utf8" });
    assert.equal(unsupportedProfile.status, 1);
    assert.match(unsupportedProfile.stderr, /does not support profile initialization/);
    const diagnostic = await diagnoseConsumer(clone);
    assert.equal(diagnostic.ok, false);
    assert.equal(diagnostic.runtimeReady, false);
    assert.equal(diagnostic.checks.find(check => check.name === "configuration")?.status, "pass");
    assert.equal(diagnostic.checks.find(check => check.name === "runner")?.status, "error");
    assert.equal(diagnostic.checks.find(check => check.name === "dependencies")?.status, "error");
    const enabled = JSON.parse(readFileSync(join(clone, "inferos.config.json"), "utf8"));
    enabled.features.composableViews = true;
    writeFileSync(join(clone, "inferos.config.json"), JSON.stringify(enabled));
    assert.equal((await diagnoseConsumer(clone)).checks.find(check => check.name === "runtime")?.status, "error");
    writeFileSync(join(clone, "inferos/local-experiment.txt"), "not part of the pin");
    assert.equal(checkConsumer(clone).modifiedUpstream, true);

    const mismatch = { ...config, upstream: { ...config.upstream, revision: "a".repeat(40) } };
    writeFileSync(configPath, JSON.stringify(mismatch));
    assert.throws(() => checkConsumer(target), /HEAD differs/);
    const drift = await diagnoseConsumer(target);
    assert.equal(drift.ok, false);
    assert.equal(drift.checks.find(check => check.name === "configuration")?.status, "error");
    const cli = spawnSync(process.execPath, [join(target, ".inferos/runtime.ts"), "doctor"], { encoding: "utf8" });
    assert.equal(cli.status, 1);
    assert.equal(JSON.parse(cli.stdout).ok, false);
    assert.equal(cli.stderr, "");
    assert.throws(() => bootstrapConsumer(target, source, revision), /HEAD differs/);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), mismatch);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bootstrap rejects unknown directories and leaves no destination after Git failure", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-bootstrap-failure-"));
  try {
    writeFileSync(join(root, "keep.txt"), "user content");
    assert.throws(() => bootstrapConsumer(root, "/missing-source", "a".repeat(40)), /not a managed consumer/);
    assert.throws(() => bootstrapConsumer(join(root, "new"), "/missing-source", "a".repeat(40)));
    assert.equal(existsSync(join(root, "new")), false);
    assert.deepEqual(readdirSync(root), ["keep.txt"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("consumer config rejects incompatible flags, unknown inputs and committed credentials", () => {
  const initial = initialConsumerConfig("https://github.com/factory-level/inferos", "a".repeat(40));
  for (const composableViews of [false, true]) {
    for (const durableViews of [false, true]) {
      for (const customCloudflareCode of [false, true]) {
        const candidate = { ...initial, features: { composableViews, durableViews, customCloudflareCode } };
        if (durableViews && !composableViews) assert.throws(() => parseConsumerConfig(candidate), /requires/);
        else assert.deepEqual(parseConsumerConfig(candidate).features, candidate.features);
      }
    }
  }
  assert.throws(() => parseConsumerConfig({ ...initial, token: "secret" }), /expected exactly/);
  assert.throws(() => parseConsumerConfig({ ...initial, local: { port: "8787" } }), /local.port/);
  assert.throws(() => parseConsumerConfig({ ...initial, styling: { ...initial.styling, siteName: "x".repeat(41) } }), /maximum 40/);
  assert.throws(() => parseConsumerConfig({ ...initial, styling: { ...initial.styling, css: "body{}" } }), /expected exactly/);
  assert.throws(() => parseConsumerConfig({ ...initial, inferops: { ...initial.inferops, fixture: "../../secret" } }), /inferops.fixture/);
  for (const baseUrl of ["https://user:secret@example.com", "https://example.com?token=secret", "http://example.com"]) {
    assert.throws(() => parseConsumerConfig({ ...initial, inferops: { mode: "remote", baseUrl, targetRef: initial.inferops.targetRef } }), error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("secret"));
      return /inferops.baseUrl/.test(error.message);
    });
  }
});
