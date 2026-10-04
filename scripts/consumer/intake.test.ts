import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { bootstrapConsumer } from "./bootstrap.ts";
import { CAPABILITY_NAMES } from "./config.ts";
import {
  applyIntake, CUSTOMER_VIEW_FILE, INTAKE_MAX_BYTES, MANAGED_RECORD_FILE, parseIntake, readIntakeFile, REPORT_FILES,
  type ExecSeam,
} from "./intake.ts";
import { capabilitySources } from "./runtime.ts";
import { readConsumerViews } from "./views.ts";

const SAMPLE = join(import.meta.dirname, "fixtures/intake/acme-field-ops.json");
const sample = () => JSON.parse(readFileSync(SAMPLE, "utf8"));
const schema = z.fromJSONSchema(JSON.parse(readFileSync(join(import.meta.dirname, "intake.schema.json"), "utf8")));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();

/** A pin with what intake needs: v2 parsing, the canvas CLI, the InferOps gatekeeper, view sources and the intake script itself. */
function intakeSource(root: string) {
  const source = join(root, "source");
  const repo = join(import.meta.dirname, "../..");
  const write = (path: string, text: string | Buffer) => {
    mkdirSync(join(source, path, ".."), { recursive: true });
    writeFileSync(join(source, path), text);
  };
  execFileSync("git", ["init", "--quiet", source]);
  write("package.json", JSON.stringify({ type: "module", packageManager: "pnpm@11.17.0" }));
  write("packages/bundled-blueprints/blueprints/example/files/client.js", "// upstream blueprint\n");
  for (const path of ["scripts/consumer/config.ts", "scripts/consumer/runtime.ts", "scripts/consumer/canvas.ts", "scripts/consumer/intake.ts",
    "scripts/worker-dirs.ts", "scripts/connection-status.ts", "packages/workshop-shared/src/canvas.ts"]) write(path, readFileSync(join(repo, path)));
  write("custom-gatekeepers/gatekeeper-inferops/wrangler.jsonc", "{}\n");
  write("packages/workshop-backend/src/canvas-store.ts", "export {};\n");
  for (const path of [capabilitySources.INFEROPS_ENABLED!, capabilitySources.INFEROPS_AUTH!]) write(path, "export {};\n");
  git(source, "add", ".");
  git(source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  return { source, revision: git(source, "rev-parse", "HEAD") };
}

/** A fresh version 1 wrapper (bootstrapped without capabilities), as most existing customers have. */
function wrapper(root: string, options: Parameters<typeof bootstrapConsumer>[3] = {}) {
  const { source, revision } = intakeSource(root);
  const target = join(root, "acme");
  bootstrapConsumer(target, source, revision, options);
  mkdirSync(join(target, "intake"));
  const intakePath = join(target, "intake/acme.json");
  writeFileSync(intakePath, readFileSync(SAMPLE));
  return { target, intakePath, upstream: join(target, "inferos") };
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const runWrapper = (target: string, ...args: string[]) =>
  spawnSync(process.execPath, [join(target, ".inferos/runtime.ts"), ...args], { cwd: target, encoding: "utf8" });
const neverExec: ExecSeam = () => { throw new Error("exec must not run without --file-issues"); };
const field = (report: ReturnType<typeof applyIntake>, name: string) => report.configuration.changes.find(change => change.field === name)?.action;

test("the synthetic sample validates against the parser and the JSON schema, and is labeled synthetic", () => {
  const intake = parseIntake(sample());
  assert.equal(intake.synthetic, true);
  assert.equal(intake.customer.name, "Acme Field Operations");
  assert.deepEqual(intake.inferops.projects.map(project => [project.key, project.workflow]), [["ENG", "software"], ["OPS", "content"]]);
  assert.equal(schema.safeParse(sample()).success, true);
});

test("malformed and oversized intakes are rejected without echoing the rejected value", () => {
  const secret = "sk-live-DO-NOT-ECHO-1234";
  const cases: [string, (intake: Record<string, any>) => unknown, RegExp][] = [
    ["unknown key", intake => ({ ...intake, token: secret }), /^intake: expected exactly/],
    ["version", intake => ({ ...intake, schemaVersion: 2 }), /^schemaVersion: only version 1/],
    ["project key", intake => { intake.inferops.projects[0].key = secret; return intake; }, /^inferops\.projects\[0\]\.key:/],
    ["tenant", intake => { intake.inferops.tenant = secret; return intake; }, /^inferops\.tenant: expected lowercase slug/],
    ["category", intake => { intake.requirements[0].category = secret; return intake; }, /^requirements\[0\]\.category: expected one of/],
    ["capability", intake => { intake.capabilities = ["kanban", "wiki"]; return intake; }, /requirements\[4\]\.category: requires the local-coding capability/],
    ["control character", intake => { intake.customer.name = `${secret}\u0007`; return intake; }, /^customer\.name: control characters/],
    ["unknown project", intake => { intake.operations[0].project = "NOPE"; return intake; }, /^operations\[0\]\.project: expected a key listed/],
    ["duplicate requirement", intake => { intake.requirements[1].id = intake.requirements[0].id; return intake; }, /^requirements: duplicate entry/],
    ["too many projects", intake => { intake.inferops.projects = Array.from({ length: 13 }, (_, index) => ({ key: `P${index}A`, name: "x", workflow: "software" })); return intake; }, /expected array of 1 to 12/],
  ];
  for (const [name, mutate, message] of cases) {
    const input = mutate(sample());
    assert.throws(() => parseIntake(input), (error: Error) => {
      assert.match(error.message, message, name);
      assert.ok(!error.message.includes(secret), `${name} echoed the value`);
      return true;
    });
  }
  // The JSON schema rejects the same shape errors the parser does.
  assert.equal(schema.safeParse({ ...sample(), token: secret }).success, false);
  assert.equal(schema.safeParse({ ...sample(), schemaVersion: 2 }).success, false);

  const root = mkdtempSync(join(tmpdir(), "inferos-intake-file-"));
  try {
    const big = join(root, "big.json");
    writeFileSync(big, JSON.stringify({ ...sample(), padding: secret.repeat(INTAKE_MAX_BYTES / secret.length + 1) }));
    assert.throws(() => readIntakeFile(big), (error: Error) => /exceeds/.test(error.message) && !error.message.includes(secret));
    const broken = join(root, "broken.json");
    writeFileSync(broken, `{"customer": "${secret}"`);
    assert.throws(() => readIntakeFile(broken), (error: Error) => error.message === "Intake is not valid JSON");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the sample derives a wrapper that passes inferos:check, with a disposition for every requirement", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-intake-apply-"));
  try {
    const { target, intakePath, upstream } = wrapper(root);
    const report = applyIntake(target, intakePath, { upstream, exec: neverExec });

    const config = readJson(join(target, "inferos.config.json"));
    assert.equal(config.schemaVersion, 2);
    assert.equal(config.profile, "inferops-operations");
    assert.deepEqual(config.capabilities, Object.fromEntries(CAPABILITY_NAMES.map(name => [name, name === "INFEROPS_ENABLED" || name === "INFEROPS_AUTH"])));
    assert.equal(report.configuration.migratedFromVersion1, true);
    assert.equal(report.configuration.conflicts.length, 0);

    const canvas = readJson(join(target, "inferos.canvas.json"));
    assert.equal(canvas.screens[0].id, "customer-operations");
    assert.deepEqual(canvas.screens[0].sections.map((section: any) => [section.widgets[0].targetRef, section.widgets[0].params.workflow]), [
      ["inferops://acme.operations/project/board/ENG", "software"],
      ["inferops://acme.operations/project/board/OPS", "content"],
    ]);
    const view = readConsumerViews(target).find(candidate => candidate.id === "customer-operations");
    assert.equal(view?.title, "Acme Field Operations");

    const check = runWrapper(target, "check");
    assert.equal(check.status, 0, check.stderr);
    const checked = JSON.parse(check.stdout);
    assert.equal(checked.ok, true);
    assert.equal(checked.capabilities.INFEROPS_ENABLED.state, "enabled");
    assert.equal(checked.capabilities.INFEROPS_AUTH.state, "enabled");
    assert.equal(checked.capabilities.CODING_WORKBENCH_ENABLED.state, "unsupported");
    assert.equal(checked.capabilities.CODING_WORKBENCH_ENABLED.requested, false);

    const written = readJson(join(target, REPORT_FILES.json));
    assert.deepEqual(written, JSON.parse(JSON.stringify(report)));
    assert.equal(written.deployed, false);
    assert.equal(written.intake.file, "intake/acme.json");
    assert.equal(written.intake.synthetic, true);
    assert.deepEqual(written.requirements.map((requirement: any) => [requirement.id, requirement.disposition, requirement.maps.issue]), [
      ["REQ-01", "supported", null],
      ["REQ-02", "supported", "factory-level/inferos#66"],
      ["REQ-03", "supported", null],
      ["REQ-04", "unsupported", "factory-level/inferos#87"],
      ["REQ-05", "unsupported", "factory-level/inferos#69"],
      ["REQ-06", "custom-work", "factory-level/inferos#36"],
      ["REQ-07", "custom-work", "factory-level/inferos#9"],
      ["REQ-08", "unsupported", "factory-level/inferos#11"],
    ]);
    assert.equal(written.requirements.length, parseIntake(sample()).requirements.length);
    assert.deepEqual(written.requirements[4].maps.capabilities, ["CODING_WORKBENCH_ENABLED"]);
    assert.ok(written.requirements.every((requirement: any) => requirement.reason.length > 0));
    assert.ok(written.requirements.filter((requirement: any) => requirement.disposition === "supported").every((requirement: any) => requirement.configured === true));
    assert.deepEqual(written.pillars.map((pillar: any) => [pillar.id, pillar.status, pillar.tracking]),
      ["field-service", "safety", "dispatch"].map(id => [id, "pending", "factory-level/inferos#87"]));
    assert.equal(written.operations.length, 4);
    assert.deepEqual(written.summary, { requirements: 8, supported: 3, unsupported: 3, customWork: 2, draftedIssues: 5, filedIssues: 0, conflicts: 0 });

    const markdown = readFileSync(join(target, REPORT_FILES.markdown), "utf8");
    assert.match(markdown, /Synthetic intake/);
    for (const id of ["REQ-01", "REQ-08"]) assert.match(markdown, new RegExp(`\\| ${id} \\|`));
    assert.match(markdown, /Not filed\. Rerun with `--file-issues OWNER\/REPO`/);
    assert.ok(existsSync(join(target, MANAGED_RECORD_FILE)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unsupported requirement becomes a drafted issue that is never filed without --file-issues", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-intake-draft-"));
  try {
    const { target, intakePath, upstream } = wrapper(root);
    const report = applyIntake(target, intakePath, { upstream, exec: neverExec });
    const deployment = report.requirements.find(requirement => requirement.id === "REQ-08")!;
    assert.equal(deployment.disposition, "unsupported");
    assert.match(deployment.draft!.title, /^\[synthetic\] Acme Field Operations REQ-08: The environment is deployed/);
    assert.match(deployment.draft!.body, /deployed to Acme's Cloudflare account/);
    assert.match(deployment.draft!.body, /\*\*synthetic\*\* intake/);
    assert.match(deployment.draft!.body, /Related: factory-level\/inferos#11/);
    assert.equal(deployment.filed, null);
    for (const requirement of report.requirements) assert.equal(requirement.draft === null, requirement.disposition === "supported");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("--file-issues files each draft once, through the injected seam only", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-intake-file-issues-"));
  try {
    const { target, intakePath, upstream } = wrapper(root);
    assert.throws(() => applyIntake(target, intakePath, { upstream, fileIssues: "not a repo", exec: neverExec }), /expected OWNER\/REPO/);
    const calls: string[][] = [];
    const exec: ExecSeam = (command, args) => {
      calls.push([command, ...args]);
      return `https://github.example/acme/wrapper/issues/${calls.length}\n`;
    };
    const report = applyIntake(target, intakePath, { upstream, fileIssues: "acme/wrapper", exec });
    assert.equal(calls.length, 5);
    for (const call of calls) assert.deepEqual(call.slice(0, 5), ["gh", "issue", "create", "--repo", "acme/wrapper"]);
    assert.deepEqual(report.requirements.filter(requirement => requirement.filed).map(requirement => requirement.id), ["REQ-04", "REQ-05", "REQ-06", "REQ-07", "REQ-08"]);
    assert.equal(report.summary.filedIssues, 5);
    assert.equal(readJson(join(target, MANAGED_RECORD_FILE)).filedIssues["REQ-08"], "https://github.example/acme/wrapper/issues/5");

    // A rerun reports the filed issues and files nothing again, with or without the flag.
    const again = applyIntake(target, intakePath, { upstream, fileIssues: "acme/wrapper", exec });
    assert.equal(calls.length, 5);
    assert.equal(again.requirements.find(requirement => requirement.id === "REQ-04")?.filed, "https://github.example/acme/wrapper/issues/1");
    assert.equal(applyIntake(target, intakePath, { upstream, exec: neverExec }).summary.filedIssues, 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a rerun keeps customer edits, and a conflicting edit is reported and not overwritten", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-intake-rerun-"));
  try {
    const { target, intakePath, upstream } = wrapper(root);
    applyIntake(target, intakePath, { upstream, exec: neverExec });
    const configPath = join(target, "inferos.config.json");
    const viewPath = join(target, CUSTOMER_VIEW_FILE);

    // Customer edits: an unmanaged field, a managed capability and the managed starter view.
    const config = readJson(configPath);
    config.styling.siteName = "Acme Ops";
    config.local.port = 9321;
    config.capabilities.INFEROPS_AUTH = false;
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const view = readJson(viewPath);
    view.title = "Dispatch wall";
    writeFileSync(viewPath, JSON.stringify(view, null, 2));
    const editedView = readFileSync(viewPath, "utf8");

    const rerun = applyIntake(target, intakePath, { upstream, exec: neverExec });
    const after = readJson(configPath);
    assert.equal(after.styling.siteName, "Acme Ops");
    assert.equal(after.local.port, 9321);
    assert.equal(after.capabilities.INFEROPS_AUTH, false);
    assert.equal(readFileSync(viewPath, "utf8"), editedView);
    assert.equal(field(rerun, "inferos.config.json:/capabilities/INFEROPS_AUTH"), "customized");
    assert.equal(field(rerun, CUSTOMER_VIEW_FILE), "customized");
    assert.equal(field(rerun, "inferos.config.json:/capabilities/INFEROPS_ENABLED"), "unchanged");
    assert.equal(rerun.summary.conflicts, 0);
    // The supported requirement stays supported, and the report says the customer's edit leaves it off.
    assert.equal(rerun.requirements.find(requirement => requirement.id === "REQ-02")?.configured, false);
    assert.equal(runWrapper(target, "check").status, 0);

    // The reviewed intake changes too: a third project. The edited view now conflicts; the untouched screen updates.
    const intake = readJson(intakePath);
    intake.inferops.projects.push({ key: "SAFE", name: "Safety programme", workflow: "content" });
    writeFileSync(intakePath, JSON.stringify(intake, null, 2));
    const changed = applyIntake(target, intakePath, { upstream, exec: neverExec });
    assert.equal(readFileSync(viewPath, "utf8"), editedView);
    assert.equal(field(changed, CUSTOMER_VIEW_FILE), "conflict");
    assert.deepEqual(changed.configuration.conflicts, [CUSTOMER_VIEW_FILE]);
    assert.equal(field(changed, "inferos.canvas.json:/screens[id=customer-operations]"), "set");
    assert.equal(readJson(join(target, "inferos.canvas.json")).screens[0].sections.length, 3);
    assert.match(readFileSync(join(target, REPORT_FILES.markdown), "utf8"), /Conflicts were kept as the customer wrote them/);
    // The conflict persists until resolved; it is never silently absorbed into the record.
    assert.equal(field(applyIntake(target, intakePath, { upstream, exec: neverExec }), CUSTOMER_VIEW_FILE), "conflict");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a value set before the first apply is a conflict, and a failed check rolls every write back", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-intake-first-"));
  try {
    const { target, intakePath, upstream } = wrapper(root, { profile: "personal" });
    const before = readFileSync(join(target, "inferos.config.json"), "utf8");
    assert.throws(() => applyIntake(target, intakePath, { upstream, exec: neverExec, check: () => "stand-in failure" }),
      /inferos:check failed for the derived wrapper, so every write was rolled back: stand-in failure/);
    assert.equal(readFileSync(join(target, "inferos.config.json"), "utf8"), before);
    for (const path of [CUSTOMER_VIEW_FILE, "inferos.canvas.json", MANAGED_RECORD_FILE, REPORT_FILES.json]) assert.equal(existsSync(join(target, path)), false, path);

    const report = applyIntake(target, intakePath, { upstream, exec: neverExec });
    assert.equal(readJson(join(target, "inferos.config.json")).profile, "personal");
    assert.deepEqual(report.configuration.conflicts, ["inferos.config.json:/profile"]);
    // The personal profile leaves views off, so the views requirement is supported but not configured.
    assert.equal(report.requirements.find(requirement => requirement.id === "REQ-03")?.configured, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a draft intake is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-intake-draft-status-"));
  try {
    const { target, intakePath, upstream } = wrapper(root);
    writeFileSync(intakePath, JSON.stringify({ ...sample(), review: { ...sample().review, status: "draft" } }));
    assert.throws(() => applyIntake(target, intakePath, { upstream, exec: neverExec }), /Intake is a draft/);
    assert.equal(readJson(join(target, "inferos.config.json")).schemaVersion, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the wrapper's pnpm inferos intake apply and config migrate run the pinned commands", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-intake-wrapper-"));
  try {
    const { target } = wrapper(root);
    assert.equal(readJson(join(target, "package.json")).scripts.inferos, "node .inferos/runtime.ts");

    const migrated = runWrapper(target, "config", "migrate");
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.deepEqual(JSON.parse(migrated.stdout).migrated, true);
    const config = readJson(join(target, "inferos.config.json"));
    assert.equal(config.schemaVersion, 2);
    // No canvas file and a pin that builds the gatekeeper: the launcher runs it, so the migration keeps it on.
    assert.equal(config.capabilities.INFEROPS_ENABLED, true);
    assert.equal(runWrapper(target, "check").status, 0);
    assert.equal(JSON.parse(runWrapper(target, "config", "migrate").stdout).migrated, false);
    assert.equal(runWrapper(target, "config", "rewrite").status, 1);

    const applied = runWrapper(target, "intake", "apply", "intake/acme.json");
    assert.equal(applied.status, 0, applied.stderr);
    const result = JSON.parse(applied.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.deployed, false);
    assert.equal(result.summary.requirements, 8);
    assert.equal(readJson(join(target, REPORT_FILES.json)).configuration.migratedFromVersion1, false);

    const rejected = runWrapper(target, "intake", "apply", "intake/missing.json");
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Intake file not found/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
