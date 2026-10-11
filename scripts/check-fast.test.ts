import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  FOOTER, type Group, type Step, type Workspace, changedFiles, expandPaths, packageFor, parseArgs,
  planChecks, report, runGroups, splitTestRun, touchesSettings, workspaceGlobs,
} from "./check-fast.ts";

const BACKEND = {
  dir: "packages/workshop-backend",
  name: "@gadgets/workshop-backend",
  testRun: "node scripts/a.ts && node scripts/b.ts && vitest run && vitest run --config vitest.integration.config.ts",
  hasTests: true,
};
const SHARED = { dir: "packages/workshop-shared", name: "@gadgets/workshop-shared", testRun: "vitest run", hasTests: true };
const NO_TESTS = { dir: "packages/gatekeeper-slack", name: "@gadgets/gatekeeper-slack", hasTests: false };
const NO_SCRIPT = { dir: "packages/gatekeeper-email", name: "@gadgets/gatekeeper-email", hasTests: true };
const BUN = { dir: "assistant-plugins/openai", name: "@gadgets/assistant-plugin-openai", testRun: "bun test src", hasTests: true };

const SCRIPT_TESTS = ["scripts/consumer/settings.test.ts", "scripts/map-concurrent.test.ts", "scripts/vp/concurrency.test.ts"];

const workspace: Workspace = {
  root: "/repo",
  packages: [BACKEND, SHARED, NO_TESTS, NO_SCRIPT, BUN],
  scriptTests: SCRIPT_TESTS,
  exists: file => !file.includes("deleted"),
  bin: (_dir, bin) => ["node", [`/bin/${bin}.mjs`]],
};

const commandLine = (step: Step) => [step.command, ...step.args].join(" ");
const VITEST = "node /bin/vitest.mjs";

describe("workspaceGlobs", () => {
  it("reads only the packages list", () => {
    const yaml = "packages:\n  - packages/*\n  # a comment\n  - 'custom-gatekeepers/*'\n  - scripts\n\n" +
      "catalog:\n  - not-a-package\n";
    assert.deepEqual(workspaceGlobs(yaml), ["packages/*", "custom-gatekeepers/*", "scripts"]);
  });
});

describe("splitTestRun", () => {
  it("separates the codegen prelude from each vitest run's arguments", () => {
    assert.deepEqual(splitTestRun(BACKEND.testRun), {
      prelude: ["node scripts/a.ts", "node scripts/b.ts"],
      vitest: [[], ["--config", "vitest.integration.config.ts"]],
    });
  });

  it("has nothing to run for a missing or non-vitest script", () => {
    assert.deepEqual(splitTestRun(undefined), { prelude: [], vitest: [] });
    assert.deepEqual(splitTestRun("bun test src"), { prelude: [], vitest: [] });
  });
});

describe("packageFor", () => {
  it("matches a whole directory, never a name prefix", () => {
    assert.equal(packageFor("packages/workshop-backend/src/a.ts", workspace.packages), BACKEND);
    assert.equal(packageFor("packages/workshop-backend-extra/a.ts", workspace.packages), undefined);
  });
});

describe("touchesSettings", () => {
  for (const file of ["scripts/consumer/config.ts", "scripts/dev-server-config.ts",
    "packages/workshop-backend/src/env.d.ts", "docs/wiki/configuration-reference.md"]) {
    it(`includes ${file}`, () => assert.equal(touchesSettings(file), true));
  }
  it("leaves unrelated files alone", () => assert.equal(touchesSettings("scripts/vp/run.ts"), false));
});

describe("parseArgs", () => {
  it("defaults to the merge-base with origin/main", () => {
    assert.deepEqual(parseArgs([]), { source: { base: "origin/main" }, dryRun: false, paths: [] });
    assert.deepEqual(parseArgs(["--base=main", "--dry-run"]).source, { base: "main" });
    assert.deepEqual(parseArgs(["--uncommitted"]).source, { uncommitted: true });
  });

  it("rejects a --base with no value instead of checking nothing", () => {
    assert.throws(() => parseArgs(["--base"]), /--base needs a ref/);
    assert.throws(() => parseArgs(["--base", "--dry-run"]), /--base needs a ref/);
    assert.throws(() => parseArgs(["--base="]), /--base needs a ref/);
  });

  it("rejects unknown options and contradictory sources", () => {
    assert.throws(() => parseArgs(["--bsae", "main"]), /unknown option --bsae/);
    assert.throws(() => parseArgs(["--base", "main", "--uncommitted"]), /mutually exclusive/);
    assert.throws(() => parseArgs(["--uncommitted", "a.ts"]), /explicit paths/);
  });
});

describe("planChecks", () => {
  it("relates changed sources and runs changed tests once per config, after the prelude", () => {
    const plan = planChecks(
      ["packages/workshop-backend/src/sharing.ts", "packages/workshop-backend/__tests__/sharing.test.ts"], workspace);
    assert.deepEqual(plan.unchecked, []);
    const [group] = plan.groups;
    assert.equal(group.name, BACKEND.name);
    assert.deepEqual(group.prelude.map(step => step.command), ["node scripts/a.ts", "node scripts/b.ts"]);
    assert.ok(group.prelude.every(step => step.shell && step.cwd === "/repo/packages/workshop-backend"));
    assert.deepEqual(group.testFiles, ["packages/workshop-backend/__tests__/sharing.test.ts"]);
    assert.deepEqual(group.checks.map(commandLine), [
      `${process.execPath} /repo/scripts/vp/run.ts -F @gadgets/workshop-backend --cache build`,
      `${VITEST} related /repo/packages/workshop-backend/src/sharing.ts --run --passWithNoTests`,
      `${VITEST} run __tests__/sharing.test.ts --passWithNoTests`,
      `${VITEST} related /repo/packages/workshop-backend/src/sharing.ts --run --passWithNoTests ` +
        "--config vitest.integration.config.ts",
      `${VITEST} run __tests__/sharing.test.ts --passWithNoTests --config vitest.integration.config.ts`,
    ]);
    assert.ok(group.checks[0].vp);
  });

  it("falls back to the whole config when a source has no related tests (B3)", () => {
    const [group] = planChecks(["packages/workshop-backend/__tests__/fixtures/board.json"], workspace).groups;
    const related = group.checks.filter(step => step.args.includes("related"));
    assert.equal(related.length, 2);
    assert.deepEqual(related.map(step => step.fallback && commandLine(step.fallback)), [
      `${VITEST} run`,
      `${VITEST} run --config vitest.integration.config.ts`,
    ]);
    assert.match(related[0].fallback!.label, /in full: no related tests/);
  });

  it("runs every config in full for a deleted source or a changed config (B1)", () => {
    for (const file of ["packages/workshop-backend/src/deleted.ts", "packages/workshop-backend/vitest.config.ts"]) {
      const [group] = planChecks([file, "packages/workshop-backend/src/kept.ts"], workspace).groups;
      assert.deepEqual(group.checks.slice(1).map(commandLine),
        [`${VITEST} run`, `${VITEST} run --config vitest.integration.config.ts`], file);
      assert.match(group.checks[1].label, /in full/);
    }
  });

  it("lists a deleted test suite rather than dropping it", () => {
    const plan = planChecks(["packages/workshop-shared/src/deleted.test.ts"], workspace);
    assert.deepEqual(plan.unchecked, [
      { file: "packages/workshop-shared/src/deleted.test.ts", reason: "deleted test suite; nothing left to run" },
    ]);
    assert.equal(plan.groups[0].checks.length, 1, "still type-checks the package");
  });

  it("type-checks a package without vitest and says its tests did not run", () => {
    const plan = planChecks(["packages/gatekeeper-slack/src/a.ts", "packages/gatekeeper-email/src/b.ts",
      "assistant-plugins/openai/src/c.ts"], workspace);
    assert.deepEqual(plan.groups.map(group => [group.name, group.prelude.length, group.checks.length]),
      [[BUN.name, 0, 1], [NO_SCRIPT.name, 0, 1], [NO_TESTS.name, 0, 1]]);
    assert.deepEqual(plan.unchecked.map(entry => entry.file),
      ["assistant-plugins/openai/src/c.ts", "packages/gatekeeper-email/src/b.ts"]);
    assert.match(plan.unchecked[1].reason, /no `test:run`/);
  });

  it("runs every scripts suite for any scripts change, plus types:scripts and docs:check", () => {
    const plan = planChecks(["scripts/release/manifest-lib.ts", "docs/wiki/a.md"], workspace);
    assert.deepEqual(plan.groups.map(group => group.name), ["repo"]);
    const [suites, types, docs] = plan.groups[0].checks;
    assert.deepEqual(suites.args, ["--test", ...SCRIPT_TESTS]);
    assert.equal(types.label, "pnpm types:scripts");
    assert.equal(docs.label, "pnpm docs:check");
  });

  it("runs only the settings suite for an env.d.ts change", () => {
    const plan = planChecks(["packages/workshop-backend/src/env.d.ts"], workspace);
    const repo = plan.groups.find(group => group.name === "repo")!;
    assert.deepEqual(repo.checks[0].args, ["--test", "scripts/consumer/settings.test.ts"]);
  });

  it("reports what it cannot check instead of passing it silently", () => {
    const plan = planChecks(["package.json", ".agents/skills/iterate/SKILL.md"], workspace);
    assert.deepEqual(plan.groups, []);
    assert.deepEqual(plan.unchecked.map(entry => entry.file), [".agents/skills/iterate/SKILL.md", "package.json"]);
  });
});

/** A step that prints `output` and exits with `code`. */
const fake = (label: string, output: string, code = 0, extra: Partial<Step> = {}): Step => ({
  label, command: process.execPath, args: ["-e", `console.log(${JSON.stringify(output)}); process.exit(${code})`],
  cwd: tmpdir(), ...extra,
});

describe("runGroups", () => {
  it("runs the whole config when vitest related ran no test file (B3)", async () => {
    const group: Group = { name: "pkg", prelude: [], checks: [
      fake("related", "No test files found, exiting with code 0", 0,
        { fallback: fake("in full", " Test Files  3 passed (3)") }),
    ] };
    const { results, unchecked } = await runGroups([group], 1);
    assert.deepEqual(results.map(result => [result.label, result.status, result.testFiles]),
      [["related", "ok", 0], ["in full", "ok", 3]]);
    assert.deepEqual(unchecked, []);
  });

  it("keeps the related run when it found tests", async () => {
    const group: Group = { name: "pkg", prelude: [], checks: [
      fake("related", " Test Files  1 passed (1)", 0, { fallback: fake("in full", "unexpected", 1) }),
    ] };
    const { results } = await runGroups([group], 1);
    assert.deepEqual(results.map(result => result.label), ["related"]);
  });

  it("lists changed test files that no config ran", async () => {
    const group: Group = { name: "pkg", prelude: [], testFiles: ["pkg/a.test.ts"], checks: [
      fake("unit", "No test files found", 0, { countsTestFiles: true }),
      fake("worker", "No test files found", 0, { countsTestFiles: true }),
    ] };
    const { unchecked } = await runGroups([group], 1);
    assert.deepEqual(unchecked.map(entry => entry.file), ["pkg/a.test.ts"]);
  });

  it("lists a package whose type-check was skipped", async () => {
    const group: Group = { name: "pkg", prelude: [], checks: [
      fake("type-check", 'error: Task "build" not found', 1, { skip: { when: /Task "build" not found/, note: "no build" } }),
    ] };
    const { results, unchecked } = await runGroups([group], 1);
    assert.equal(results[0].status, "skip");
    assert.deepEqual(unchecked, [{ file: "pkg", reason: "no build" }]);
  });
});

describe("report", () => {
  it("prints failures in full, the not-checked list and the footer, and exits non-zero", () => {
    let out = "";
    const code = report([
      { group: "a", label: "type-check", status: "ok", seconds: 1.25, output: "fine" },
      { group: "a", label: "vitest", status: "FAIL", seconds: 2, output: "boom", detail: "1 failed (1)" },
    ], [{ file: "x.json", reason: "why" }], 3, text => { out += text; });
    assert.equal(code, 1);
    assert.match(out, /=== FAIL a: vitest ===\nboom/);
    assert.doesNotMatch(out, /fine/);
    assert.match(out, /ok {4}a: type-check\s+1\.3s/);
    assert.match(out, /NOT CHECKED \(1\):\n {2}x\.json: why/);
    assert.match(out, /1 failed in 3\.0s/);
  });

  it("always ends with the footer, and says plainly when something was not checked", () => {
    let out = "";
    assert.equal(report([], [{ file: "x", reason: "y" }], 1, text => { out += text; }), 0);
    assert.match(out, /passed, but 1 item was not checked/);
    assert.ok(out.trimEnd().endsWith(FOOTER));
    out = "";
    report([], [], 1, text => { out += text; });
    assert.ok(out.trimEnd().endsWith(FOOTER));
  });
});

describe("changedFiles and expandPaths (temporary git repositories)", () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
  const write = (file: string, text = file) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), text);
  };

  before(() => {
    repo = mkdtempSync(join(tmpdir(), "check-fast-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    git("config", "commit.gpgsign", "false");
    for (const file of ["packages/a/src/old.ts", "packages/a/src/gone.ts", "packages/a/src/keep.test.ts",
      "packages/b/src/staged-gone.ts", "packages/c/x.ts"]) write(file);
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  it("lists both sides of a committed rename (B1)", () => {
    git("mv", "packages/a/src/old.ts", "packages/b/src/new.ts");
    git("commit", "-q", "-m", "rename");
    assert.deepEqual(changedFiles(repo, { base: "main" }), ["packages/a/src/old.ts", "packages/b/src/new.ts"]);
  });

  it("keeps staged and unstaged deletions, including a deleted test suite (B1)", () => {
    git("rm", "-q", "packages/b/src/staged-gone.ts");
    unlinkSync(join(repo, "packages/a/src/gone.ts"));
    unlinkSync(join(repo, "packages/a/src/keep.test.ts"));
    write("packages/c/untracked.ts");
    assert.deepEqual(changedFiles(repo, { base: "main" }), [
      "packages/a/src/gone.ts", "packages/a/src/keep.test.ts", "packages/a/src/old.ts",
      "packages/b/src/new.ts", "packages/b/src/staged-gone.ts", "packages/c/untracked.ts",
    ]);
    assert.deepEqual(changedFiles(repo, { uncommitted: true }), [
      "packages/a/src/gone.ts", "packages/a/src/keep.test.ts", "packages/b/src/staged-gone.ts",
      "packages/c/untracked.ts",
    ]);
  });

  it("refuses a base it cannot resolve instead of reporting no changes (B2)", () => {
    assert.throws(() => changedFiles(repo, { base: "origin/nope" }),
      /cannot find the merge-base of origin\/nope and HEAD.*--uncommitted/s);
  });

  it("expands a directory argument to its files, tracked or not, and keeps a missing path", () => {
    assert.deepEqual(expandPaths(repo, ["packages/c", "packages/a/src/gone.ts"], repo),
      ["packages/a/src/gone.ts", "packages/c/untracked.ts", "packages/c/x.ts"]);
    assert.deepEqual(expandPaths(repo, ["c"], join(repo, "packages")), ["packages/c/untracked.ts", "packages/c/x.ts"]);
  });

  it("rejects an empty directory and a path outside the repository", () => {
    mkdirSync(join(repo, "packages/empty"));
    assert.throws(() => expandPaths(repo, ["packages/empty"], repo), /contains no files/);
    assert.throws(() => expandPaths(repo, ["../elsewhere"], repo), /outside the repository/);
  });
});
