import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { bootstrapConsumer } from "./bootstrap.ts";
import { mergePolicy } from "./reconcile.ts";
import { checkConsumer } from "./runtime.ts";
import { exportBlock, localSecretValues, scanPortable } from "./upgrade-review.ts";
import { dirtyTreeBlocker } from "./upgrade.ts";
import { FILES_MANIFEST, sha256, WRAPPER_LOCKFILE, WRAPPER_SKILLS } from "./wrapper-files.ts";

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
const IDENTITY = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
const wrapper = (target: string, ...args: string[]) => wrapperWith({}, target, ...args);
const wrapperWith = (env: Record<string, string>, target: string, ...args: string[]) => {
  const result = spawnSync(process.execPath, [join(target, ".inferos/runtime.ts"), ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  let report: Record<string, any> | null = null;
  try { report = JSON.parse(result.stdout); } catch { report = null; }
  return { status: result.status, report, stderr: result.stderr };
};
const editJson = (path: string, edit: (value: Record<string, any>) => void) => {
  const value = JSON.parse(read(path));
  edit(value);
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
};

/** A starter blueprint manifest whose title and description sit far enough apart to merge separately. */
const blueprintJson = (description: string) => JSON.stringify({
  title: "Example", blueprintId: "example", output: { id: "example", noun: "Example", plural: "Examples" }, description,
}, null, 2) + "\n";

/**
 * An InferOS source with two commits. A carries this checkout's real consumer helpers, wrapper skills
 * and a stand-in fixture validator, lifecycle operator and gatekeeper. B changes upstream text the way
 * a release does: skills customers edit and ones they do not, a runtime skill pack, the README
 * template, the runtime helper and its capability table, the pnpm version, a starter blueprint's
 * source and manifest, the starter fixture and one new wrapper skill; and, in the gatekeeper, a new
 * write action kind, a Durable Object migration and changed deploy inputs and connection.
 */
function inferosSource(root: string) {
  const source = join(root, "source");
  execFileSync("git", ["init", "--quiet", source]);
  write(join(source, "package.json"), JSON.stringify({ type: "module", packageManager: "pnpm@11.17.0" }));
  write(join(source, ".gitignore"), ".wrangler/\n");
  write(join(source, "packages/bundled-blueprints/blueprints/example/files/client.js"), "// upstream blueprint\n");
  write(join(source, "packages/bundled-blueprints/blueprints/example/blueprint.json"), blueprintJson("An example."));
  for (const file of ["config.ts", "runtime.ts", "maintenance.ts", "upgrade.ts", "wrapper-files.ts", "reconcile.ts", "upgrade-review.ts"]) {
    write(join(source, "scripts/consumer", file), read(join(REPO, "scripts/consumer", file)));
  }
  cpSync(join(REPO, "scripts/consumer/wrapper-templates"), join(source, "scripts/consumer/wrapper-templates"), { recursive: true });
  for (const skill of WRAPPER_SKILLS) write(join(source, ".agents/skills", skill, "SKILL.md"), read(join(REPO, ".agents/skills", skill, "SKILL.md")));
  cpSync(join(REPO, "scripts/consumer/skill-packs"), join(source, "scripts/consumer/skill-packs"), { recursive: true });
  // The real validator needs installed dependencies; this one only asks for a projects list.
  write(join(source, "scripts/consumer/fixtures.ts"), `import { readFileSync } from "node:fs";
export const validateBoardFixture = (input: any) => { if (!Array.isArray(input?.projects)) throw new Error("fixture rejected"); return {}; };
export const checkConsumerFixture = (root: string) => validateBoardFixture(JSON.parse(readFileSync(root + "/fixtures/project-board.json", "utf8")));
`);
  write(join(source, "scripts/consumer/project-board.json"), read(join(REPO, "scripts/consumer/project-board.json")));
  // A stopped stack; reset deletes the state directory under the checkout it runs from, like the real one.
  // FAKE_STATUS replaces status's report; verify leaves a marker so a test can tell it ran.
  write(join(source, "scripts/local/lifecycle.ts"), `import { mkdirSync, rmSync, writeFileSync } from "node:fs";
const command = process.argv[2];
if (command === "reset") { rmSync(".wrangler/state", { recursive: true, force: true }); console.log(JSON.stringify({ ok: true, command })); }
else if (command === "status" && process.env.FAKE_STATUS) { console.log(process.env.FAKE_STATUS); process.exitCode = JSON.parse(process.env.FAKE_STATUS).ok ? 0 : 1; }
else if (command === "verify") { mkdirSync(".wrangler", { recursive: true }); writeFileSync(".wrangler/verified", ""); console.log(JSON.stringify({ ok: true, command })); }
else { console.log(JSON.stringify({ ok: false, command, listening: false, error: "Nothing listens" })); process.exitCode = 1; }
`);
  const gatekeeper = "custom-gatekeepers/gatekeeper-inferops";
  write(join(source, gatekeeper, "src/inferops.ts"), `export const move = { actionKind: { tag: "inferops.issue-transition", label: "Move an issue" } };\n`);
  write(join(source, gatekeeper, "cloudflare.config.ts"), `export const migrations = [\n  { tag: "v0", new_sqlite_classes: ["Board"] },\n];\n`);
  write(join(source, "packages/gatekeeper-github/deploy-inputs.json"), JSON.stringify({ inputs: [{ name: "CLIENT_ID" }] }, null, 2) + "\n");
  const a = commit(source, "A");
  const append = (path: string, text: string) => writeFileSync(join(source, path), read(join(source, path)) + text);
  const replace = (path: string, from: string, to: string) => writeFileSync(join(source, path), read(join(source, path)).replace(from, to));
  append(".agents/skills/bootstrap-inferos/SKILL.md", "\nUpstream B guidance.\n");
  append(".agents/skills/verify-inferos/SKILL.md", "\nUpstream B verify step.\n");
  append(".agents/skills/local-coding/SKILL.md", "\nUpstream B runner note.\n");
  append("scripts/consumer/skill-packs/operate/board-triage/SKILL.md", "\nUpstream B triage step.\n");
  append("scripts/consumer/wrapper-templates/README.md", "\nUpstream B README note.\n");
  append("scripts/consumer/runtime.ts", "// upstream B\n");
  replace("scripts/consumer/runtime.ts", "HARNESS_HG_ENABLED: null,", `HARNESS_HG_ENABLED: "packages/harness/src/index.ts",`);
  replace("scripts/consumer/project-board.json", `"Synthetic operations"`, `"Synthetic operations B"`);
  write(join(source, "package.json"), JSON.stringify({ type: "module", packageManager: "pnpm@11.18.0" }));
  write(join(source, "packages/bundled-blueprints/blueprints/example/files/client.js"), "// upstream blueprint B\n");
  write(join(source, "packages/bundled-blueprints/blueprints/example/blueprint.json"), blueprintJson("An example, revised in B."));
  const files = join(source, "scripts/consumer/wrapper-files.ts");
  writeFileSync(files, read(files).replace(`"recover-inferos"] as const`, `"recover-inferos", "extra-inferos"] as const`));
  write(join(source, ".agents/skills/extra-inferos/SKILL.md"), "---\nname: extra-inferos\ndescription: New in B.\n---\n");
  append(join(gatekeeper, "src/inferops.ts"), `export const remove = { actionKind: { tag: "inferops.issue-delete", label: "Delete an issue" } };\n`);
  replace(join(gatekeeper, "cloudflare.config.ts"), "];", `  { tag: "v1", new_sqlite_classes: ["DeletedIssues"] },\n];`);
  write(join(source, "packages/gatekeeper-github/deploy-inputs.json"), JSON.stringify({ inputs: [{ name: "CLIENT_ID" }, { name: "APP_SLUG" }] }, null, 2) + "\n");
  write(join(source, gatekeeper, "connection.json"), JSON.stringify({ scopes: ["project:read", "project:write"] }, null, 2) + "\n");
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
    assert.equal(record.files["README.md"].source, "scripts/consumer/wrapper-templates/README.md");
    for (const path of ["inferos.config.json", "views/operations.json", "workers/hello/src.ts", "fixtures/project-board.json"]) {
      assert.equal(record.files[path].class, "customer-owned", path);
    }
    assert.equal(record.files["blueprints/example/files/client.js"].source, "packages/bundled-blueprints/blueprints/example/files/client.js");
    assert.equal(Object.hasOwn(record.files, FILES_MANIFEST), false);
    assert.ok(Object.keys(record.files).every(path => !path.startsWith("inferos/") && !path.startsWith(".git/")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** pnpm on PATH, or null: the lockfile test runs the real one when it can. */
const pnpm = (() => {
  const probe = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
  return probe.status === 0 ? "pnpm" : null;
})();

test("a bootstrapped wrapper carries the lockfile pnpm would write, so pnpm leaves its tree clean", { skip: pnpm ? false : "pnpm is not on PATH" }, () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-lockfile-"));
  try {
    const { source, a } = inferosSource(root);
    const target = committedWrapper(root, source, a);
    const record = JSON.parse(read(join(target, FILES_MANIFEST)));
    // The customer's from here on: an upgrade never rewrites it.
    assert.deepEqual(Object.keys(record.files[WRAPPER_LOCKFILE]).toSorted(), ["class", "sha256"]);
    assert.equal(record.files[WRAPPER_LOCKFILE].class, "customer-owned");
    // pnpm verifies (installs) the wrapper's dependencies before every script. Outside the
    // surrounding pnpm run's environment, so it behaves as in a customer's shell.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(npm|pnpm)_/i.test(key)));
    const before = read(join(target, WRAPPER_LOCKFILE));
    const run = spawnSync(pnpm!, ["run", "inferos:check"], { cwd: target, encoding: "utf8", env });
    assert.ok(existsSync(join(target, "node_modules")), run.stderr);
    assert.equal(read(join(target, WRAPPER_LOCKFILE)), before);
    assert.equal(git(target, "status", "--porcelain"), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upgrade names what makes the tree dirty, and says to commit an untracked lockfile", () => {
  assert.equal(dirtyTreeBlocker(" M inferos.config.json\n?? notes.txt\n"),
    "The wrapper has uncommitted changes (inferos.config.json, notes.txt); commit or discard them before --apply");
  const many = Array.from({ length: 12 }, (_, index) => `?? file-${index}`).join("\n");
  assert.match(dirtyTreeBlocker(many), /file-9, and 2 more\)/);
  const root = mkdtempSync(join(tmpdir(), "inferos-dirty-lockfile-"));
  try {
    // A wrapper bootstrapped before the lockfile was: pnpm has since written one, untracked.
    const { source, a, b } = inferosSource(root);
    git(source, "reset", "-q", "--hard", a);
    const target = committedWrapper(root, source, a);
    git(source, "reset", "-q", "--hard", b);
    const lockfile = read(join(target, WRAPPER_LOCKFILE));
    rmSync(join(target, WRAPPER_LOCKFILE));
    commit(target, "an older wrapper");
    writeFileSync(join(target, WRAPPER_LOCKFILE), lockfile);
    const plan = wrapper(target, "upgrade", b);
    assert.equal(plan.report!.ok, false);
    assert.deepEqual(plan.report!.blockers, [`The wrapper has uncommitted changes (${WRAPPER_LOCKFILE}); commit or discard them before --apply; ` +
      `${WRAPPER_LOCKFILE} is the wrapper's lockfile, which pnpm writes before running a script: commit it (git add ${WRAPPER_LOCKFILE} && git commit)`]);
    commit(target, "commit the lockfile");
    assert.deepEqual(wrapper(target, "upgrade", b).report!.blockers, []);
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
    // Both sides appended at the end of the file: a conflict, staged for review only.
    assert.equal(action(".agents/skills/bootstrap-inferos/SKILL.md"), "conflict");
    // Unedited starters take the target's version; the fixture is only reported.
    assert.equal(action("blueprints/example/files/client.js"), "update");
    assert.equal(action("fixtures/project-board.json"), "upstream-changed");
    assert.equal(action("workers/acme/src.ts"), undefined);
    assert.match(report.state, /not reversible/);
    // A plan writes nothing and leaves the pin alone.
    assert.equal(git(target, "status", "--porcelain"), "");
    assert.equal(git(join(target, "inferos"), "rev-parse", "HEAD"), a);

    writeFileSync(join(target, "scratch.txt"), "uncommitted");
    const dirty = wrapper(target, "upgrade", b, "--apply");
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /uncommitted changes \(scratch\.txt\)/);
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
    const conflicted = read(join(target, `.inferos/state/upgrade/${b}/.agents/skills/bootstrap-inferos/SKILL.md`));
    assert.match(conflicted, /Upstream B guidance/);
    assert.match(conflicted, /^<<<<<<< wrapper$/m);
    assert.ok(existsSync(join(target, "workers/acme/src.ts")));
    assert.equal(JSON.parse(read(join(target, "inferos.extensions.json"))).workers.length, 2);
    assert.equal(checkConsumer(target).config.styling.siteName, "Acme Ops");
    assert.equal(read(join(target, "blueprints/example/files/client.js")), "// upstream blueprint B\n");
    assert.doesNotMatch(read(join(target, "fixtures/project-board.json")), /Synthetic operations B/);
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
      [[".agents/skills/bootstrap-inferos/SKILL.md", "conflict"], ["fixtures/project-board.json", "upstream-changed"]]);

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
    assert.deepEqual(reviews, [".agents/skills/bootstrap-inferos/SKILL.md", ".agents/skills/local-coding/SKILL.md", ".agents/skills/verify-inferos/SKILL.md", ".inferos/runtime.ts", "README.md"]);
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

/** Insert a line just after a Markdown file's first heading, far from where upstream appends. */
const afterHeading = (path: string, line: string) => {
  const text = read(path);
  const heading = text.indexOf("\n# ");
  const end = text.indexOf("\n", heading + 1);
  writeFileSync(path, text.slice(0, end + 1) + "\n" + line + "\n" + text.slice(end + 1));
};

test("two differently customized wrappers take the same upgrade: clean merges applied, conflicts staged, customizations kept", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-reconcile-"));
  try {
    const { source, a, b } = inferosSource(root);
    const acme = join(root, "acme");
    const globex = join(root, "globex");
    for (const target of [acme, globex]) { bootstrapConsumer(target, source, a); commit(target, "bootstrap"); }

    // Acme edits the tops of two skills, its SOP and a blueprint manifest, and adds a Worker and a setting.
    afterHeading(join(acme, ".agents/skills/bootstrap-inferos/SKILL.md"), "Acme: always bootstrap with the operations profile.");
    afterHeading(join(acme, "skills/operate/board-triage/SKILL.md"), "Acme: list overdue work first.");
    afterHeading(join(acme, ".agents/skills/local-coding/SKILL.md"), "Acme SOP: run the runner only on the build host.");
    editJson(join(acme, "blueprints/example/blueprint.json"), value => { value.title = "Acme example"; });
    write(join(acme, "workers/acme/src.ts"), "export default { fetch() { return new Response(\"acme\"); } };\n");
    editJson(join(acme, "inferos.config.json"), value => { value.styling.siteName = "Acme Ops"; });
    commit(acme, "acme customizations");
    // Globex appends to the same skill upstream appends to, edits its blueprint code and README, and has its own Worker and density.
    writeFileSync(join(globex, ".agents/skills/bootstrap-inferos/SKILL.md"), read(join(globex, ".agents/skills/bootstrap-inferos/SKILL.md")) + "\nGlobex: never enable custom Workers.\n");
    afterHeading(join(globex, "skills/operate/board-triage/SKILL.md"), "Globex: group by assignee.");
    writeFileSync(join(globex, "blueprints/example/files/client.js"), "// globex blueprint\n");
    writeFileSync(join(globex, "README.md"), "Globex operations wrapper.\n\n" + read(join(globex, "README.md")));
    write(join(globex, "workers/globex/src.ts"), "export default { fetch() { return new Response(\"globex\"); } };\n");
    editJson(join(globex, "inferos.config.json"), value => { value.styling.density = "comfortable"; });
    commit(globex, "globex customizations");
    const before = { acmeRunbook: read(join(acme, ".agents/skills/local-coding/SKILL.md")), globexSkill: read(join(globex, ".agents/skills/bootstrap-inferos/SKILL.md")) };

    const plans = Object.fromEntries([acme, globex].map(target => {
      const plan = wrapper(target, "upgrade", b);
      assert.equal(plan.status, 0, plan.stderr);
      return [target, Object.fromEntries(plan.report!.files.map((file: { path: string; action: string }) => [file.path, file.action]))];
    }));
    assert.equal(plans[acme][".agents/skills/bootstrap-inferos/SKILL.md"], "merge");
    assert.equal(plans[acme]["skills/operate/board-triage/SKILL.md"], "merge");
    assert.equal(plans[acme][".agents/skills/local-coding/SKILL.md"], "merge");
    assert.equal(plans[acme]["blueprints/example/blueprint.json"], "merge");
    assert.equal(plans[acme]["blueprints/example/files/client.js"], "update");
    assert.equal(plans[acme]["README.md"], "update");
    assert.equal(plans[globex][".agents/skills/bootstrap-inferos/SKILL.md"], "conflict");
    assert.equal(plans[globex]["skills/operate/board-triage/SKILL.md"], "merge");
    assert.equal(plans[globex]["blueprints/example/files/client.js"], "conflict");
    assert.equal(plans[globex]["blueprints/example/blueprint.json"], "update");
    assert.equal(plans[globex]["README.md"], "merge");
    assert.equal(plans[globex][".agents/skills/local-coding/SKILL.md"], "update");
    for (const target of [acme, globex]) assert.equal(plans[target]["fixtures/project-board.json"], "upstream-changed");
    // A plan merges in a scratch directory only.
    assert.equal(git(acme, "status", "--porcelain"), "");

    for (const target of [acme, globex]) {
      const applied = wrapper(target, "upgrade", b, "--apply");
      assert.equal(applied.status, 0, applied.stderr);
      assert.equal(git(join(target, "inferos"), "rev-parse", "HEAD"), b);
    }
    // Acme: both sides' text in every merged file.
    const acmeSkill = read(join(acme, ".agents/skills/bootstrap-inferos/SKILL.md"));
    assert.match(acmeSkill, /Acme: always bootstrap/);
    assert.match(acmeSkill, /Upstream B guidance/);
    assert.match(read(join(acme, "skills/operate/board-triage/SKILL.md")), /Acme: list overdue work first\.[\s\S]*Upstream B triage step/);
    const runbook = read(join(acme, ".agents/skills/local-coding/SKILL.md"));
    assert.match(runbook, /Acme SOP/);
    assert.match(runbook, /Upstream B runner note/);
    assert.notEqual(runbook, before.acmeRunbook);
    const manifest = JSON.parse(read(join(acme, "blueprints/example/blueprint.json")));
    assert.deepEqual([manifest.title, manifest.description], ["Acme example", "An example, revised in B."]);
    assert.equal(read(join(acme, "blueprints/example/files/client.js")), "// upstream blueprint B\n");
    assert.ok(existsSync(join(acme, "workers/acme/src.ts")));
    assert.equal(checkConsumer(acme).config.styling.siteName, "Acme Ops");
    // Globex: conflicts leave the customer's file alone; markers only in the ignored state directory.
    assert.equal(read(join(globex, ".agents/skills/bootstrap-inferos/SKILL.md")), before.globexSkill);
    assert.equal(read(join(globex, "blueprints/example/files/client.js")), "// globex blueprint\n");
    const marked = read(join(globex, `.inferos/state/upgrade/${b}/blueprints/example/files/client.js`));
    assert.match(marked, /^<<<<<<< wrapper\n\/\/ globex blueprint\n\|\|\|\|\|\|\| original\n\/\/ upstream blueprint\n=======\n\/\/ upstream blueprint B\n>>>>>>> inferos /);
    for (const path of git(globex, "ls-files").split("\n")) {
      if (existsSync(join(globex, path)) && !path.startsWith("inferos")) assert.doesNotMatch(read(join(globex, path)), /^<<<<<<< /m, path);
    }
    assert.match(read(join(globex, "README.md")), /^Globex operations wrapper\.[\s\S]*Upstream B README note/);
    assert.match(read(join(globex, "skills/operate/board-triage/SKILL.md")), /Globex: group by assignee\.[\s\S]*Upstream B triage step/);
    assert.ok(existsSync(join(globex, "workers/globex/src.ts")));
    assert.equal(checkConsumer(globex).config.styling.density, "comfortable");
    // Merged files are recorded against the target's text, so the next upgrade merges from there.
    const record = JSON.parse(read(join(acme, FILES_MANIFEST)));
    assert.equal(record.files[".agents/skills/local-coding/SKILL.md"].sha256, sha256(read(join(source, ".agents/skills/local-coding/SKILL.md"))));
    const globexRecord = JSON.parse(read(join(globex, FILES_MANIFEST)));
    assert.equal(globexRecord.files["blueprints/example/files/client.js"].sha256, sha256("// upstream blueprint\n"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a reviewed upgrade commits a branch with the review summary, opens a PR, and carries no secrets, grants or state", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-reviewed-"));
  try {
    const { source, a, b } = inferosSource(root);
    const target = committedWrapper(root, source, a);
    const origin = join(root, "origin.git");
    execFileSync("git", ["init", "--quiet", "--bare", origin]);
    git(target, "remote", "add", "origin", origin);
    git(target, "branch", "-M", "main");
    afterHeading(join(target, ".agents/skills/local-coding/SKILL.md"), "Our SOP: tokens live in .dev.vars only.");
    commit(target, "customize");
    // Local secrets and state the upgrade must never carry: ignored files with fake tokens.
    const devToken = "fake-dev-vars-token-7c1d9e2f4a";
    const stateToken = "ghp_" + "f".repeat(36);
    writeFileSync(join(target, ".dev.vars"), `INFEROPS_SERVICE_KEY="${devToken}"\nPORT=8787\n`);
    write(join(target, ".inferos/state/runner/session.json"), JSON.stringify({ token: stateToken, grant: "project/dispatch" }));
    write(join(target, "inferos/.wrangler/state/v3/do/grants.sqlite"), `grant ${stateToken}`);
    assert.equal(git(target, "status", "--porcelain"), "");
    const bin = join(root, "bin");
    const ghArgs = join(root, "gh-args.txt");
    write(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${ghArgs}"\necho https://github.com/globex/wrapper/pull/7\n`);
    execFileSync("chmod", ["+x", join(bin, "gh")]);
    const env = { ...IDENTITY, PATH: `${bin}:${process.env.PATH}` };

    assert.equal(wrapperWith(env, target, "upgrade", b, "--branch", "x").status, 2, "--branch needs --apply");
    assert.equal(wrapperWith(env, target, "upgrade", b, "--apply", "--open-pr", "globex/wrapper").status, 2, "--open-pr needs --branch");
    const result = wrapperWith(env, target, "upgrade", b, "--apply", "--branch", "inferos-upgrade-b", "--open-pr", "globex/wrapper");
    assert.equal(result.status, 0, result.stderr + JSON.stringify(result.report?.reviewed));
    const reviewed = result.report!.reviewed;
    assert.deepEqual([reviewed.branch, reviewed.base, reviewed.committed, reviewed.findings], ["inferos-upgrade-b", "main", true, []]);
    assert.equal(reviewed.pr.url, "https://github.com/globex/wrapper/pull/7");
    const gh = read(ghArgs).split("\n");
    assert.deepEqual(gh.slice(0, 9), ["pr", "create", "-R", "globex/wrapper", "--base", "main", "--head", "inferos-upgrade-b", "--title"]);
    assert.equal(git(origin, "rev-parse", "inferos-upgrade-b"), reviewed.commit);
    assert.equal(git(target, "rev-parse", "--abbrev-ref", "HEAD"), "inferos-upgrade-b");
    assert.equal(git(target, "status", "--porcelain"), "");

    const summary = read(join(target, reviewed.summary));
    assert.equal(reviewed.summary, `.inferos/state/upgrade/${b}/UPGRADE.md`);
    for (const section of ["Code", "Configuration", "Capabilities", "Connections and OAuth", "Data and Durable Object migrations", "Approvals and action kinds", "Reconciliation", "Portability"]) {
      assert.match(summary, new RegExp(`^## ${section}$`, "m"), section);
    }
    assert.match(summary, /^1 commit; /m);
    assert.match(summary, new RegExp(`${b.slice(0, 7)} B`));
    assert.match(summary, /added `HARNESS_HG_ENABLED: "packages\/harness\/src\/index.ts"`/);
    assert.match(summary, /`custom-gatekeepers\/gatekeeper-inferops\/connection.json`|A custom-gatekeepers\/gatekeeper-inferops\/connection.json/);
    assert.match(summary, /packages\/gatekeeper-github\/deploy-inputs.json/);
    assert.match(summary, /new: `\{ tag: "v1", new_sqlite_classes: \["DeletedIssues"\] \}`/);
    // The new write operation is flagged for review, and no existing authority moves with it.
    assert.match(summary, /\*\*new action kind `inferops.issue-delete`: review\*\*/);
    assert.doesNotMatch(summary, /new action kind `inferops.issue-transition`/);
    assert.match(summary, /stores no grants, bindings, approvals or auto-approval rules/);
    assert.match(summary, /\| `.agents\/skills\/local-coding\/SKILL.md` \| copied-template \| merge \|/);
    // The commit carries exactly the upgrade, with the summary as its message.
    assert.equal(git(target, "log", "-1", "--format=%s"), `Upgrade InferOS to ${b.slice(0, 12)}`);
    assert.match(git(target, "log", "-1", "--format=%b"), /## Approvals and action kinds/);
    const changed = git(target, "diff", "--name-only", "main", "inferos-upgrade-b").split("\n");
    assert.ok(changed.includes("inferos") && changed.includes(FILES_MANIFEST));
    assert.ok(changed.every(path => !/^(\.dev\.vars|\.env|\.inferos\/state\/)|\.wrangler\//.test(path)), changed.join(","));
    const diff = execFileSync("git", ["-C", target, "diff", "main", "inferos-upgrade-b"], { encoding: "utf8" });
    for (const secret of [devToken, stateToken, "project/dispatch"]) {
      assert.equal(diff.includes(secret), false);
      assert.equal(git(target, "log", "-1", "--format=%B").includes(secret), false);
    }
    assert.deepEqual(scanPortable(changed, diff, localSecretValues(target)), []);
    // Nothing in the wrapper records a grant or credential, before or after.
    assert.doesNotMatch(read(join(target, "inferos.config.json")), /grant|token|secret/i);

    // A second reviewed upgrade cannot reuse the branch.
    const again = wrapperWith(env, target, "upgrade", b, "--apply", "--branch", "inferos-upgrade-b");
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already exists/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("merge policy, review parsing and the portability scan", () => {
  const text = Buffer.from("text\n");
  assert.equal(mergePolicy("skills/a/SKILL.md", text).kind, "text");
  assert.equal(mergePolicy("blueprints/a/blueprint.json", text).kind, "json");
  assert.equal(mergePolicy(".inferos/runtime.ts", text).kind, "review");
  assert.equal(mergePolicy("fixtures/project-board.json", text).kind, "review");
  assert.equal(mergePolicy("blueprints/a/icon.png", Buffer.from([0x89, 0x50, 0, 1])).kind, "review");
  assert.equal(exportBlock(`export const migrations: X[] = [\n  { tag: "v0" },\n];`, "migrations"), `[\n  { tag: "v0" },\n]`);
  assert.equal(exportBlock("const other = 1;", "migrations"), null);
  const secret = "s3cret-value-from-dev-vars";
  assert.deepEqual(scanPortable(["README.md"], "plain text", [secret]), []);
  assert.deepEqual(scanPortable([".dev.vars", "inferos/.wrangler/state/x", ".inferos/state/runner/a"], "", []).length, 3);
  assert.deepEqual(scanPortable([], `+KEY=${secret}`, [secret]), ["a value from the wrapper's .dev.vars or .env files"]);
  const findings = scanPortable([], "+ token ghp_" + "a".repeat(36) + " and sk-" + "b".repeat(24) + "\n-----BEGIN RSA PRIVATE KEY-----", []);
  assert.deepEqual(findings, ["a private key", "a GitHub token", "an API secret key"].map(item => item.replace(/^an /, "a ")));
  assert.equal(findings.some(finding => finding.includes("ghp_")), false);
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

test("verify never runs live checks against a process this wrapper did not start", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-verify-foreign-"));
  try {
    const { source, a } = inferosSource(root);
    const target = committedWrapper(root, source, a);
    const port = JSON.parse(read(join(target, "inferos.config.json"))).local.port;
    const verified = join(target, "inferos/.wrangler/verified");
    const checksOf = (report: Record<string, any>) => Object.fromEntries(report.checks.map((check: { name: string; status: string; reasons: string[] }) => [check.name, check]));
    // The pin's operator says the listener is someone else's.
    const foreign = JSON.stringify({ ok: false, command: "status", listening: true, stack: "port-in-use-by-other", error: `Port ${port} is in use by a process this checkout did not start` });
    for (const live of [false, true]) {
      const result = wrapperWith({ FAKE_STATUS: foreign }, target, "verify", ...(live ? ["--live"] : []));
      const checks = checksOf(result.report!);
      assert.equal(result.report!.live, false);
      assert.equal(checks["local-status"].status, live ? "fail" : "skipped");
      assert.match(checks["local-status"].reasons[0], /^port-in-use-by-other: Port \d+ is in use/);
      assert.equal(checks["local-verify"].status, live ? "fail" : "skipped");
      assert.match(checks["local-verify"].reasons[0], /did not start/);
      assert.equal(result.report!.checks.length, 4);
    }
    // An older pin reports only `listening`: without this wrapper's dev-server record it is not ours either.
    const legacy = JSON.stringify({ ok: true, command: "status", listening: true });
    const unrecorded = checksOf(wrapperWith({ FAKE_STATUS: legacy }, target, "verify").report!);
    assert.equal(unrecorded["local-status"].status, "skipped");
    assert.match(unrecorded["local-status"].reasons[0], /^port-in-use-by-other/);
    assert.equal(existsSync(verified), false);
    // With a live record for the wrapper's port, the same report is the wrapper's stack and verify runs.
    write(join(target, "inferos/.wrangler/local/dev-server.json"), JSON.stringify({ pid: process.pid, port, mode: "run-local", startedAt: new Date().toISOString() }));
    const recorded = wrapperWith({ FAKE_STATUS: legacy }, target, "verify");
    assert.equal(recorded.report!.live, true);
    assert.equal(checksOf(recorded.report!)["local-verify"].status, "pass");
    assert.equal(existsSync(verified), true);
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
