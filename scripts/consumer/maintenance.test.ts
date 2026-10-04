import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { bootstrapConsumer } from "./bootstrap.ts";
import { checkConsumer } from "./runtime.ts";
import { FILES_MANIFEST, WRAPPER_SKILLS } from "./wrapper-files.ts";

const REPO = join(import.meta.dirname, "../..");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
const commit = (cwd: string, message = "change") => {
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", message);
  return git(cwd, "rev-parse", "HEAD");
};
const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const read = (path: string) => readFileSync(path, "utf8");
const wrapper = (target: string, ...args: string[]) => {
  const result = spawnSync(process.execPath, [join(target, ".inferos/runtime.ts"), ...args], { encoding: "utf8" });
  let report: Record<string, any> | null = null;
  try { report = JSON.parse(result.stdout); } catch { report = null; }
  return { status: result.status, report, stderr: result.stderr };
};
const editJson = (path: string, edit: (value: Record<string, any>) => void) => {
  const value = JSON.parse(read(path));
  edit(value);
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
};

/**
 * An InferOS source with two commits. A carries this checkout's real consumer helpers, wrapper skills
 * and a stand-in fixture validator and lifecycle operator. B changes upstream text the way a release
 * does: a skill the customer will edit, one they will not, the runtime helper, the pnpm version, a
 * starter blueprint, and one new wrapper skill.
 */
function inferosSource(root: string) {
  const source = join(root, "source");
  execFileSync("git", ["init", "--quiet", source]);
  write(join(source, "package.json"), JSON.stringify({ type: "module", packageManager: "pnpm@11.17.0" }));
  write(join(source, "packages/bundled-blueprints/blueprints/example/files/client.js"), "// upstream blueprint\n");
  for (const file of ["config.ts", "runtime.ts", "maintenance.ts", "upgrade.ts", "wrapper-files.ts"]) {
    write(join(source, "scripts/consumer", file), read(join(REPO, "scripts/consumer", file)));
  }
  for (const skill of WRAPPER_SKILLS) write(join(source, ".agents/skills", skill, "SKILL.md"), read(join(REPO, ".agents/skills", skill, "SKILL.md")));
  cpSync(join(REPO, "scripts/consumer/skill-packs"), join(source, "scripts/consumer/skill-packs"), { recursive: true });
  // The real validator needs installed dependencies; this one only asks for a projects list.
  write(join(source, "scripts/consumer/fixtures.ts"), `import { readFileSync } from "node:fs";
export const validateBoardFixture = (input: any) => { if (!Array.isArray(input?.projects)) throw new Error("fixture rejected"); return {}; };
export const checkConsumerFixture = (root: string) => validateBoardFixture(JSON.parse(readFileSync(root + "/fixtures/project-board.json", "utf8")));
`);
  write(join(source, "scripts/consumer/project-board.json"), read(join(REPO, "scripts/consumer/project-board.json")));
  // A stopped stack; reset deletes the state directory under the checkout it runs from, like the real one.
  write(join(source, "scripts/local/lifecycle.ts"), `import { rmSync } from "node:fs";
const command = process.argv[2];
if (command === "reset") { rmSync(".wrangler/state", { recursive: true, force: true }); console.log(JSON.stringify({ ok: true, command })); }
else { console.log(JSON.stringify({ ok: false, command, listening: false, error: "Nothing listens" })); process.exitCode = 1; }
`);
  const a = commit(source, "A");
  const append = (path: string, text: string) => writeFileSync(join(source, path), read(join(source, path)) + text);
  append(".agents/skills/bootstrap-inferos/SKILL.md", "\nUpstream B guidance.\n");
  append(".agents/skills/verify-inferos/SKILL.md", "\nUpstream B verify step.\n");
  append("scripts/consumer/runtime.ts", "// upstream B\n");
  write(join(source, "package.json"), JSON.stringify({ type: "module", packageManager: "pnpm@11.18.0" }));
  write(join(source, "packages/bundled-blueprints/blueprints/example/files/client.js"), "// upstream blueprint B\n");
  const files = join(source, "scripts/consumer/wrapper-files.ts");
  writeFileSync(files, read(files).replace(`"recover-inferos"] as const`, `"recover-inferos", "extra-inferos"] as const`));
  write(join(source, ".agents/skills/extra-inferos/SKILL.md"), "---\nname: extra-inferos\ndescription: New in B.\n---\n");
  const b = commit(source, "B");
  return { source, a, b };
}

/** A wrapper at A, committed, as a customer would keep it. */
function committedWrapper(root: string, source: string, revision: string) {
  const target = join(root, "wrapper");
  bootstrapConsumer(target, source, revision);
  commit(target, "bootstrap");
  return target;
}

test("bootstrap records every file it writes with its class and hash", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-files-"));
  try {
    const { source, a } = inferosSource(root);
    const target = committedWrapper(root, source, a);
    const record = JSON.parse(read(join(target, FILES_MANIFEST)));
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.revision, a);
    assert.deepEqual(record.shared, ["inferos"]);
    assert.equal(record.files["package.json"].class, "generated");
    assert.equal(record.files[".inferos/bootstrap.json"].class, "generated");
    for (const path of [".inferos/runtime.ts", ".inferos/maintenance.ts", ".agents/skills/upgrade-inferos/SKILL.md", "README.md", ".gitignore"]) {
      assert.equal(record.files[path].class, "copied-template", path);
    }
    assert.equal(record.files[".inferos/runtime.ts"].source, "scripts/consumer/runtime.ts");
    for (const path of ["inferos.config.json", "views/operations.json", "workers/hello/src.ts", "fixtures/project-board.json"]) {
      assert.equal(record.files[path].class, "customer-owned", path);
    }
    assert.equal(record.files["blueprints/example/files/client.js"].source, "packages/bundled-blueprints/blueprints/example/files/client.js");
    assert.equal(Object.hasOwn(record.files, FILES_MANIFEST), false);
    assert.ok(Object.keys(record.files).every(path => !path.startsWith("inferos/") && !path.startsWith(".git/")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upgrade plans, refuses a dirty tree, then moves the pin keeping every customization", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-upgrade-"));
  try {
    const { source, a, b } = inferosSource(root);
    // The wrapper is created before B exists upstream, so the upgrade has to fetch it.
    git(source, "reset", "-q", "--hard", a);
    const target = committedWrapper(root, source, a);
    git(source, "reset", "-q", "--hard", b);

    // Customize: an InferOS skill, a custom Worker, a setting and a package script of the customer's own.
    const editedSkill = read(join(target, ".agents/skills/bootstrap-inferos/SKILL.md")) + "\nAcme's own rule.\n";
    writeFileSync(join(target, ".agents/skills/bootstrap-inferos/SKILL.md"), editedSkill);
    write(join(target, "workers/acme/src.ts"), "export default { fetch() { return new Response(\"acme\"); } };\n");
    editJson(join(target, "inferos.extensions.json"), value => { value.workers.push({ id: "acme", directory: "workers/acme" }); });
    editJson(join(target, "inferos.config.json"), value => { value.styling.siteName = "Acme Ops"; });
    editJson(join(target, "package.json"), value => { value.scripts["acme:lint"] = "echo acme"; });
    commit(target, "customize");

    const plan = wrapper(target, "upgrade", b);
    assert.equal(plan.status, 0, plan.stderr);
    const report = plan.report!;
    assert.equal(report.mode, "plan");
    assert.deepEqual(report.blockers, []);
    assert.deepEqual([report.from, report.to, report.submodule.relation], [a, b, "forward"]);
    assert.equal(report.config.parses, true);
    assert.equal(report.config.migrate.applicable, true);
    assert.equal(report.baseline, FILES_MANIFEST);
    const action = (path: string) => report.files.find((file: { path: string }) => file.path === path)?.action;
    assert.equal(action("package.json"), "regenerate");
    assert.equal(action(".inferos/runtime.ts"), "update");
    assert.equal(action(".agents/skills/verify-inferos/SKILL.md"), "update");
    assert.equal(action(".agents/skills/extra-inferos/SKILL.md"), "add");
    assert.equal(action(".agents/skills/bootstrap-inferos/SKILL.md"), "needs-review");
    assert.equal(action("blueprints/example/files/client.js"), "upstream-changed");
    assert.equal(action("workers/acme/src.ts"), undefined);
    assert.match(report.state, /not reversible/);
    // A plan writes nothing and leaves the pin alone.
    assert.equal(git(target, "status", "--porcelain"), "");
    assert.equal(git(join(target, "inferos"), "rev-parse", "HEAD"), a);

    writeFileSync(join(target, "scratch.txt"), "uncommitted");
    const dirty = wrapper(target, "upgrade", b, "--apply");
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /uncommitted changes/);
    assert.equal(git(join(target, "inferos"), "rev-parse", "HEAD"), a);
    rmSync(join(target, "scratch.txt"));

    const applied = wrapper(target, "upgrade", b, "--apply");
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(applied.report!.check.ok, true);
    assert.equal(applied.report!.applied.committed, false);
    assert.equal(git(join(target, "inferos"), "rev-parse", "HEAD"), b);
    assert.equal(checkConsumer(target).config.upstream.revision, b);
    assert.equal(JSON.parse(read(join(target, ".inferos/bootstrap.json"))).revision, b);
    // Customizations kept.
    assert.equal(read(join(target, ".agents/skills/bootstrap-inferos/SKILL.md")), editedSkill);
    assert.match(read(join(target, `.inferos/state/upgrade/${b}/.agents/skills/bootstrap-inferos/SKILL.md`)), /Upstream B guidance/);
    assert.ok(existsSync(join(target, "workers/acme/src.ts")));
    assert.equal(JSON.parse(read(join(target, "inferos.extensions.json"))).workers.length, 2);
    assert.equal(checkConsumer(target).config.styling.siteName, "Acme Ops");
    assert.equal(read(join(target, "blueprints/example/files/client.js")), "// upstream blueprint\n");
    // InferOS files refreshed.
    const pkg = JSON.parse(read(join(target, "package.json")));
    assert.equal(pkg.packageManager, "pnpm@11.18.0");
    assert.equal(pkg.scripts["acme:lint"], "echo acme");
    assert.match(read(join(target, ".inferos/runtime.ts")), /upstream B/);
    assert.match(read(join(target, ".agents/skills/verify-inferos/SKILL.md")), /Upstream B verify step/);
    assert.ok(existsSync(join(target, ".agents/skills/extra-inferos/SKILL.md")));
    const record = JSON.parse(read(join(target, FILES_MANIFEST)));
    assert.equal(record.revision, b);
    assert.ok(record.files[".agents/skills/extra-inferos/SKILL.md"]);
    const staged = git(target, "diff", "--cached", "--name-only").split("\n");
    for (const path of ["inferos", "inferos.config.json", "package.json", ".inferos/runtime.ts", FILES_MANIFEST]) assert.ok(staged.includes(path), path);
    commit(target, "upgrade");

    // The edited skill stays needs-review until the customer reconciles it.
    const again = wrapper(target, "upgrade", b);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.report!.submodule.relation, "same");
    assert.deepEqual(again.report!.files.map((file: { path: string; action: string }) => [file.path, file.action]),
      [[".agents/skills/bootstrap-inferos/SKILL.md", "needs-review"], ["blueprints/example/files/client.js", "upstream-changed"]]);

    // The standalone planner refuses to run from a checkout at another revision.
    const elsewhere = spawnSync(process.execPath, [join(REPO, "scripts/consumer/upgrade.ts"), target, a], { encoding: "utf8" });
    assert.equal(elsewhere.status, 1);
    assert.match(elsewhere.stderr, /from an InferOS checkout at/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a wrapper without files.json upgrades conservatively: every differing copied file is needs-review", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-upgrade-legacy-"));
  try {
    const { source, a, b } = inferosSource(root);
    const target = join(root, "wrapper");
    bootstrapConsumer(target, source, a);
    rmSync(join(target, FILES_MANIFEST));
    commit(target, "legacy bootstrap");
    const runtimeBefore = read(join(target, ".inferos/runtime.ts"));

    const plan = wrapper(target, "upgrade", b);
    assert.equal(plan.status, 0, plan.stderr);
    assert.match(plan.report!.baseline, /^missing/);
    const reviews = plan.report!.files.filter((file: { action: string }) => file.action === "needs-review").map((file: { path: string }) => file.path).toSorted();
    assert.deepEqual(reviews, [".agents/skills/bootstrap-inferos/SKILL.md", ".agents/skills/verify-inferos/SKILL.md", ".inferos/runtime.ts"]);
    assert.ok(plan.report!.files.every((file: { action: string; reason?: string }) => file.action !== "needs-review" || /no .inferos\/files.json baseline/.test(file.reason!)));
    // Without a record there is nothing to say about customer-owned starters.
    assert.equal(plan.report!.summary.upstreamChanged, 0);

    const applied = wrapper(target, "upgrade", b, "--apply");
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(read(join(target, ".inferos/runtime.ts")), runtimeBefore);
    assert.equal(git(join(target, "inferos"), "rev-parse", "HEAD"), b);
    const record = JSON.parse(read(join(target, FILES_MANIFEST)));
    assert.equal(record.revision, b);
    // Unreviewed files get no baseline, so the next upgrade still asks for review.
    assert.equal(record.files[".inferos/runtime.ts"], undefined);
    assert.equal(record.files[".agents/skills/extra-inferos/SKILL.md"].class, "copied-template");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verify prints one JSON report with a status and reasons per check", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-verify-"));
  try {
    const { source, a } = inferosSource(root);
    const target = committedWrapper(root, source, a);
    const result = wrapper(target, "verify");
    // This bare pin has no installed dependencies, so doctor fails and verify says why.
    assert.equal(result.status, 1);
    const report = result.report!;
    assert.equal(report.operation, "verify");
    assert.equal(report.revision, a);
    assert.equal(report.live, false);
    assert.deepEqual(report.checks.map((check: { name: string }) => check.name), ["check", "doctor", "local-status", "local-verify"]);
    const status = Object.fromEntries(report.checks.map((check: { name: string; status: string }) => [check.name, check.status]));
    assert.deepEqual(status, { check: "pass", doctor: "fail", "local-status": "skipped", "local-verify": "skipped" });
    assert.deepEqual(report.failures, ["doctor"]);
    const doctor = report.checks.find((check: { name: string }) => check.name === "doctor");
    assert.ok(doctor.reasons.some((reason: string) => reason.startsWith("dependencies:")));
    const live = wrapper(target, "verify", "--live");
    assert.equal(live.report!.checks.find((check: { name: string }) => check.name === "local-status").status, "fail");
    assert.deepEqual(live.report!.failures, ["doctor", "local-status", "local-verify"]);
    assert.equal(wrapper(target, "verify", "--bogus").status, 2);
    // A broken pin still produces a report rather than a stack trace.
    editJson(join(target, "inferos.config.json"), value => { value.upstream.revision = "a".repeat(40); });
    const broken = wrapper(target, "verify");
    assert.equal(broken.status, 1);
    assert.equal(broken.report!.checks[0].status, "fail");
    assert.match(broken.report!.checks[0].reasons[0], /HEAD differs/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recover describes by default and repairs only with --apply, never deleting customer files", async () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-recover-"));
  const server = createServer();
  try {
    const { source, a, b } = inferosSource(root);
    const target = committedWrapper(root, source, a);
    const config = join(target, "inferos.config.json");

    // ports: another process holds local.port; the wrapper moves, the process is left alone.
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const busy = (server.address() as { port: number }).port;
    editJson(config, value => { value.local.port = busy; value.styling.siteName = "Acme Ops"; });
    const ports = wrapper(target, "recover", "ports");
    assert.equal(ports.status, 1);
    assert.equal(ports.report!.mode, "dry-run");
    assert.match(ports.report!.actions[0].description, /never stopped/);
    assert.equal(JSON.parse(read(config)).local.port, busy);
    assert.equal(ports.report!.next, "pnpm inferos recover ports --apply");
    const portsApplied = wrapper(target, "recover", "ports", "--apply");
    assert.equal(portsApplied.status, 0, portsApplied.stderr);
    const moved = JSON.parse(read(config));
    assert.notEqual(moved.local.port, busy);
    assert.equal(moved.styling.siteName, "Acme Ops");
    assert.equal(server.listening, true);

    // config: the submodule checkout drifted, a skill went missing and the README was edited.
    git(join(target, "inferos"), "checkout", "-q", "--detach", b);
    rmSync(join(target, ".agents/skills/verify-inferos/SKILL.md"));
    const readme = read(join(target, "README.md")) + "\nAcme notes.\n";
    writeFileSync(join(target, "README.md"), readme);
    editJson(join(target, "package.json"), value => { delete value.scripts.doctor; value.scripts["acme:lint"] = "echo acme"; });
    const drift = wrapper(target, "recover", "config");
    assert.equal(drift.status, 1);
    assert.ok(drift.report!.findings.some((finding: string) => finding.includes(`checkout is at ${b}`)));
    assert.ok(drift.report!.findings.some((finding: string) => finding.startsWith("README.md") && finding.includes("left as is")));
    assert.equal(git(join(target, "inferos"), "rev-parse", "HEAD"), b);
    assert.equal(existsSync(join(target, ".agents/skills/verify-inferos/SKILL.md")), false);
    const repaired = wrapper(target, "recover", "config", "--apply");
    assert.equal(repaired.status, 0, JSON.stringify(repaired.report) + repaired.stderr);
    assert.equal(git(join(target, "inferos"), "rev-parse", "HEAD"), a);
    assert.ok(existsSync(join(target, ".agents/skills/verify-inferos/SKILL.md")));
    assert.equal(read(join(target, "README.md")), readme);
    const pkg = JSON.parse(read(join(target, "package.json")));
    assert.equal(pkg.scripts.doctor, "node .inferos/runtime.ts doctor");
    assert.equal(pkg.scripts["acme:lint"], "echo acme");
    // A gitlink that disagrees with upstream.revision is a decision, not a repair.
    editJson(config, value => { value.upstream.revision = b; });
    const conflict = wrapper(target, "recover", "config", "--apply");
    assert.equal(conflict.status, 1);
    assert.equal(conflict.report!.actions[0].kind, "manual");
    editJson(config, value => { value.upstream.revision = a; });

    // fixtures: the invalid file is kept beside the restored starter.
    writeFileSync(join(target, "fixtures/project-board.json"), `{"broken": true}\n`);
    const fixture = wrapper(target, "recover", "fixtures");
    assert.equal(fixture.status, 1);
    assert.equal(read(join(target, "fixtures/project-board.json")), `{"broken": true}\n`);
    const restored = wrapper(target, "recover", "fixtures", "--apply");
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(read(join(target, "fixtures/project-board.json")), read(join(REPO, "scripts/consumer/project-board.json")));
    const kept = execFileSync("ls", [join(target, "fixtures")], { encoding: "utf8" }).split("\n").filter(name => name.startsWith("project-board.json.invalid-"));
    assert.equal(kept.length, 1);
    assert.equal(read(join(target, "fixtures", kept[0]!)), `{"broken": true}\n`);
    assert.equal(wrapper(target, "recover", "fixtures").status, 0);

    // state: the rollback limit is stated, and nothing is deleted without --apply.
    write(join(target, "inferos/.wrangler/state/v3/do/data.sqlite"), "local state");
    const state = wrapper(target, "recover", "state");
    assert.equal(state.status, 1);
    assert.match(state.report!.rollback, /reset only, never migrated back/);
    assert.equal(state.report!.actions[0].applied, false);
    assert.ok(existsSync(join(target, "inferos/.wrangler/state")));
    const reset = wrapper(target, "recover", "state", "--apply");
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(existsSync(join(target, "inferos/.wrangler/state")), false);
    assert.equal(wrapper(target, "recover", "everything").status, 2);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
