import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readConsumerViews } from "./views.ts";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { bootstrapConsumer } from "./bootstrap.ts";
import { CAPABILITY_NAMES, initialConsumerConfig, migrateConsumerConfig, parseConsumerConfig, resolveConsumerConfig } from "./config.ts";
import { assertLocalPortAvailable, capabilitySources, checkConsumer, diagnoseConsumer, reportCapabilities, unsupportedCapabilities } from "./runtime.ts";
import { checkConsumerSkills } from "./skills.ts";

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
    assert.ok(existsSync(join(target, ".agents/skills/skill-upload/SKILL.md")));
    assert.ok(existsSync(join(target, ".agents/skills/local-coding/SKILL.md")));
    assert.ok(existsSync(join(target, "skills/build/coding-dispatch/SKILL.md")));
    const skills = checkConsumerSkills(target);
    assert.deepEqual(skills.packs.map(pack => pack.id), ["operate", "build", "shared"]);
    assert.ok(skills.packs.every(pack => pack.skills.length > 0));
    assert.deepEqual(skills.warnings, ["build: .agents/skills/skill-creator is not installed; run pnpm skills:install"]);
    assert.ok(JSON.parse(readFileSync(join(target, "package.json"), "utf8")).scripts["skills:upload"]);
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
    assert.deepEqual(report.features, { composableViews: true, durableViews: true, customCloudflareCode: false, inferlabLogin: false });
    assert.equal(report.styling.siteName, "My changed profile");
    assert.equal(report.provenance.features.durableViews, "override");
    assert.ok(report.pending.includes("InferOps fixture/remote adapter"));
    const unsupportedProfile = spawnSync(process.execPath, [join(clone, ".inferos/runtime.ts"), "profile"], { encoding: "utf8" });
    assert.equal(unsupportedProfile.status, 1);
    assert.match(unsupportedProfile.stderr, /does not support profile initialization/);
    assert.equal(JSON.parse(readFileSync(join(clone, "package.json"), "utf8")).scripts.local, "node .inferos/runtime.ts local");
    const unsupportedLocal = spawnSync(process.execPath, [join(clone, ".inferos/runtime.ts"), "local", "status"], { encoding: "utf8" });
    assert.equal(unsupportedLocal.status, 1);
    assert.match(unsupportedLocal.stderr, /does not support the local lifecycle/);
    const diagnostic = await diagnoseConsumer(clone);
    assert.equal(diagnostic.ok, false);
    assert.equal(diagnostic.runtimeReady, false);
    assert.equal(diagnostic.checks.find(check => check.name === "configuration")?.status, "pass");
    assert.equal(diagnostic.checks.find(check => check.name === "runner")?.status, "error");
    assert.equal(diagnostic.checks.find(check => check.name === "dependencies")?.status, "error");
    // This bare pin ships no settings table: reported, never an error of its own.
    assert.equal(diagnostic.checks.find(check => check.name === "settings")?.status, "warning");
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
        else assert.deepEqual(parseConsumerConfig(candidate).features, { ...candidate.features, inferlabLogin: false });
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

test("capability report states enabled, supported and unsupported against the installed source", () => {
  const upstream = mkdtempSync(join(tmpdir(), "inferos-capabilities-"));
  try {
    writeFileSync(join(upstream, "present.ts"), "");
    const sources = { ...capabilitySources, INFEROPS_ENABLED: "present.ts", INFEROPS_AUTH: "present.ts", AGENT_DEPLOYMENTS: "absent.ts" };
    const base = initialConsumerConfig("https://github.com/factory-level/inferos", "a".repeat(40));
    const legacy = resolveConsumerConfig(base);
    assert.deepEqual(reportCapabilities(legacy, upstream, sources).INFEROPS_ENABLED, { state: "supported", requested: false, source: "default" });
    assert.deepEqual(unsupportedCapabilities(legacy.config, upstream, sources), []);
    const resolved = resolveConsumerConfig({ ...base, schemaVersion: 2, capabilities: { INFEROPS_ENABLED: true, AGENT_DEPLOYMENTS: true, HARNESS_HG_ENABLED: false } });
    const report = reportCapabilities(resolved, upstream, sources);
    assert.deepEqual(Object.keys(report), [...CAPABILITY_NAMES]);
    assert.deepEqual(report.INFEROPS_ENABLED, { state: "enabled", requested: true, source: "override" });
    assert.deepEqual(report.INFEROPS_AUTH, { state: "supported", requested: false, source: "default" });
    assert.deepEqual(report.AGENT_DEPLOYMENTS, { state: "unsupported", requested: true, source: "override" });
    assert.deepEqual(report.HARNESS_HG_ENABLED, { state: "unsupported", requested: false, source: "override" });
    assert.deepEqual(unsupportedCapabilities(resolved.config, upstream, sources), ["AGENT_DEPLOYMENTS"]);
    // This revision implements none of the eight, and says so.
    assert.ok(Object.values(reportCapabilities(resolved, upstream)).every(status => status.state === "unsupported"));
    assert.deepEqual(unsupportedCapabilities(resolved.config, upstream), ["INFEROPS_ENABLED", "AGENT_DEPLOYMENTS"]);
  } finally { rmSync(upstream, { recursive: true, force: true }); }
});

test("INFEROPS_ENABLED and CODING_WORKBENCH_ENABLED are supported by this revision; a version 1 wrapper never requests them", () => {
  const repository = join(import.meta.dirname, "../..");
  assert.equal(capabilitySources.INFEROPS_ENABLED, "custom-gatekeepers/gatekeeper-inferops/src/enablement.ts");
  assert.ok(existsSync(join(repository, capabilitySources.INFEROPS_ENABLED!)));
  const base = initialConsumerConfig("https://github.com/factory-level/inferos", "a".repeat(40));
  const legacy = resolveConsumerConfig(base);
  assert.deepEqual(reportCapabilities(legacy, repository).INFEROPS_ENABLED, { state: "supported", requested: false, source: "default" });
  const on = resolveConsumerConfig({ ...base, schemaVersion: 2, capabilities: { INFEROPS_ENABLED: true } });
  assert.deepEqual(reportCapabilities(on, repository).INFEROPS_ENABLED, { state: "enabled", requested: true, source: "override" });
  assert.deepEqual(unsupportedCapabilities(on.config, repository), []);
  const off = resolveConsumerConfig({ ...base, schemaVersion: 2, capabilities: { INFEROPS_ENABLED: false } });
  assert.deepEqual(reportCapabilities(off, repository).INFEROPS_ENABLED, { state: "supported", requested: false, source: "override" });
  // CODING_WORKBENCH_ENABLED is enforced by the gatekeeper's coding switch (#69, #70).
  assert.equal(capabilitySources.CODING_WORKBENCH_ENABLED, "custom-gatekeepers/gatekeeper-inferops/src/coding-workbench.ts");
  assert.ok(existsSync(join(repository, capabilitySources.CODING_WORKBENCH_ENABLED!)));
  const coding = resolveConsumerConfig({ ...base, schemaVersion: 2, capabilities: { INFEROPS_ENABLED: true, CODING_WORKBENCH_ENABLED: true } });
  assert.deepEqual(unsupportedCapabilities(coding.config, repository), []);
  assert.deepEqual(reportCapabilities(coding, repository).CODING_WORKBENCH_ENABLED, { state: "enabled", requested: true, source: "override" });
  // Both publication flags are enforced by the backend's publication records (#68).
  for (const name of ["PUBLISH_CLOUDFLAREOS_WIDGET", "PUBLISH_CLOUDFLAREOS_APP"] as const) {
    assert.equal(capabilitySources[name], "packages/workshop-backend/src/publication.ts");
    assert.ok(existsSync(join(repository, capabilitySources[name]!)));
    const publishing = resolveConsumerConfig({ ...base, schemaVersion: 2, capabilities: { [name]: true } });
    assert.deepEqual(unsupportedCapabilities(publishing.config, repository), []);
    assert.deepEqual(reportCapabilities(legacy, repository)[name], { state: "supported", requested: false, source: "default" });
  }
});

const runtime = (target: string, command: string) => spawnSync(process.execPath, [join(target, ".inferos/runtime.ts"), command], { encoding: "utf8" });
const rewrite = (target: string, edit: (config: Record<string, any>) => unknown) => {
  const path = join(target, "inferos.config.json");
  writeFileSync(path, JSON.stringify(edit(JSON.parse(readFileSync(path, "utf8")))));
};

test("a migrated wrapper checks unchanged, and enabling an uninstalled capability fails every entry point", async () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-migrate-"));
  const source = join(root, "source");
  try {
    execFileSync("git", ["init", "--quiet", source]);
    writeFileSync(join(source, "package.json"), JSON.stringify({ type: "module", packageManager: "pnpm@11.17.0" }));
    mkdirSync(join(source, "packages/bundled-blueprints/blueprints/example/files"), { recursive: true });
    writeFileSync(join(source, "packages/bundled-blueprints/blueprints/example/files/client.js"), "// upstream blueprint\n");
    mkdirSync(join(source, "scripts"));
    writeFileSync(join(source, "scripts/pnpm-command.ts"), "export const pnpmCommand = (args: string[]) => [\"pnpm\", args];\n");
    const commit = () => {
      git(source, "add", ".");
      git(source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
      return git(source, "rev-parse", "HEAD");
    };
    const legacyPin = commit();
    mkdirSync(join(source, "scripts/consumer"));
    writeFileSync(join(source, "scripts/consumer/config.ts"), readFileSync(new URL("./config.ts", import.meta.url)));
    const supportingPin = commit();

    const target = join(root, "consumer");
    bootstrapConsumer(target, source, supportingPin);
    const before = runtime(target, "check");
    assert.equal(before.status, 0);
    const v1 = JSON.parse(before.stdout);
    assert.equal(v1.schemaVersion, 1);
    assert.equal(Object.hasOwn(v1.provenance, "capabilities"), false);
    for (const name of CAPABILITY_NAMES) assert.deepEqual(v1.capabilities[name], { state: "unsupported", requested: false, source: "default" });

    rewrite(target, migrateConsumerConfig);
    const after = runtime(target, "check");
    assert.equal(after.status, 0);
    const v2 = JSON.parse(after.stdout);
    assert.equal(v2.ok, true);
    assert.equal(v2.schemaVersion, 2);
    for (const key of ["revision", "profile", "features", "styling", "pending"]) assert.deepEqual(v2[key], v1[key]);
    assert.deepEqual(v2.provenance.features, v1.provenance.features);
    assert.deepEqual(v2.provenance.styling, v1.provenance.styling);
    for (const name of CAPABILITY_NAMES) assert.deepEqual(v2.capabilities[name], { state: "unsupported", requested: false, source: "override" });
    assert.equal(bootstrapConsumer(target, source, supportingPin).created, false);

    rewrite(target, config => ({ ...config, capabilities: { ...config.capabilities, INFEROPS_ENABLED: true } }));
    const enabled = runtime(target, "check");
    assert.equal(enabled.status, 1);
    assert.match(enabled.stderr, /not supported by this installation: INFEROPS_ENABLED/);
    const refused = JSON.parse(enabled.stdout);
    assert.equal(refused.ok, false);
    assert.deepEqual(refused.capabilities.INFEROPS_ENABLED, { state: "unsupported", requested: true, source: "override" });
    const dev = runtime(target, "dev");
    assert.equal(dev.status, 1);
    assert.match(dev.stderr, /INFEROPS_ENABLED\. No server was started/);
    const doctor = await diagnoseConsumer(target);
    assert.equal(doctor.ok, false);
    assert.match(doctor.checks.find(check => check.name === "runtime")?.message ?? "", /INFEROPS_ENABLED/);
    assert.equal(doctor.checks.find(check => check.name === "runtime")?.status, "error");

    // A pin whose parser predates version 2 cannot read the file, so the wrapper helper refuses it too.
    const older = join(root, "older");
    bootstrapConsumer(older, source, legacyPin);
    assert.equal(runtime(older, "check").status, 0);
    rewrite(older, migrateConsumerConfig);
    const unreadable = runtime(older, "check");
    assert.equal(unreadable.status, 1);
    assert.equal(JSON.parse(unreadable.stdout).ok, false);
    assert.match(unreadable.stderr, /does not support configuration schemaVersion 2/);
    assert.match(runtime(older, "dev").stderr, /schemaVersion 2.*No server was started/);
    assert.match((await diagnoseConsumer(older)).checks.find(check => check.name === "runtime")?.message ?? "", /schemaVersion 2/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** A pin with what a customer shell needs: v2 parsing, the canvas CLI, the InferOps gatekeeper and a stand-in lifecycle operator. */
function customerShellSource(root: string, { gatekeeperCode = true } = {}) {
  const source = join(root, "source");
  const repo = join(import.meta.dirname, "../..");
  const copy = (path: string) => {
    mkdirSync(join(source, path, ".."), { recursive: true });
    writeFileSync(join(source, path), readFileSync(join(repo, path)));
  };
  const write = (path: string, text: string) => {
    mkdirSync(join(source, path, ".."), { recursive: true });
    writeFileSync(join(source, path), text);
  };
  execFileSync("git", ["init", "--quiet", source]);
  write("package.json", JSON.stringify({ type: "module", packageManager: "pnpm@11.17.0" }));
  write("packages/bundled-blueprints/blueprints/example/files/client.js", "// upstream blueprint\n");
  for (const path of ["scripts/consumer/config.ts", "scripts/consumer/runtime.ts", "scripts/consumer/canvas.ts", "scripts/worker-dirs.ts", "scripts/connection-status.ts",
    "packages/workshop-shared/src/canvas.ts", "scripts/relay-termination.ts", "scripts/kill-process-tree.ts"]) copy(path);
  write("custom-gatekeepers/gatekeeper-inferops/wrangler.jsonc", "{}\n");
  write("packages/workshop-backend/src/canvas-store.ts", "export {};\n"); // durableViews' source
  if (gatekeeperCode) for (const path of [capabilitySources.INFEROPS_ENABLED!, capabilitySources.INFEROPS_AUTH!]) write(path, "export {};\n");
  // The real fixture validator needs installed dependencies; start's preflight only needs it to answer.
  write("scripts/consumer/fixtures.ts", "export const checkConsumerFixture = () => ({});\n");
  // Reports how the wrapper invoked it, so the delegation is observable without a stack.
  write("scripts/local/lifecycle.ts", "console.log(JSON.stringify({ argv: process.argv.slice(2), host: process.env.VITE_BACKEND_HOST, cwd: process.cwd() }));\n");
  git(source, "add", ".");
  git(source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  return { source, revision: git(source, "rev-parse", "HEAD") };
}

const runWrapper = (target: string, ...args: string[]) =>
  spawnSync(process.execPath, [join(target, ".inferos/runtime.ts"), ...args], { encoding: "utf8" });

test("a customer shell wrapper is version 2 with the InferOps capabilities on, the gatekeeper selected and edits kept on rerun", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-customer-shell-"));
  try {
    const { source, revision } = customerShellSource(root);
    const target = join(root, "shell");
    const options = { capabilities: ["INFEROPS_ENABLED", "INFEROPS_AUTH"] as const };
    assert.equal(bootstrapConsumer(target, source, revision, options).created, true);

    const written = JSON.parse(readFileSync(join(target, "inferos.config.json"), "utf8"));
    assert.equal(written.schemaVersion, 2);
    assert.equal(written.profile, "inferops-operations");
    assert.deepEqual(written.capabilities, Object.fromEntries(CAPABILITY_NAMES.map(name => [name, name === "INFEROPS_ENABLED" || name === "INFEROPS_AUTH"])));
    const canvas = JSON.parse(readFileSync(join(target, "inferos.canvas.json"), "utf8"));
    assert.deepEqual(canvas.customGatekeepers, ["gatekeeper-inferops"]);
    assert.deepEqual(canvas.screens.map((screen: { id: string }) => screen.id), ["operations"]);
    assert.equal(canvas.screens[0].sections[0].widgets[0].kind, "inferops.project-board");
    assert.equal(canvas.screens[0].sections[0].widgets[0].targetRef, written.inferops.targetRef);

    const check = runWrapper(target, "check");
    assert.equal(check.status, 0, check.stderr);
    const report = JSON.parse(check.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.profile, "inferops-operations");
    for (const name of ["INFEROPS_ENABLED", "INFEROPS_AUTH"]) {
      assert.deepEqual(report.capabilities[name], { state: "enabled", requested: true, source: "override" });
      assert.equal(report.provenance.capabilities[name], "override");
    }
    assert.deepEqual(report.capabilities.CODING_WORKBENCH_ENABLED, { state: "unsupported", requested: false, source: "override" });
    assert.deepEqual(report.features, { composableViews: true, durableViews: true, customCloudflareCode: false, inferlabLogin: false });

    // Customer edits: branding, a capability switched off, and their own screen template.
    rewrite(target, config => ({ ...config, styling: { ...config.styling, siteName: "Acme Ops" }, capabilities: { ...config.capabilities, INFEROPS_AUTH: false } }));
    const editedCanvas = { ...canvas, screens: [{ ...canvas.screens[0], id: "acme", title: "Acme board" }] };
    writeFileSync(join(target, "inferos.canvas.json"), JSON.stringify(editedCanvas));
    const editedConfig = readFileSync(join(target, "inferos.config.json"), "utf8");
    for (const rerun of [options, {}, { profile: "personal" as const }]) {
      assert.equal(bootstrapConsumer(target, source, revision, rerun).created, false);
      assert.equal(readFileSync(join(target, "inferos.config.json"), "utf8"), editedConfig);
      assert.deepEqual(JSON.parse(readFileSync(join(target, "inferos.canvas.json"), "utf8")), editedCanvas);
    }
    const rechecked = JSON.parse(runWrapper(target, "check").stdout);
    assert.equal(rechecked.styling.siteName, "Acme Ops");
    assert.deepEqual(rechecked.capabilities.INFEROPS_AUTH, { state: "supported", requested: false, source: "override" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pnpm local in a wrapper delegates to the pinned operator, serving the wrapper and seeding its first screen", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-wrapper-local-"));
  try {
    const { source, revision } = customerShellSource(root);
    const target = join(root, "shell");
    bootstrapConsumer(target, source, revision, { capabilities: ["INFEROPS_ENABLED"] });
    rewrite(target, config => ({ ...config, local: { port: 9177 } }));
    const local = (...args: string[]) => {
      const result = runWrapper(target, "local", ...args);
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const status = local("status", "--json");
    assert.deepEqual(status.argv, ["status", "--json"]);
    assert.equal(status.host, "localhost:9177");
    assert.equal(realpathSync(status.cwd), realpathSync(join(target, "inferos")));
    assert.deepEqual(local("seed").argv, ["seed", "--screen", "operations"]);
    assert.deepEqual(local("seed", "--screen", "other").argv, ["seed", "--screen", "other"]);
    assert.deepEqual(local("start", "--json", "--", "--use-workers-ai-binding").argv,
      ["start", "--json", "--", "--use-workers-ai-binding", "--consumer-root", target]);
    assert.deepEqual(local("stop").argv, ["stop"]);

    // start runs the same refusals as dev before anything is launched.
    rewrite(target, config => ({ ...config, capabilities: { ...config.capabilities, AGENT_DEPLOYMENTS: true } }));
    const refused = runWrapper(target, "local", "start");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /AGENT_DEPLOYMENTS\. No server was started/);
    assert.equal(refused.stdout, "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bootstrap refuses InferOps capabilities a pin cannot honour and leaves nothing behind", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-customer-shell-unsupported-"));
  try {
    const { source, revision } = customerShellSource(root, { gatekeeperCode: false });
    const target = join(root, "shell");
    assert.throws(() => bootstrapConsumer(target, source, revision, { capabilities: ["INFEROPS_ENABLED"] }),
      /not supported by this installation: INFEROPS_ENABLED/);
    assert.equal(existsSync(target), false);
    assert.throws(() => bootstrapConsumer(target, source, revision, { capabilities: ["NOT_A_CAPABILITY" as never] }), /Unknown capability/);
    // Without capabilities the same pin still produces the version 1 wrapper, with no canvas file written.
    bootstrapConsumer(target, source, revision);
    assert.equal(JSON.parse(readFileSync(join(target, "inferos.config.json"), "utf8")).schemaVersion, 1);
    assert.equal(existsSync(join(target, "inferos.canvas.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
